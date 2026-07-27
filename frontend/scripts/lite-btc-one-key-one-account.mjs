// One Bitcoin key must map to ONE Lumen account, whichever of its three standard
// address formats a wallet presents. Before the key-fingerprint fix this created
// three separate accounts from a single key — a free 3x Sybil multiplier.
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer } = pkg;
const ECPair = ECPairFactory(ecc);

const BASE = 'http://localhost:3000';
const IP = '10.66.1.1';
const kp = ECPair.makeRandom({ compressed: true });
const wif = kp.toWIF();
const forms = {
  legacy: bitcoin.payments.p2pkh({ pubkey: kp.publicKey }).address,
  p2shSegwit: bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }) }).address,
  nativeSegwit: bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).address
};
console.log('one key, three addresses:', forms);

async function login(address, label) {
  const jar = {};
  const H = { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': IP };
  const grab = (r) => { for (const c of (r.headers.getSetCookie?.() ?? [])) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('='); };
  const CH = () => ({ ...H, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });

  let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: H, body: JSON.stringify({ address }) });
  grab(r); const ch = await r.json();
  if (!ch.message) return console.log(`${label}: challenge failed`, ch);
  const sig = Signer.sign(wif, address, ch.message);
  const sigB64 = typeof sig === 'string' ? sig : sig.toString('base64');
  r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: CH(), body: JSON.stringify({ address, signature: sigB64, nonce: ch.nonce }) });
  grab(r); const vr = await r.json();
  console.log(`${label.padEnd(13)} verify -> ${r.status} ${vr.status ?? vr.error}${vr.user ? ' as @' + vr.user.username : ''}`);
  if (vr.status === 'needs_name') {
    const name = 'onekey' + address.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '');
    r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: CH(), body: JSON.stringify({ displayName: name }) });
    grab(r); const nr = await r.json();
    console.log(`${''.padEnd(13)} signed up as @${nr.user?.username ?? '?'} (${nr.status})`);
  }
}

await login(forms.nativeSegwit, 'nativeSegwit');
await login(forms.legacy, 'legacy');
await login(forms.p2shSegwit, 'p2shSegwit');
