/**
 * REAL KEYCHAIN LOGIN -> REAL SERVER SESSION -> SURVIVES RELOAD.
 *
 * ★★★ WHY THIS EXISTS (2026-08-09). `qa/harness/session.mjs` authenticates by
 * calling `sealData()` itself and injecting the cookie. That is useful for
 * driving other tests, but it means the entire QA estate has only ever
 * exercised a session it MANUFACTURED. It structurally cannot observe whether
 * the real login flow creates a session at all — and it did not.
 *
 * Five separate fixes were aimed at WHEN the client re-asks `/api/users/me`
 * (refetchOnMount, refetchOnWindowFocus on then off, retry/onError, a logging
 * line, a reverted epoch check). None of them could ever work: for a Hive login
 * the server had never been told anyone signed in, so "signed out" was the
 * honest answer to every re-ask. The defect was one hardcoded argument at the
 * only Hive entry point in the product.
 *
 * This harness therefore refuses to mint anything. Keychain is a browser
 * extension and cannot run headless, so it is replaced by a stub that produces
 * a GENUINE signature: the transaction the app builds is signed in Node with a
 * REAL posting key via beekeeper — the same crypto the extension performs. Every
 * other link in the chain is the real one, including the client-side
 * `verify_authority` call against mainnet, which a fake signature cannot pass.
 *
 * It measures, at the served output:
 *   1. did the login flow reach the server (`POST /api/auth/login`)?
 *   2. did the browser end up holding a `*_session` cookie?
 *   3. does `/api/users/me` — the single authority the whole app believes —
 *      report that user, in the SAME browser context?
 *   4. does it STILL after a full RELOAD (the reported symptom)?
 *   5. and after navigating home (the owner's other reported trigger)?
 *   6. does `/api/feed/for-you` personalise instead of the anonymous fallback?
 *
 * It FAILS on an empty fixture: if the form never rendered or the sign-in never
 * completed, that is a FAIL, never a silent pass over zero checks.
 *
 * Usage:  node qa/harness/real-login-session-proof.mjs
 * Env:    LUMEN_BASE      (default https://localhost:3443)
 *         LOGIN_USERNAME  (default hbd-temp)
 *         LOGIN_WIF       (default: LITE_PUBLISHER_POSTING_WIF from apps/blog/.env.local)
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

/** Read a var out of apps/blog/.env.local — the file `pnpm start` actually loads. */
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
  console.error('FATAL: no signing key. Set LOGIN_WIF or LITE_PUBLISHER_POSTING_WIF in apps/blog/.env.local.');
  process.exit(2);
}

// ---------------------------------------------------------------- real signer
// Keychain cannot run headless. Everything it does is reproduced here with the
// real key, so the signature the app verifies on chain is genuine.
const wax = await import('@hiveio/wax');
const beekeeperFactory = (await import('@hiveio/beekeeper')).default;

const foundation = await wax.createWaxFoundation();
const beekeeper = await beekeeperFactory({
  storageRoot: mkdtempSync(join(tmpdir(), 'lumen-qa-bk-')),
  enableLogs: false
});
const bkSession = beekeeper.createSession('lumen-real-login-proof');
const { wallet } = await bkSession.createWallet(`qa-${process.pid}`, 'qa-password', true);
const publicKey = await wallet.importKey(WIF);

async function signLegacyTx(legacyTx) {
  const tx = foundation.createTransactionFromLegacyJson(
    typeof legacyTx === 'string' ? legacyTx : JSON.stringify(legacyTx)
  );
  return wallet.signDigest(publicKey, tx.legacy_sigDigest);
}

// ---------------------------------------------------------------- assertions
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} — ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });

// The stub must be installed before any page script runs, and must be able to
// call back into Node for the real signature.
await context.exposeFunction('__qaSignLegacyTx', signLegacyTx);
await context.addInitScript(() => {
  window.hive_keychain = {
    requestSignBuffer: (_account, _message, _key, callback) =>
      callback({ success: false, error: 'requestSignBuffer is not used by this flow' }),
    requestSignTx: (_account, tx, _role, callback) => {
      window
        .__qaSignLegacyTx(tx)
        .then((signature) => callback({ success: true, result: { signatures: [signature] } }))
        .catch((error) => callback({ error: String(error && error.message ? error.message : error) }));
    }
  };
});

const page = await context.newPage();
const posted = [];
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes('/api/')) posted.push(new URL(r.url()).pathname);
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`    [browser] ${m.text().slice(0, 180)}`);
});

async function meFrom(p) {
  return p.evaluate(async () => {
    const r = await fetch('/api/users/me', { credentials: 'include' });
    return r.json();
  });
}

let fatal = null;
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // The row is server-rendered, so it is clickable before React has attached the
  // handler — an early click is silently swallowed and the panel never opens.
  // Retry until the panel is actually there rather than assuming one click took.
  const row = page.locator('[data-testid="keychain-row"]');
  const userInput = page.locator('[data-testid="keychain-username"]');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.waitForTimeout(1500);
    await row.click();
    if (await userInput.isVisible().catch(() => false)) break;
    if (attempt === 5) throw new Error('keychain panel never opened after 5 clicks');
  }
  await userInput.waitFor({ state: 'visible', timeout: 15_000 });
  check('login form rendered (fixture is not empty)', true, 'keychain row + username field present');

  await userInput.fill(USERNAME);
  await page.locator('[data-testid="keychain-signin"]').click();

  // Done when the app itself believes it worked. Poll the client's own record
  // rather than a spinner — the server half is exactly what is under test.
  const deadline = Date.now() + 90_000;
  let clientThinksLoggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    try {
      const stored = await page.evaluate(() => window.localStorage.getItem('user'));
      if (stored && stored.includes('"isLoggedIn":true')) {
        clientThinksLoggedIn = true;
        break;
      }
      const err = await page.locator('text=/could not|failed|cancelled/i').count();
      if (err > 0 && Date.now() > deadline - 60_000) break;
    } catch {
      /* navigation in flight */
    }
  }

  check(
    'the sign-in itself completed (client believes it worked)',
    clientThinksLoggedIn,
    clientThinksLoggedIn
      ? `localStorage user = ${USERNAME}`
      : 'sign-in never completed — nothing below would be meaningful'
  );
  if (!clientThinksLoggedIn) throw new Error('sign-in did not complete; refusing to report a pass over zero checks');

  check(
    'login reached the server (POST /api/auth/login)',
    posted.includes('/api/auth/login'),
    posted.length ? `API POSTs seen: ${[...new Set(posted)].join(', ')}` : 'no API POST was made at all'
  );

  const cookies = (await context.cookies()).filter((c) => c.name.endsWith('_session'));
  check(
    'browser holds a *_session cookie',
    cookies.length > 0,
    cookies.length
      ? cookies.map((c) => `${c.name} (secure=${c.secure}, httpOnly=${c.httpOnly})`).join(', ')
      : 'none — the server never issued one'
  );

  const me = await meFrom(page);
  check(
    '/api/users/me reports the signed-in user',
    me.isLoggedIn === true && me.username === USERNAME,
    `isLoggedIn=${me.isLoggedIn} username=${JSON.stringify(me.username)}`
  );

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const afterReload = await meFrom(page);
  check(
    'STILL signed in after a full page RELOAD',
    afterReload.isLoggedIn === true && afterReload.username === USERNAME,
    `isLoggedIn=${afterReload.isLoggedIn} username=${JSON.stringify(afterReload.username)}`
  );

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2500);
  const afterHome = await meFrom(page);
  check(
    'STILL signed in after navigating home',
    afterHome.isLoggedIn === true && afterHome.username === USERNAME,
    `isLoggedIn=${afterHome.isLoggedIn} username=${JSON.stringify(afterHome.username)}`
  );

  const feed = await page.evaluate(async () => {
    const r = await fetch('/api/feed/for-you?limit=5', { credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    return { source: j.source, degraded: j.degraded };
  });
  check(
    'for-you personalises rather than serving the anonymous fallback',
    feed.source !== 'trending-fallback' && feed.degraded !== 'anonymous',
    `source=${feed.source} degraded=${feed.degraded}`
  );
  // ── 7. AND SIGNING OUT MUST STILL WORK. ────────────────────────────────────
  // This changed behaviour: with `authenticateOnBackend` false, `signOut()`
  // returned a logged-out object WITHOUT calling the server, because there was
  // no server session to destroy. Now there is one, so logout must reach
  // `/api/auth/logout` and the cookie must actually die — otherwise the fix
  // above would have traded a login bug for a logout bug.
  const menu = page.locator('[data-testid="profile-avatar-button"]').first();
  if (await menu.count()) {
    await menu.click();
    await page.waitForTimeout(800);
  }
  const logout = page.locator('[data-testid="user-profile-menu-logout-link"]').first();
  if (await logout.count()) {
    await logout.click();
    await page.waitForTimeout(3000);
    const afterLogout = await meFrom(page);
    check(
      'signing out really ends the session server-side',
      afterLogout.isLoggedIn === false,
      `POSTs: ${[...new Set(posted)].join(', ')} · isLoggedIn=${afterLogout.isLoggedIn}`
    );
  } else {
    check('sign-out control was reachable to test', false, 'no logout control found — logout is UNTESTED');
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
