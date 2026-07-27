// Does our verifier accept the BIP-137 header bytes that real SegWit wallets
// (Xverse et al.) actually emit — 39-42 for bc1q — or only the 27-34 range?
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer, Verifier } = pkg;
const ECPair = ECPairFactory(ecc);

const kp = ECPair.makeRandom({ compressed: true });
const wif = kp.toWIF();
const p2pkh = bitcoin.payments.p2pkh({ pubkey: kp.publicKey }).address;
const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).address;
const msg = 'Lumen sign-in: test-nonce';

// A legacy-address signing gives us a real BIP-137 compact signature (header 31-34).
const legacy = Signer.sign(wif, p2pkh, msg);
const b64 = typeof legacy === 'string' ? legacy : legacy.toString('base64');
const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
console.log('BIP-137 header emitted by bip322-js:', bytes[0], '(len', bytes.length + ')');

const reheader = (h) => {
  const b = Uint8Array.from(bytes); b[0] = h;
  return Buffer.from(b).toString('base64');
};
const tryVerify = (addr, sig, label) => {
  try { console.log(label, '->', Verifier.verifySignature(addr, msg, sig)); }
  catch (e) { console.log(label, '-> THREW:', e.message); }
};

console.log('\n-- against the bc1q (native SegWit) address, as a real wallet would --');
tryVerify(p2wpkh, b64, `header ${bytes[0]} (as-emitted, P2PKH range)`);
for (const h of [35, 36, 39, 40, 41, 42]) tryVerify(p2wpkh, reheader(h), `header ${h}`);
console.log('\n-- sanity: the legacy address with its own signature --');
tryVerify(p2pkh, b64, `header ${bytes[0]} on P2PKH addr`);
