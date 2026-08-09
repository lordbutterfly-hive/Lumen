/**
 * WHEN HIVE IS UNREACHABLE, SAY SO — DO NOT BLAME THE READER'S ACCOUNT.
 *
 * ★ Why (2026-08-09): sign-in now verifies the signature against the chain, so
 * login genuinely depends on the server reaching a Hive node. That dependency is
 * correct — you cannot check a signature without the chain — but the failure was
 * not: `apiHandler` turns any unrecognised throw into a flat 500 "Internal
 * Server Error", and the login screen rendered that as "That sign-in did not
 * complete", which reads as "your credentials are wrong". Observed live: a
 * login died on `AggregateError [ETIMEDOUT]` from node's connect path while a
 * direct request to the same endpoint answered in 0.375 s.
 *
 * FAULT INJECTION. The server must be started with `HIVE_API_TIMEOUT_MS=1`, so
 * every server-side chain call times out immediately. That variable is a
 * SERVER-ONLY dial: a browser bundle has no such key on `process.env`, so the
 * page keeps its normal 5 s and the client-side `verify_authority` still passes.
 * The fault therefore lands exactly where it is being tested — the login
 * handler — and nowhere else.
 *
 * Asserts:
 *   1. the login POST answered 503, not 500 — `createHttpError` defaults
 *      `expose` to false on every 5xx, so a missing `{expose: true}` silently
 *      turns this back into a 500 with the message stripped;
 *   2. the body carries a message that names the real cause;
 *   3. the reader SEES that, not the generic "sign-in did not complete";
 *   4. and is never told the failure was their account or their key.
 *
 * Usage:
 *   HIVE_API_TIMEOUT_MS=1 pnpm start        # in apps/blog, then:
 *   node qa/harness/login-unreachable-chain-proof.mjs
 */
import { chromium } from '@playwright/test';
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
const bkSession = beekeeper.createSession('lumen-unreachable-proof');
const { wallet } = await bkSession.createWallet(`qa-${process.pid}`, 'qa-password', true);
const publicKey = await wallet.importKey(WIF);

async function signLegacyTx(legacyTx) {
  const tx = foundation.createTransactionFromLegacyJson(
    typeof legacyTx === 'string' ? legacyTx : JSON.stringify(legacyTx)
  );
  return wallet.signDigest(publicKey, tx.legacy_sigDigest);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} — ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
await context.exposeFunction('__qaSignLegacyTx', signLegacyTx);
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
let loginBody = '';
page.on('response', async (r) => {
  if (r.url().includes('/api/auth/login')) {
    loginStatus = r.status();
    loginBody = await r.text().catch(() => '');
  }
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

  await userInput.fill(USERNAME);
  await page.locator('[data-testid="keychain-signin"]').click();

  // Wait for the login POST to come back one way or the other.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && loginStatus === null) await page.waitForTimeout(1000);
  await page.waitForTimeout(2000);

  check(
    'the login request actually reached the server',
    loginStatus !== null,
    loginStatus === null ? 'no /api/auth/login response seen — fault injection may not be active' : `HTTP ${loginStatus}`
  );
  if (loginStatus === null) throw new Error('login never reached the server; nothing below is meaningful');

  check(
    'unreachable chain answers 503, not a flat 500',
    loginStatus === 503,
    `HTTP ${loginStatus}`
  );
  check(
    'the response body names the real cause (not "Internal Server Error")',
    /could not reach hive/i.test(loginBody),
    loginBody.slice(0, 160) || '(empty body)'
  );

  // Read the whole sign-in panel's text rather than guessing at a class name:
  // the assertion is about what a reader can SEE, not which element holds it.
  const onScreen = await page.locator('body').innerText();
  check(
    'the reader is told Hive was unreachable',
    /could not reach hive/i.test(onScreen),
    onScreen.slice(0, 160) || '(no error text on screen)'
  );
  check(
    'the reader is NOT told their sign-in/credentials failed',
    !/did not complete|cancelled/i.test(onScreen),
    onScreen.slice(0, 160) || '(none)'
  );
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
