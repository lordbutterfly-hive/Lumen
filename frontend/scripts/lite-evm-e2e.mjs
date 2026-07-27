// EVM lite-login end-to-end proof against the running dev server.
// Generates a fresh EVM key, runs challenge -> personal_sign -> verify -> name,
// asserts a real session and a write, then runs the negative cases that matter:
// replayed nonce, tampered signature, and a challenge consumed with a DIFFERENT
// address (the SEQ-1 binding).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = 'http://localhost:3000';
const CSRF = { 'content-type': 'application/json', 'x-csrf-token': '1' };

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
const address = account.address;
console.log('address', address);

function cookiesFrom(res, jar) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const fail = (m) => { console.log('FAIL:', m); process.exit(1); };

async function challenge(addr, jar) {
  const r = await fetch(`${BASE}/api/lite/auth/evm/challenge`, {
    method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address: addr })
  });
  cookiesFrom(r, jar);
  return [r.status, await r.json()];
}
async function verify(payload, jar) {
  const r = await fetch(`${BASE}/api/lite/auth/evm/verify`, {
    method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify(payload)
  });
  cookiesFrom(r, jar);
  return [r.status, await r.json()];
}

const jar = {};

// 1. challenge
let [st, ch] = await challenge(address, jar);
console.log('challenge', st, ch.nonce ? { nonce: ch.nonce } : ch);
if (!ch.message) fail('no challenge message');

// 2. sign the exact message with personal_sign (EIP-191)
const signature = await account.signMessage({ message: ch.message });
console.log('signature', signature.slice(0, 24) + '…');

// 3. verify -> session
let vr;
[st, vr] = await verify({ address, signature, nonce: ch.nonce }, jar);
console.log('verify', st, vr);
if (vr.status !== 'needs_name' && vr.status !== 'authenticated') fail('verify did not authenticate');

// 4. pick a name (new user)
if (vr.status === 'needs_name') {
  const name = 'evmuser' + address.slice(2, 8).toLowerCase();
  const r = await fetch(`${BASE}/api/lite/auth/name`, {
    method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name })
  });
  cookiesFrom(r, jar);
  const nr = await r.json();
  console.log('name', r.status, nr, 'chose', name);
  if (nr.status !== 'ok') fail('signup did not complete');
}
console.log('SESSION COOKIES:', Object.keys(jar).join(', '));

// 5. WRITE a post as the logged-in lite user
let r = await fetch(`${BASE}/api/lite/posts`, {
  method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) },
  body: JSON.stringify({
    tier: 'normal',
    title: 'Hello from an EVM lite account',
    body: 'Written by a keyless EVM account; the frontend account proxies it to Hive.',
    tags: ['lumen', 'test']
  })
});
const pr = await r.json();
console.log('write', r.status, pr.status, pr.post ? 'postId=' + pr.post.id : pr);
if (r.status !== 201 || pr.status !== 'ok') fail('write did not persist');

// ---- negative cases ----
const attack = {};

// A. replay the already-consumed nonce
[st, vr] = await verify({ address, signature, nonce: ch.nonce }, attack);
console.log('NEG replay-nonce ->', st, vr.error || vr.status);
if (st === 200) fail('a consumed nonce was accepted twice');

// B. tampered signature over a fresh nonce
let ch2;
[st, ch2] = await challenge(address, attack);
const flipped = signature.slice(0, -2) + (signature.slice(-2) === 'ff' ? 'ee' : 'ff');
[st, vr] = await verify({ address, signature: flipped, nonce: ch2.nonce }, attack);
console.log('NEG bad-signature ->', st, vr.error || vr.status);
if (st === 200) fail('a tampered signature was accepted');

// C. challenge issued for OUR address, consumed with the ATTACKER's address
//    (SEQ-1 binding) — signed correctly by the attacker over the same message.
const other = privateKeyToAccount(generatePrivateKey());
let ch3;
[st, ch3] = await challenge(address, attack);
const otherSig = await other.signMessage({ message: ch3.message });
[st, vr] = await verify({ address: other.address, signature: otherSig, nonce: ch3.nonce }, attack);
console.log('NEG address-swap ->', st, vr.error || vr.status);
if (st === 200) fail('a challenge bound to one address was consumed with another');

// D. garbage address shape
[st, vr] = await verify({ address: '0xnot-an-address', signature, nonce: 'x' }, attack);
console.log('NEG bad-address ->', st, vr.error || vr.status);
if (st === 200) fail('a malformed address was accepted');

console.log('\nEVM LOGIN E2E: PASS (login + write + 4 negative cases held)');
