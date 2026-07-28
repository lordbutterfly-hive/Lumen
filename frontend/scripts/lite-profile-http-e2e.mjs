// Proves the lite profile, avatar and image-upload endpoints against the running dev
// server, with a real keyless session.
//
// The upload endpoint is exercised only through its REFUSALS (no file, wrong type,
// oversized, signed out). A successful upload posts a real file to Hive's image host
// signed by the publishing account, which is an external side effect, so it is not
// something a test should do on its own — run that by hand when you want it.
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

// ── sign up a fresh keyless BTC lite account ────────────────────────────────
const kp = ECPair.makeRandom({ compressed: true });
const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
const jar = {};

let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: CSRF, body: JSON.stringify({ address }) });
cookiesFrom(r, jar);
const ch = await r.json();
if (!ch.message) { console.log('FAIL: no challenge', ch); process.exit(1); }

const signature = Signer.sign(kp.toWIF(), address, ch.message);
const sigB64 = typeof signature === 'string' ? signature : signature.toString('base64');
r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address, signature: sigB64, nonce: ch.nonce }) });
cookiesFrom(r, jar);
const vr = await r.json();
if (vr.status !== 'needs_name' && vr.status !== 'authenticated') { console.log('FAIL: verify', vr); process.exit(1); }

const name = 'prof' + Date.now().toString(36).slice(-6);
if (vr.status === 'needs_name') {
  r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name }) });
  cookiesFrom(r, jar);
  const nr = await r.json();
  if (nr.status !== 'ok') { console.log('FAIL: signup', nr); process.exit(1); }
}
console.log(`signed in as @${name}\n`);
const authed = { ...CSRF, cookie: cookieHeader(jar) };

const PICTURE = 'https://images.hive.blog/DQmTest/profile.png';

// ── 1. an empty profile reads back cleanly ─────────────────────────────────
console.log('1. reading a profile that was never set');
{
  const res = await fetch(`${BASE}/api/lite/profile`, { headers: authed });
  const body = await res.json();
  check('200', res.status === 200, String(res.status));
  check('empty object, not an error', body.ok === true && typeof body.profile === 'object');
}

// ── 2. saving, and what the server refuses to save ─────────────────────────
console.log('\n2. saving a profile');
{
  const res = await fetch(`${BASE}/api/lite/profile`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({
      profile: {
        name: 'Test Person',
        about: 'Testing the profile',
        location: 'Zagreb',
        website: 'javascript:alert(1)',
        profile_image: PICTURE
      }
    })
  });
  const body = await res.json();
  check('saved', res.status === 200 && body.ok === true, JSON.stringify(body));
  check('name kept', body.profile?.name === 'Test Person');
  check('picture kept', body.profile?.profile_image === PICTURE);
  check('javascript: website dropped', body.profile?.website === '');

  const back = await (await fetch(`${BASE}/api/lite/profile`, { headers: authed })).json();
  check('reads back after save', back.profile?.about === 'Testing the profile');
}

// ── 3. the avatar endpoint serves what was set ─────────────────────────────
console.log('\n3. avatar');
{
  const res = await fetch(`${BASE}/api/avatar?username=${name}&size=small`, { redirect: 'manual' });
  // The stored URL is a fake path on the real host, so the fetch behind it fails and
  // the endpoint falls back to the generated avatar. Either outcome proves the lite
  // branch ran: what must NOT happen is the 404 a lite name used to produce.
  check('does not 404', res.status === 200, String(res.status));
  const type = res.headers.get('content-type') || '';
  check('serves an image', type.startsWith('image/'), type);

  const real = await fetch(`${BASE}/api/avatar?username=gtg&size=small`);
  check('a real Hive account is unaffected', real.status === 200, String(real.status));
}

// ── 4. upload refusals ─────────────────────────────────────────────────────
console.log('\n4. upload guards');
{
  const noFile = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { 'x-csrf-token': '1', cookie: cookieHeader(jar) },
    body: new FormData()
  });
  check('no file -> 400', noFile.status === 400, String(noFile.status));

  const textForm = new FormData();
  textForm.append('file', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
  const wrongType = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { 'x-csrf-token': '1', cookie: cookieHeader(jar) },
    body: textForm
  });
  const wtBody = await wrongType.json();
  check('a text file -> 400', wrongType.status === 400 && wtBody.error === 'unsupported_type', JSON.stringify(wtBody));

  const bigForm = new FormData();
  bigForm.append('file', new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/png' }), 'huge.png');
  const tooBig = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { 'x-csrf-token': '1', cookie: cookieHeader(jar) },
    body: bigForm
  });
  const tbBody = await tooBig.json();
  // 413 rather than 400: the size is now judged from Content-Length BEFORE the body is
  // buffered, so an oversized upload never gets read into memory at all.
  check('9 MB -> 413 before the body is read', tooBig.status === 413 && tbBody.error === 'too_large', JSON.stringify(tbBody));

  // Bytes that are NOT a PNG, despite the declared type: the sniffer must refuse them.
  const liarForm = new FormData();
  liarForm.append('file', new Blob(['<html>not a png</html>'], { type: 'image/png' }), 'x.png');
  const liar = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { 'x-csrf-token': '1', cookie: cookieHeader(jar) },
    body: liarForm
  });
  const liarBody = await liar.json();
  check(
    'a non-image claiming to be a PNG -> 400',
    liar.status === 400 && liarBody.error === 'unsupported_type',
    JSON.stringify(liarBody)
  );

  const anonForm = new FormData();
  anonForm.append('file', new Blob([new Uint8Array(10)], { type: 'image/png' }), 'x.png');
  const anon = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { 'x-csrf-token': '1' },
    body: anonForm
  });
  check('signed out -> 401', anon.status === 401, String(anon.status));

  const noCsrf = await fetch(`${BASE}/api/lite/upload`, {
    method: 'POST',
    headers: { cookie: cookieHeader(jar) },
    body: new FormData()
  });
  check('no CSRF header -> 403', noCsrf.status === 403, String(noCsrf.status));
}

// ── 5. profile writes need a session and a CSRF header too ─────────────────
console.log('\n5. profile guards');
{
  const anon = await fetch(`${BASE}/api/lite/profile`, {
    method: 'POST',
    headers: CSRF,
    body: JSON.stringify({ profile: { name: 'nope' } })
  });
  check('signed out -> 401', anon.status === 401, String(anon.status));

  const noCsrf = await fetch(`${BASE}/api/lite/profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) },
    body: JSON.stringify({ profile: { name: 'nope' } })
  });
  check('no CSRF header -> 403', noCsrf.status === 403, String(noCsrf.status));

  const still = await (await fetch(`${BASE}/api/lite/profile`, { headers: authed })).json();
  check('profile unchanged by the refused writes', still.profile?.name === 'Test Person');
}

// ── 6. follow state over HTTP ──────────────────────────────────────────────
console.log('\n6. follow state endpoint');
{
  const before = await (await fetch(`${BASE}/api/lite/follow/state?target=${name}`, { headers: authed })).json();
  check('self is never "following"', before.following === false);

  const anon = await (await fetch(`${BASE}/api/lite/follow/state?target=${name}`)).json();
  check('signed out sees nothing', anon.lumenEdge === false && anon.following === false);

  const missing = await fetch(`${BASE}/api/lite/follow/state`, { headers: authed });
  check('no target -> 400', missing.status === 400, String(missing.status));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
