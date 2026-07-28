// Proves the account-recovery path: list linked sign-in methods, and link a SECOND one.
//
// The bind endpoint has existed since Phase 2 with nothing in the product calling it,
// so every lite user had exactly one credential and no way to add another. This asserts
// the flow the new security screen drives, plus the trap that made an EVM bind
// impossible: /stepup used to return only the BITCOIN bind message, and /bind verifies
// an EVM signature against a DIFFERENT string, so the signature came back
// `bad_signature` with nothing to say why.
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
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

/** Sign up a fresh keyless BTC lite account and return its cookie jar + name. */
async function newLiteAccount(tag) {
  const kp = ECPair.makeRandom({ compressed: true });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
  const jar = {};

  let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: CSRF, body: JSON.stringify({ address }) });
  cookiesFrom(r, jar);
  const ch = await r.json();
  if (!ch.message) { console.log('FAIL: challenge', ch); process.exit(1); }

  const sig = Signer.sign(kp.toWIF(), address, ch.message);
  const sigB64 = typeof sig === 'string' ? sig : sig.toString('base64');
  r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address, signature: sigB64, nonce: ch.nonce }) });
  cookiesFrom(r, jar);
  const vr = await r.json();
  if (vr.status !== 'needs_name') { console.log('FAIL: verify', vr); process.exit(1); }

  const name = tag + Date.now().toString(36).slice(-6);
  r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name }) });
  cookiesFrom(r, jar);
  const nr = await r.json();
  if (nr.status !== 'ok') { console.log('FAIL: signup', nr); process.exit(1); }
  return { jar, name, btcAddress: address };
}

const methodsOf = async (jar) => {
  const r = await fetch(`${BASE}/api/lite/auth/methods`, { headers: { cookie: cookieHeader(jar) } });
  return { status: r.status, body: await r.json() };
};
const stepUp = async (jar) => {
  const r = await fetch(`${BASE}/api/lite/auth/stepup`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) } });
  return { status: r.status, body: await r.json() };
};
const bind = async (jar, payload) => {
  const r = await fetch(`${BASE}/api/lite/auth/bind`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const alice = await newLiteAccount('bnd');
console.log(`signed in as @${alice.name}\n`);

// ── 1. a one-credential account is flagged at risk ──────────────────────────
console.log('1. a single sign-in method is reported as a risk');
{
  const { status, body } = await methodsOf(alice.jar);
  check('methods listed', status === 200, String(status));
  check('exactly one method', body.methods?.length === 1, JSON.stringify(body.methods));
  check('it is the BTC wallet', body.methods?.[0]?.method === 'btc_wallet', body.methods?.[0]?.method);
  check('atRisk is true', body.atRisk === true);
  check('address is only hinted, never returned in full', !JSON.stringify(body).includes(alice.btcAddress));
}

// ── 2. step-up returns BOTH bind messages (the bug) ─────────────────────────
console.log('\n2. step-up returns a per-chain bind message');
let su;
{
  const { status, body } = await stepUp(alice.jar);
  su = body;
  check('step-up issued', status === 200 && !!body.nonce, JSON.stringify(body));
  check('btc message present', typeof body.messages?.btc === 'string' && body.messages.btc.length > 0);
  check('evm message present', typeof body.messages?.evm === 'string' && body.messages.evm.length > 0);
  check('the two messages DIFFER (signing the wrong one fails)', body.messages?.btc !== body.messages?.evm);
  check('legacy `message` still the btc one', body.message === body.messages?.btc);
}

// ── 3. signing the WRONG chain's message is refused ─────────────────────────
console.log('\n3. an EVM signature over the BTC message is refused');
{
  const account = privateKeyToAccount(generatePrivateKey());
  const wrongSig = await account.signMessage({ message: su.messages.btc });
  const { status, body } = await bind(alice.jar, { method: 'evm', address: account.address, signature: wrongSig, nonce: su.nonce });
  check('refused', status === 401, `${status} ${JSON.stringify(body)}`);
  check('reported as a bad signature', body?.error === 'bad_signature', body?.error);
}

// ── 4. the correct message links the wallet ─────────────────────────────────
console.log('\n4. an EVM wallet links with the right message');
const evmAccount = privateKeyToAccount(generatePrivateKey());
{
  // Step 3 consumed the nonce (single-use), so take a fresh one — as the UI does.
  const fresh = (await stepUp(alice.jar)).body;
  const sig = await evmAccount.signMessage({ message: fresh.messages.evm });
  const { status, body } = await bind(alice.jar, { method: 'evm', address: evmAccount.address, signature: sig, nonce: fresh.nonce });
  check('bind accepted', status === 200 && body?.status === 'ok', `${status} ${JSON.stringify(body)}`);

  const after = await methodsOf(alice.jar);
  check('now two methods', after.body.methods?.length === 2, JSON.stringify(after.body.methods));
  check('atRisk cleared', after.body.atRisk === false);
  check('the EVM wallet is listed', after.body.methods?.some((m) => m.method === 'evm_wallet'));
}

// ── 5. a consumed nonce cannot be replayed ──────────────────────────────────
console.log('\n5. a step-up nonce is single-use');
{
  const fresh = (await stepUp(alice.jar)).body;
  const other = privateKeyToAccount(generatePrivateKey());
  const sig = await other.signMessage({ message: fresh.messages.evm });
  const first = await bind(alice.jar, { method: 'evm', address: other.address, signature: sig, nonce: fresh.nonce });
  check('first use accepted', first.status === 200, String(first.status));
  const replay = await bind(alice.jar, { method: 'evm', address: other.address, signature: sig, nonce: fresh.nonce });
  check('replay refused', replay.status === 401, `${replay.status} ${JSON.stringify(replay.body)}`);
}

// ── 6. a credential already linked elsewhere cannot be stolen ───────────────
console.log('\n6. a wallet already linked to another account is refused');
{
  const bob = await newLiteAccount('bnb');
  const fresh = (await stepUp(bob.jar)).body;
  const sig = await evmAccount.signMessage({ message: fresh.messages.evm });
  const { status } = await bind(bob.jar, { method: 'evm', address: evmAccount.address, signature: sig, nonce: fresh.nonce });
  check('refused as a conflict', status === 409, String(status));

  const alicesStill = await methodsOf(alice.jar);
  check("alice keeps the wallet", alicesStill.body.methods?.some((m) => m.method === 'evm_wallet'));
}

// ── 7. an anonymous caller gets nothing ─────────────────────────────────────
console.log('\n7. the endpoints require a lite session');
{
  const r = await fetch(`${BASE}/api/lite/auth/methods`);
  check('methods refused without a session', r.status === 401, String(r.status));
  const s = await fetch(`${BASE}/api/lite/auth/stepup`, { method: 'POST', headers: CSRF });
  check('step-up refused without a session', s.status === 401, String(s.status));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
