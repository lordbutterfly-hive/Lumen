// Drives /upgrade in a REAL browser to show that the account keys are generated in the
// page and that nothing secret crosses the network.
//
//   node scripts/lite-upgrade-browser-keys.mjs        (needs the dev server on :3000)
//
// ⚠ INCOMPLETE — READ THIS BEFORE TRUSTING A PASS OR A FAIL.
// The first assertion (the server-rendered page carries nothing key-shaped) runs and is
// real. The browser half does NOT currently reach the key screen: the app seeds its
// client-side user from localStorage as react-query `initialData` and never refetches
// (use-user-core.ts), so injecting a session cookie is not enough to look signed in —
// and a hand-written localStorage user puts the app into a navigation loop. Signing in
// for real means driving the wallet dialog, which needs a browser wallet or test ids on
// that dialog's manual-paste fields (it has neither today).
//
// Until then the in-browser property is covered by: the generator shipping in
// /upgrade's client chunk, the server having no key generation at all
// (lite-upgrade-e2e.ts, lite-account-creator-e2e.ts), and the server HTML check below.
//
// It signs up a keyless BTC account over the API, drives /upgrade in Chromium up to
// the key screen, and asserts:
//   * a real Hive master password and four private keys appear on screen,
//   * they are derivable from each other (so they open the account that WOULD be made),
//   * not one byte of that material appears in any request the page sent,
//   * and the server-rendered HTML never contained it either.
//
// It deliberately STOPS before "Create my Hive account": creating a Hive account is
// irreversible and spends a real token. Nothing here writes to any chain.
import { chromium } from '@playwright/test';
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer } = pkg;

const ECPair = ECPairFactory(ecc);
const BASE = 'http://localhost:3000';
const CSRF = { 'content-type': 'application/json', 'x-csrf-token': '1' };

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

function cookiesFrom(res, jar) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// ── a fresh keyless lite account ───────────────────────────────────────────
const kp = ECPair.makeRandom({ compressed: true });
const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
const jar = {};

let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: CSRF, body: JSON.stringify({ address }) });
cookiesFrom(r, jar);
const ch = await r.json();
if (!ch.message) { console.log('FAIL: no challenge', ch); process.exit(1); }
const sig = Signer.sign(kp.toWIF(), address, ch.message);
r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address, signature: typeof sig === 'string' ? sig : sig.toString('base64'), nonce: ch.nonce }) });
cookiesFrom(r, jar);
const vr = await r.json();
const name = 'brw' + Date.now().toString(36).slice(-7);
if (vr.status === 'needs_name') {
  r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name }) });
  cookiesFrom(r, jar);
  const nr = await r.json();
  if (nr.status !== 'ok') { console.log('FAIL: signup', nr); process.exit(1); }
}
console.log(`signed in as @${name}\n`);

// ── the server-rendered page must be innocent ──────────────────────────────
const SECRET_PATTERN = /\bP?5[HJK][1-9A-HJ-NP-Za-km-z]{45,55}\b/;
const serverHtml = await (await fetch(`${BASE}/upgrade`, { headers: { cookie: cookieHeader(jar) } })).text();
check('the server-rendered /upgrade HTML contains nothing key-shaped', !SECRET_PATTERN.test(serverHtml));

// ── drive the real browser ─────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext();
await context.addCookies(
  Object.entries(jar).map(([n, value]) => ({ name: n, value, domain: 'localhost', path: '/' }))
);

// The app reads "who am I" from localStorage as react-query `initialData` and does not
// refetch on mount (packages/smart-signer/lib/auth/use-user-core.ts), so a session
// cookie alone leaves the client rendering as signed-out. A real login writes this
// entry; this test injects cookies directly, so it has to write it too. Not a
// workaround for a bug — it is what signing in through the UI does.
const me = await (await fetch(`${BASE}/api/users/me`, { headers: { cookie: cookieHeader(jar) } })).json();
if (!me.isLoggedIn) { console.log('FAIL: session not accepted', me); process.exit(1); }
await context.addInitScript((user) => {
  // Runs on every document, including `about:blank`, where storage access can throw.
  try {
    window.localStorage.setItem('user', JSON.stringify(user));
  } catch {
    /* not a real origin yet — the next navigation gets it */
  }
}, me);

// Record every byte the page SENDS. This is the assertion that matters most.
const sentBodies = [];
const sentUrls = [];
context.on('request', (req) => {
  sentUrls.push(req.url());
  const body = req.postData();
  if (body) sentBodies.push(body);
});

const page = await context.newPage();
const consoleText = [];
page.on('console', (msg) => consoleText.push(msg.text()));

await page.goto(`${BASE}/upgrade`, { waitUntil: 'networkidle' });
if (process.env.DEBUG_UPGRADE) {
  console.log('--- page text ---');
  console.log((await page.textContent('body'))?.slice(0, 600));
  console.log('--- cookies seen by page ---');
  console.log((await context.cookies()).map((c) => c.name).join(', '));
  console.log('--- /api/users/me from inside the page ---');
  console.log(await page.evaluate(async () => { const r = await fetch('/api/users/me'); return r.text(); }));
  console.log('--- localStorage user ---');
  console.log(await page.evaluate(() => window.localStorage.getItem('user')));
  await page.waitForTimeout(4000);
  console.log('--- testids present ---');
  console.log(
    (await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))
    )).join(', ')
  );
  console.log('--- visible text ---');
  console.log((await page.evaluate(() => document.body.innerText || '')).slice(0, 300));
}

const hiveName = `${name}h`.slice(0, 16);
await page.fill('[data-testid="upgrade-name"]', hiveName);
// The name check is debounced and hits the network; wait for the button to enable.
await page.waitForSelector('[data-testid="upgrade-continue"]:not([disabled])', { timeout: 20000 });
await page.click('[data-testid="upgrade-continue"]');
await page.waitForSelector('[data-testid="upgrade-keys"]', { timeout: 30000 });

const shown = await page.$$eval('[data-testid="upgrade-keys"] code', (nodes) => nodes.map((n) => n.textContent?.trim() ?? ''));
check('five secrets are shown (master + 4 role keys)', shown.length === 5, `got ${shown.length}`);

const [master, owner, active, posting, memo] = shown;
check('the master password is a real "P"+WIF', /^P5[1-9A-HJ-NP-Za-km-z]{50,51}$/.test(master || ''), master?.slice(0, 4));
check('four private keys are real WIFs', [owner, active, posting, memo].every((k) => /^5[HJK][1-9A-HJ-NP-Za-km-z]{48,49}$/.test(k || '')));
check('the four keys are distinct', new Set([owner, active, posting, memo]).size === 4);

// The keys must belong to the NAME on screen: derive them again here and compare.
const { createWaxFoundation } = await import('@hiveio/wax');
const wax = await createWaxFoundation();
const roles = ['owner', 'active', 'posting', 'memo'];
const rederived = roles.map((role) => wax.getPrivateKeyFromPassword(hiveName, role, master).wifPrivateKey);
check(
  'the master password re-derives exactly these four keys FOR THIS NAME',
  JSON.stringify(rederived) === JSON.stringify([owner, active, posting, memo]),
  'the keys on screen do not match the password on screen'
);

// ── the whole point ────────────────────────────────────────────────────────
const everythingSent = sentBodies.join('\n') + '\n' + sentUrls.join('\n');
const leaked = [master, owner, active, posting, memo].filter((secret) => secret && everythingSent.includes(secret));
check('NOTHING secret was sent to the network', leaked.length === 0, leaked.length ? `${leaked.length} value(s) found in a request` : '');
check('no request body matches a key pattern at all', !SECRET_PATTERN.test(sentBodies.join('\n')));
check(
  'the console logged no key material',
  ![master, owner, active, posting, memo].some((s) => s && consoleText.join('\n').includes(s))
);

// Browser storage must not hold them either: this tab can be closed at any moment,
// and anything persisted here outlives the moment the user is looking at it.
const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
check('nothing key-shaped in localStorage or sessionStorage', !SECRET_PATTERN.test(storage));

// And the public keys DID go nowhere yet — creation has not been attempted.
check('no account-creation request was sent', !sentUrls.some((u) => u.endsWith('/api/account/upgrade') && sentBodies.length > 0 && sentBodies.some((b) => b.includes('publicKeys'))));

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
