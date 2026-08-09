/**
 * A DEAD HIVE NODE MUST NOT STOP ANYONE SIGNING IN.
 *
 * Fault injection: start the server with a dead node FIRST in the rotation.
 *
 *   HIVE_API_ENDPOINTS=http://127.0.0.1:9,https://api.hive.blog pnpm start
 *
 * Port 9 is discard — nothing listens, so the connection fails immediately and
 * for real. `HIVE_API_ENDPOINTS` has no `REACT_APP_` prefix, so browser bundles
 * cannot see it: the page keeps its normal node and the fault lands only on the
 * server, which is what is being tested.
 *
 * This is the recovery half of the pair. `login-unreachable-chain-proof.mjs`
 * proves we tell the truth when EVERY node is unreachable; this proves we do not
 * bother the reader at all when only the first one is.
 *
 * Asserts the sign-in SUCCEEDS end to end despite the dead primary — measured at
 * the served output, through the same real-signature path as the main proof.
 */
import { chromium } from '@playwright/test';
import { createConnection } from 'node:net';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const BASE = process.env.LUMEN_BASE || 'https://localhost:3443';
const USERNAME = process.env.LOGIN_USERNAME || 'hbd-temp';

function envLocal(name) {
  const text = readFileSync(resolve(REPO, 'apps/blog/.env.local'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

const WIF = process.env.LOGIN_WIF || envLocal('LITE_PUBLISHER_POSTING_WIF');
if (!WIF) {
  console.error('FATAL: no signing key.');
  process.exit(2);
}

const wax = await import('@hiveio/wax');
const beekeeperFactory = (await import('@hiveio/beekeeper')).default;
const foundation = await wax.createWaxFoundation();
const beekeeper = await beekeeperFactory({
  storageRoot: mkdtempSync(join(tmpdir(), 'lumen-qa-bk-')),
  enableLogs: false
});
const bkSession = beekeeper.createSession('lumen-failover-proof');
const { wallet } = await bkSession.createWallet(`qa-${process.pid}`, 'qa-password', true);
const publicKey = await wallet.importKey(WIF);

/**
 * ★ THE FAULT MUST BE PROVEN LIVE BEFORE ANYTHING ELSE IS MEASURED.
 *
 * The first version of this test passed 5/5 without ever touching the dead node:
 * `HIVE_API_ENDPOINTS` set the rotation but not the STARTING endpoint, so the
 * chain came up on the healthy node and sailed through. A green run that never
 * exercised the thing under test is worse than a red one, so the two conditions
 * that make the result meaningful are now assertions:
 *   - the primary really refuses connections, and
 *   - the server really logged a failover.
 */
function isPortDead(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (dead) => { socket.destroy(); resolve(dead); };
    socket.setTimeout(2000);
    socket.on('connect', () => done(false));
    socket.on('error', () => done(true));
    socket.on('timeout', () => done(true));
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} — ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
await context.exposeFunction('__qaSignLegacyTx', async (legacyTx) => {
  const tx = foundation.createTransactionFromLegacyJson(
    typeof legacyTx === 'string' ? legacyTx : JSON.stringify(legacyTx)
  );
  return wallet.signDigest(publicKey, tx.legacy_sigDigest);
});
await context.addInitScript(() => {
  window.hive_keychain = {
    requestSignBuffer: (_a, _m, _k, cb) => cb({ success: false, error: 'unused' }),
    requestSignTx: (_a, tx, _r, cb) => {
      window
        .__qaSignLegacyTx(tx)
        .then((signature) => cb({ success: true, result: { signatures: [signature] } }))
        .catch((error) => cb({ error: String(error?.message ?? error) }));
    }
  };
});

const page = await context.newPage();
let loginStatus = null;
page.on('response', (r) => {
  if (r.url().includes('/api/auth/login')) loginStatus = r.status();
});

let fatal = null;
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const row = page.locator('[data-testid="keychain-row"]');
  const userInput = page.locator('[data-testid="keychain-username"]');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.waitForTimeout(1500);
    await row.click();
    if (await userInput.isVisible().catch(() => false)) break;
    if (attempt === 5) throw new Error('keychain panel never opened');
  }
  check('login form rendered (fixture is not empty)', true, 'keychain row + username field present');

  const primaryDead = await isPortDead('127.0.0.1', 9);
  check(
    'the injected primary node is genuinely dead',
    primaryDead,
    primaryDead ? '127.0.0.1:9 refuses connections' : 'SOMETHING IS LISTENING on 127.0.0.1:9 — the fault is not real'
  );
  if (!primaryDead) throw new Error('fault not injected; a pass here would prove nothing');

  await userInput.fill(USERNAME);
  await page.locator('[data-testid="keychain-signin"]').click();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && loginStatus === null) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);

  check(
    'sign-in succeeded despite the first node being dead',
    loginStatus === 200,
    loginStatus === null ? 'login never answered' : `HTTP ${loginStatus}`
  );

  const cookies = (await context.cookies()).filter((c) => c.name.endsWith('_session'));
  check(
    'a real session cookie was issued',
    cookies.length > 0,
    cookies.length ? cookies.map((c) => c.name).join(', ') : 'none'
  );

  const me = await page.evaluate(async () => {
    const r = await fetch('/api/users/me', { credentials: 'include' });
    return r.json();
  });
  check(
    '/api/users/me reports the signed-in user',
    me.isLoggedIn === true && me.username === USERNAME,
    `isLoggedIn=${me.isLoggedIn} username=${JSON.stringify(me.username)}`
  );

  const body = await page.locator('body').innerText();
  check(
    'the reader was never shown an error',
    !/could not reach hive|did not complete/i.test(body),
    'no failure message on screen'
  );
  // The server's own log is the only place that says a failover happened.
  // Without it a pass could just mean the primary was never used.
  const logPath = process.env.QA_SERVER_LOG;
  if (logPath) {
    const log = readFileSync(logPath, 'utf8');
    check(
      'the server actually failed over (not merely never used the dead node)',
      /failing over to/i.test(log),
      (log.match(/failing over to \S+/i) || ['no "failing over" line in the server log'])[0]
    );
  } else {
    check('server log was available to confirm the failover', false, 'set QA_SERVER_LOG to the server log path');
  }
} catch (err) {
  fatal = err;
} finally {
  await browser.close();
  await beekeeper.delete().catch(() => {});
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length}`);
if (fatal) console.error(`\nFATAL: ${fatal.message}`);
if (results.length === 0) {
  console.error('FATAL: zero checks ran — that is a failure, not a pass.');
  process.exit(1);
}
process.exit(fatal || passed !== results.length ? 1 : 0);
