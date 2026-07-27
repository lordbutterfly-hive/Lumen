// Regression test for the installed-base gap: a credential created BEFORE key
// fingerprints existed holds key_fingerprint = NULL, and `WHERE key_fingerprint = $1`
// can never match NULL — so one legacy key could still claim a bonus account by
// presenting a different address encoding. The fix looks up the key's SIBLING
// ADDRESSES (an address can't be reversed into a pubkey, so the column can't be
// backfilled blindly) and heals the old row on the way through.
import { execSync } from 'node:child_process';
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer } = pkg;
const ECPair = ECPairFactory(ecc);

const BASE = 'http://localhost:3000';
const IP = '10.77.9.9';
const psql = (sql) => execSync(`docker exec lumen-pg psql -U lumen -d lumen -tAc ${JSON.stringify(sql)}`).toString().trim();

const kp = ECPair.makeRandom({ compressed: true });
const wif = kp.toWIF();
const legacy = bitcoin.payments.p2pkh({ pubkey: kp.publicKey }).address;
const segwit = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey }).address;

// Simulate a PRE-FIX account: credential keyed on the legacy address, no fingerprint.
const uid = 'legacytest' + Date.now().toString(36);
const name = 'legacy' + Date.now().toString(36).slice(-6);
psql(`insert into lumen_user (user_id, display_name, display_name_history, account_tier, trust_score, status) values ('${uid}', '${name}', '[]'::jsonb, 'lite', 0, 'active')`);
psql(`insert into lumen_auth_credential (credential_id, user_id, method, external_ref, network, key_fingerprint) values ('${uid}c', '${uid}', 'btc_wallet', '${legacy}', 'bitcoin', NULL)`);
console.log(`pre-fix account @${name} bound to ${legacy} with key_fingerprint = NULL`);

// Now log in with a DIFFERENT address of the SAME key.
const jar = {};
const H = { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': IP };
const grab = (r) => { for (const c of (r.headers.getSetCookie?.() ?? [])) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('='); };
const CH = () => ({ ...H, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });

let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: H, body: JSON.stringify({ address: segwit }) });
grab(r); const ch = await r.json();
const sig = Signer.sign(wif, segwit, ch.message);
r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: CH(), body: JSON.stringify({ address: segwit, signature: typeof sig === 'string' ? sig : sig.toString('base64'), nonce: ch.nonce }) });
const vr = await r.json();
console.log(`segwit (same key) verify -> ${r.status} ${vr.status ?? vr.error}${vr.user ? ' as @' + vr.user.username : ''}`);

const healed = psql(`select coalesce(key_fingerprint,'NULL') from lumen_auth_credential where credential_id='${uid}c'`);
console.log('legacy row fingerprint now:', healed === 'NULL' ? 'STILL NULL' : healed.slice(0, 16) + '…');

const verdict = vr.status === 'authenticated' && vr.user?.username === name;
console.log(verdict ? '\nPASS: the legacy key logged into its EXISTING account (no bonus account)' : '\nFAIL: a second account was created for one key');

psql(`delete from lumen_auth_credential where user_id='${uid}'`);
psql(`delete from lumen_user where user_id='${uid}'`);
console.log('test rows cleaned up');
if (!verdict) process.exit(1);
