/**
 * SIGN IN FROM `/login?next=<gated page>` AND LAND THERE — ONCE, NOT IN A LOOP.
 *
 * ★★★ WHY THIS EXISTS (2026-09-19, production incident).
 *
 * Two readers clicked Wallet signed out, were sent to `/login?next=%2Fwallet`,
 * signed in with Keychain — and their tabs span. Measured in the edge access
 * log: 503 and 231 `POST /api/lite/auth/google/challenge` in about three
 * minutes, 334 of them refused 429 by our own rate limiter, ending on the
 * branded 503 card, which only `app/global-error.tsx` can paint. The origin was
 * healthy the whole time: no restart, no 5xx on any document, and `signed=yes`
 * logged for those very requests. One reader posted the screenshot publicly.
 *
 * The cause is not in any of that: it is Next's client-side Router Cache. The
 * `NEXT_REDIRECT` payload `/wallet` returns to a signed-out reader is cached in
 * the tab, nothing invalidated it when the session changed, and the login
 * page's "already signed in, leave the door" effect replayed it — bouncing
 * between two pages that each believed the other was wrong, at frame rate,
 * without asking the origin once. See `features/lite-auth/login/leave-login.ts`
 * for the full reasoning and the fix.
 *
 * ★ WHAT THIS MEASURES, AND WHY IT IS NOT THE 503 COUNTER. A count of Google
 * nonce fetches only means anything when Google sign-in is configured in the
 * environment under test; where it is not, the login form never fetches one and
 * a loop would pass a nonce-counting test in perfect silence. So the load-bearing
 * assertion is the NAVIGATION count, which a loop cannot hide from whatever else
 * is switched on. The nonce count is reported too, because it is what the
 * incident actually burned and what the rate limiter saw.
 *
 * It FAILS on an empty fixture: no rail link, no login form, or a sign-in that
 * never completed is a FAIL, never a silent pass over zero checks.
 *
 * Usage:  node qa/harness/login-next-bounce-proof.mjs
 * Env:    LUMEN_BASE      (default http://127.0.0.1:3012 — the standalone build;
 *                          do NOT point this at `next dev`, whose HMR turns
 *                          client navigations into document loads and would
 *                          dissolve the very cache this test is about)
 *         LOGIN_USERNAME  (default lumenpublisher — must be the account whose
 *                          POSTING key LOGIN_WIF is; checked against chain below)
 *         LOGIN_WIF       (default: LITE_PUBLISHER_POSTING_WIF from apps/blog/.env.local)
 *         NEXT_PATH       (default /wallet — any page that redirects a signed-out
 *                          reader to the door: /profile, /creators/launch, ...)
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const BASE = process.env.LUMEN_BASE || 'http://127.0.0.1:3012';
// ★ lumenpublisher, NOT hbd-temp. `LITE_PUBLISHER_POSTING_WIF` is that
// account's posting key — verified below against the chain rather than assumed,
// because `qa/harness/real-login-session-proof.mjs` still defaults to hbd-temp,
// whose posting authority is a DIFFERENT key, and that harness therefore fails
// at "sign-in did not complete" for anyone who runs it as documented. A key
// that does not match the account produces exactly the symptom this test is
// looking for (a sign-in that never lands), so it has to be ruled out up front.
const USERNAME = process.env.LOGIN_USERNAME || 'lumenpublisher';
const NEXT_PATH = process.env.NEXT_PATH || '/wallet';

/**
 * The cap. A clean sign-in is ONE navigation to the destination (the login page
 * may also settle one intermediate step), so anything past this is the loop.
 * The incident produced hundreds; there is no honest reading of this number
 * that lands between 4 and 100.
 */
const MAX_NAVIGATIONS = 4;
/** `leave-login.ts` allows at most 2 nonce fetches; 3 means the form remounted. */
const MAX_NONCE_FETCHES = 3;
/** How long to sit still and watch after the session flips. */
const WATCH_MS = 15_000;

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
// Keychain is a browser extension and cannot run headless. Everything it does
// is reproduced here with the real key, exactly as
// `qa/harness/real-login-session-proof.mjs` does it, so the signature the app
// verifies on chain is genuine and the server really does mint a session.
const wax = await import('@hiveio/wax');
const beekeeperFactory = (await import('@hiveio/beekeeper')).default;

const foundation = await wax.createWaxFoundation();
const beekeeper = await beekeeperFactory({
  storageRoot: mkdtempSync(join(tmpdir(), 'lumen-qa-bk-')),
  enableLogs: false
});
const bkSession = beekeeper.createSession('lumen-login-bounce-proof');
const { wallet } = await bkSession.createWallet(`qa-${process.pid}`, 'qa-password', true);
const publicKey = await wallet.importKey(WIF);

// ── the key must actually BE this account's posting key ───────────────────────
// Checked before the browser opens. A mismatch fails the sign-in in a way that
// looks identical to the bug under test, and a test that cannot tell its own
// broken fixture from the defect it is hunting is worse than no test.
{
  const nodes = (process.env.HIVE_API_NODES || 'https://rpc.mahdiyari.info,https://api.deathwing.me').split(',');
  let authorities = null;
  for (const node of nodes) {
    try {
      const res = await fetch(node.trim(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[USERNAME]], id: 1 })
      });
      const body = await res.json();
      const account = body?.result?.[0];
      if (account) {
        authorities = (account.posting?.key_auths || []).map(([k]) => k);
        break;
      }
    } catch {
      /* try the next node */
    }
  }
  if (!authorities) {
    console.error(`FATAL: could not read @${USERNAME} from any Hive node, so the signing key cannot be checked.`);
    process.exit(2);
  }
  if (!authorities.includes(publicKey)) {
    console.error(
      `FATAL: LOGIN_WIF derives ${publicKey}, which is NOT a posting key of @${USERNAME} ` +
        `(on chain: ${authorities.join(', ')}). Set LOGIN_USERNAME to the account this key belongs to.`
    );
    process.exit(2);
  }
  console.log(`      signing key checked: ${publicKey} is a posting authority of @${USERNAME}`);
}

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
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(62)} — ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });

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

/** Every URL this tab has been on, in order. The loop's fingerprint. */
const navigations = [];
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations.push(new URL(frame.url()).pathname + new URL(frame.url()).search);
});
const nonceFetches = [];
const originHitsForNext = [];
page.on('request', (r) => {
  const u = new URL(r.url());
  if (r.method() === 'POST' && u.pathname === '/api/lite/auth/google/challenge') nonceFetches.push(Date.now());
  if (u.pathname === NEXT_PATH) originHitsForNext.push(Date.now());
});

let fatal = null;
try {
  // ── 1. Seed the Router Cache exactly the way a reader does. ────────────────
  // NOT `page.goto(NEXT_PATH)`: a document load populates nothing. The whole
  // bug lives in the CLIENT-side cache, so the entry has to be created by a
  // client-side navigation from a rendered page — a click on the rail row,
  // which is what both readers in the incident did.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const railLink = page.locator(`a[href="${NEXT_PATH}"]`).first();
  await railLink.waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(2500); // let React attach; an early click is swallowed
  // ★★★ AND PROVE THE SEED TOOK. Everything below is meaningless unless that
  // click was a CLIENT-SIDE navigation: a document load populates no Router
  // Cache, the redirect happens server-side, and the bug cannot reproduce — so
  // an UNFIXED build would sail through every check that follows. The only
  // thing making the click client-side is React having attached by then, which
  // is a race on a cold server. A marker on `window` survives a same-document
  // navigation and dies in a document load, so it answers the question exactly.
  await page.evaluate(() => {
    window.__qaSameDocument = true;
  });
  await railLink.click();
  await page.waitForURL(/\/login\?/, { timeout: 30_000 });
  const seededUrl = new URL(page.url());
  check(
    'signed out, the rail row sends the reader to the door carrying ?next=',
    seededUrl.pathname === '/login' && seededUrl.searchParams.get('next') === NEXT_PATH,
    `landed on ${seededUrl.pathname}${seededUrl.search}`
  );
  const sameDocument = await page.evaluate(() => window.__qaSameDocument === true);
  check(
    'that click was a CLIENT-side navigation, so the Router Cache really is seeded',
    sameDocument,
    sameDocument
      ? 'window marker survived — the redirect payload is cached in this tab'
      : 'window marker was lost: the click became a document load, so the bug under test was never armed and every check below would pass on a broken build'
  );
  if (!sameDocument) throw new Error('fixture not armed; refusing to report a pass over a test that cannot fail');

  // ── 2. Sign in, for real, from that page. ─────────────────────────────────
  const row = page.locator('[data-testid="keychain-row"]');
  const userInput = page.locator('[data-testid="keychain-username"]');
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.waitForTimeout(1500);
    await row.click();
    if (await userInput.isVisible().catch(() => false)) break;
    if (attempt === 5) throw new Error('keychain panel never opened after 5 clicks');
  }
  await userInput.fill(USERNAME);

  const navsBefore = navigations.length;
  const noncesBefore = nonceFetches.length;
  const originHitsBefore = originHitsForNext.length;
  // Is Google sign-in configured HERE? Without it the login form never fetches
  // a nonce, and a nonce count of zero would mean nothing at all.
  const googleConfigured = await page.evaluate(
    () => typeof window.__ENV === 'object' && !!window.__ENV && !!window.__ENV.REACT_APP_LITE_GOOGLE_CLIENT_ID
  );
  await page.locator('[data-testid="keychain-signin"]').click();

  // Wait until the client believes it is signed in, then keep watching. The
  // loop starts at the moment the session flips, so the window has to stay open
  // well past it rather than stopping at the first sign of success.
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
    } catch {
      /* navigation in flight — expected, that is the thing under test */
    }
  }
  check(
    'the sign-in itself completed (client believes it worked)',
    clientThinksLoggedIn,
    clientThinksLoggedIn ? `localStorage user = ${USERNAME}` : 'sign-in never completed — nothing below is meaningful'
  );
  if (!clientThinksLoggedIn) throw new Error('sign-in did not complete; refusing to report a pass over zero checks');

  await page.waitForTimeout(WATCH_MS);

  // ── 3. The measurements. ──────────────────────────────────────────────────
  const navs = navigations.length - navsBefore;
  const nonces = nonceFetches.length - noncesBefore;
  const trail = navigations.slice(navsBefore).slice(0, 12).join(' -> ');

  check(
    `signing in causes at most ${MAX_NAVIGATIONS} navigations, not a bounce loop`,
    navs <= MAX_NAVIGATIONS,
    `${navs} navigation(s) in ${WATCH_MS / 1000}s · ${trail}${navs > 12 ? ' -> ...' : ''}`
  );
  if (googleConfigured) {
    check(
      `the login form is not remounted in a loop (<= ${MAX_NONCE_FETCHES} Google nonce fetches)`,
      nonces <= MAX_NONCE_FETCHES,
      `${nonces} POST /api/lite/auth/google/challenge`
    );
  } else {
    // NOT counted as a pass. A vacuous green is how a test starts lying.
    console.log(
      `SKIP  the Google nonce count                                       — REACT_APP_LITE_GOOGLE_CLIENT_ID is not set on ${BASE}, so the form never fetches a nonce and this number would prove nothing`
    );
  }

  // ★ THE INCIDENT'S SHARPEST FINGERPRINT, ASSERTED RATHER THAN COLLECTED. What
  // identified the mechanism was that 35 seconds of looping produced ZERO
  // requests for the destination: every iteration was answered from the client
  // Router Cache and the origin never heard about it. The fix is a document
  // load, so the opposite must now be true — the destination is really fetched.
  const originHits = originHitsForNext.length - originHitsBefore;
  check(
    `${NEXT_PATH} is fetched from the ORIGIN after the sign-in, not replayed from the cache`,
    originHits >= 1,
    `${originHits} request(s) for ${NEXT_PATH} reached the server`
  );

  const finalUrl = new URL(page.url());
  check(
    `the reader lands on ${NEXT_PATH}, which is what ?next= promised`,
    finalUrl.pathname === NEXT_PATH,
    `final URL ${finalUrl.pathname}${finalUrl.search}`
  );

  const me = await page.evaluate(async () => {
    const r = await fetch('/api/users/me', { credentials: 'include' });
    return r.json();
  });
  check(
    'and is signed in there, server-side',
    me.isLoggedIn === true && me.username === USERNAME,
    `isLoggedIn=${me.isLoggedIn} username=${JSON.stringify(me.username)}`
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
