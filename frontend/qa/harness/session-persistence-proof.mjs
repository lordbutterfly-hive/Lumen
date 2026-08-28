/**
 * Does a REAL browser keep the session across a refresh — over http and https?
 *
 * Why this exists: `qa-harness.mjs` establishes its session in NODE (fetch) and
 * then side-loads the cookies with `ctx.addCookies([... secure: true])`. That
 * bypasses the browser's own decision about whether to STORE the cookie, which
 * is exactly the step that fails. So a 40/40 green auth suite can sit next to a
 * user who is logged out on every refresh, and neither is lying.
 *
 * Here the BROWSER performs the login (in-page `fetch`), so the browser's
 * network stack handles every `Set-Cookie` the way it would for a real person.
 * Then we reload and ask the server who we are.
 *
 *   node qa/harness/session-persistence-proof.mjs
 */
import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';

const ORIGINS = [
  { label: 'http  :3000', base: 'http://localhost:3000' },
  { label: 'https :3443', base: 'https://localhost:3443' }
];

const loginMessage = (nonce) =>
  [
    'Lumen sign-in',
    '',
    'Sign this to prove you control this wallet.',
    'It authorizes no transaction and moves no funds.',
    '',
    `Nonce: ${nonce}`
  ].join('\n');

async function run({ label, base }) {
  const account = privateKeyToAccount(
    // distinct key per origin so the two runs never share an identity.
    // ★ Both are PUBLIC Hardhat test keys (accounts #1 and #5 of the standard
    // "test test ... junk" mnemonic), published in Hardhat's own docs. They are
    // written out rather than generated so a run is reproducible, and they are
    // deliberately well-known ones so nobody reading this committed file has to
    // work out whether a 64-hex string here is a real secret.
    base.startsWith('https')
      ? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
      : '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
  );

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // ── log in, with the BROWSER doing every request ──────────────────────────
  const challenge = await page.evaluate(async (address) => {
    const r = await fetch('/api/lite/auth/evm/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
      body: JSON.stringify({ address })
    });
    return r.json();
  }, account.address);

  if (!challenge?.nonce) {
    console.log(`${label}: could not get a challenge — ${JSON.stringify(challenge).slice(0, 160)}`);
    await browser.close();
    return { label, ok: false, reason: 'no challenge' };
  }

  const signature = await account.signMessage({ message: loginMessage(challenge.nonce) });

  const verify = await page.evaluate(
    async ({ address, signature, nonce }) => {
      const r = await fetch('/api/lite/auth/evm/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
        body: JSON.stringify({ address, signature, nonce })
      });
      return r.json();
    },
    { address: account.address, signature, nonce: challenge.nonce }
  );

  let username = verify?.user?.username;
  if (verify?.status === 'needs_name') {
    const named = await page.evaluate(async (displayName) => {
      const r = await fetch('/api/lite/auth/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': '1' },
        body: JSON.stringify({ displayName, captchaToken: 'qa-dummy-token' })
      });
      return r.json();
    }, 'sess' + Date.now().toString(36).slice(-6));
    username = named?.user?.username;
    if (!username) {
      console.log(`${label}: signup blocked — ${JSON.stringify(named).slice(0, 200)}`);
      await browser.close();
      return { label, ok: false, reason: 'signup blocked (likely rate limit)' };
    }
  }

  // What did the browser actually AGREE to store?
  const stored = await ctx.cookies();
  const sessionCookie = stored.find((c) => c.name.endsWith('session') || c.name === 'lumen_session');

  // ── the actual question: survive a reload? ────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  const after = await page.evaluate(async () => {
    const r = await fetch('/api/lite/auth/methods');
    return { status: r.status, body: await r.text() };
  });

  const stillAuthed = after.status === 200 && !/unauthor|not signed|401/i.test(after.body);

  console.log(
    `${label}  login=${username ? 'ok' : 'FAILED'}  cookiesStored=${stored.length}` +
      `  sessionCookie=${sessionCookie ? 'YES' : 'NO'}  afterReload=${stillAuthed ? 'STILL SIGNED IN' : 'LOGGED OUT'}` +
      `  (/methods -> ${after.status})`
  );

  await browser.close();
  return { label, ok: true, username, cookieCount: stored.length, hasSession: !!sessionCookie, stillAuthed };
}

const results = [];
for (const origin of ORIGINS) {
  try {
    results.push(await run(origin));
  } catch (e) {
    console.log(`${origin.label}: threw — ${String(e).slice(0, 200)}`);
    results.push({ label: origin.label, ok: false, reason: String(e).slice(0, 120) });
  }
}

console.log('\n──── verdict ────');
for (const r of results) {
  if (!r.ok) {
    console.log(`${r.label}: INCONCLUSIVE (${r.reason})`);
    continue;
  }
  console.log(
    `${r.label}: ${r.stillAuthed ? 'session survives refresh' : '★ LOGGED OUT ON REFRESH'}` +
      ` — browser stored ${r.cookieCount} cookie(s), session cookie ${r.hasSession ? 'present' : 'ABSENT'}`
  );
}
