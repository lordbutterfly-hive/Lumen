// BTC lite-login end-to-end proof against the running dev server.
// Generates a SegWit key, runs challenge -> sign -> verify -> name, asserts a session.
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer } = pkg;

const ECPair = ECPairFactory(ecc);
const BASE = 'http://localhost:3000';
const CSRF = { 'content-type': 'application/json', 'x-csrf-token': '1' };

const kp = ECPair.makeRandom({ compressed: true });
const wif = kp.toWIF();
const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
console.log('address', address);

function cookiesFrom(res, jar) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

const jar = {};
// 1. challenge
let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: CSRF, body: JSON.stringify({ address }) });
cookiesFrom(r, jar);
const ch = await r.json();
console.log('challenge', r.status, ch);
if (!ch.message) { console.log('FAIL: no challenge message'); process.exit(1); }

// 2. sign the exact message
const signature = Signer.sign(wif, address, ch.message);
const sigB64 = typeof signature === 'string' ? signature : signature.toString('base64');
console.log('signature', sigB64.slice(0, 24) + '…');

// 3. verify
r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address, signature: sigB64, nonce: ch.nonce }) });
cookiesFrom(r, jar);
const vr = await r.json();
console.log('verify', r.status, vr);
if (vr.status !== 'needs_name' && vr.status !== 'authenticated') { console.log('FAIL: verify did not authenticate'); process.exit(1); }

// 4. pick a name (new user)
if (vr.status === 'needs_name') {
  const name = 'btcuser' + Math.floor(kp.publicKey[0] * 7 + kp.publicKey[1]);
  r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name }) });
  cookiesFrom(r, jar);
  const nr = await r.json();
  console.log('name', r.status, nr, 'chose', name);
  if (nr.status !== 'ok') { console.log('FAIL: signup did not complete'); process.exit(1); }
}
console.log('SESSION COOKIES:', Object.keys(jar).join(', '));

// 5. WRITE a post as the logged-in lite user
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ tier: 'normal', title: 'Hello from a BTC lite account', body: 'This post was written by a keyless BTC account and will be proxied to Hive by the frontend account.', tags: ['lumen', 'test'] }) });
const pr = await r.json();
console.log('write', r.status, pr.status, pr.post ? ('postId=' + pr.post.id) : pr);
if (r.status !== 201 || pr.status !== 'ok') { console.log('FAIL: write did not persist'); process.exit(1); }

// 6. read it back from the DB-sourced feed
r = await fetch(`${BASE}/api/lite/posts?limit=5`, { headers: CSRF });
const feed = await r.json();
const found = (feed.entries || []).some((e) => (e.title || '').includes('BTC lite account'));
console.log('feed', r.status, 'entries=' + (feed.entries || []).length, 'ourPostVisible=' + found);
if (!found) { console.log('FAIL: post not in feed'); process.exit(1); }

// 7. COMMENT on a Hive post (proxied reply to a chain parent)
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ tier: 'normal', body: 'Great post — replying from a keyless Lumen account.', parentRef: { type: 'chain', author: 'blocktrades', permlink: 'a-hive-post-permlink' } }) });
const cr = await r.json();
console.log('comment', r.status, cr.status);
if (r.status !== 201 || cr.status !== 'ok') { console.log('FAIL: comment did not persist'); process.exit(1); }

console.log('RESULT: BTC LOGIN + WRITE + COMMENT E2E PASS');
