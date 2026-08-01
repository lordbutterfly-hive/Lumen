/**
 * F-L1 — proves the step-up gate that now stands in front of the irreversible
 * lite -> full account upgrade, against a REAL Postgres.
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-stepup-e2e.ts
 *
 * The property under test: a valid SESSION is not sufficient to reach account
 * creation. The caller must additionally produce a fresh signature from a
 * credential THIS ACCOUNT ALREADY OWNS.
 *
 * That last clause is the one that matters and the one a weaker implementation
 * would miss: proving control of *a* wallet is not proof of control of *this
 * account*, so a session thief signing with their own key must be refused.
 */

import ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
// Namespace import: tsx compiles this .ts as CJS, where a default import of
// bip322-js resolves to undefined (the .mjs harnesses can use `import pkg from`
// because they are ESM).
import * as bip322 from 'bip322-js';
import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import * as credentials from '../apps/blog/lib/lite/repositories/credential-repository';
import { createChallenge } from '../apps/blog/lib/lite/repositories/challenge-repository';
import { bindMessage, normalizeBtcAddress } from '../apps/blog/lib/lite/auth/btc-verify';
import { parseStepUpProof, verifyStepUpProof } from '../apps/blog/lib/lite/auth/step-up';

type Bip322Signer = { sign: (wif: string, address: string, message: string) => string | Buffer };
const bip322Module = bip322 as unknown as { Signer?: Bip322Signer; default?: { Signer: Bip322Signer } };
const Signer: Bip322Signer = bip322Module.Signer ?? bip322Module.default!.Signer;
const ECPair = ECPairFactory(ecc);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function newWallet() {
  const kp = ECPair.makeRandom({ compressed: true });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
  return { wif: kp.toWIF(), address: address as string };
}

function sign(wif: string, address: string, message: string): string {
  const s = Signer.sign(wif, address, message);
  return typeof s === 'string' ? s : s.toString('base64');
}

async function makeUser(prefix: string) {
  const suffix = Math.floor(Math.random() * 1e9).toString(36);
  const displayName = `${prefix}${suffix}`.slice(0, 16);
  const wallet = newWallet();
  const user = await users.createUser({ displayName });
  await credentials.createCredential({
    userId: user.userId,
    method: 'btc_wallet',
    externalRef: normalizeBtcAddress(wallet.address),
    network: 'bitcoin'
  });
  return { user, wallet };
}

async function stepUpNonce(userId: string): Promise<string> {
  const challenge = await createChallenge({ purpose: 'stepup', userId, ttlSeconds: 300 });
  return challenge.nonce;
}

async function main() {
  const alice = await makeUser('alice');
  const mallory = await makeUser('mal');

  // ── 1. The happy path: the account's own wallet, a fresh nonce.
  {
    const nonce = await stepUpNonce(alice.user.userId);
    const proof = parseStepUpProof({
      method: 'btc',
      address: alice.wallet.address,
      signature: sign(alice.wallet.wif, alice.wallet.address, bindMessage(nonce)),
      nonce
    });
    check('proof parses', proof !== null);
    const verdict = await verifyStepUpProof(alice.user.userId, proof!);
    check('own wallet + fresh nonce is accepted', verdict.ok, JSON.stringify(verdict));
  }

  // ── 2. ★ THE ONE THAT MATTERS: a valid signature from a wallet that is NOT
  // this account's. This is the session-thief case — they hold the cookie and
  // can sign with their own key all day.
  {
    const nonce = await stepUpNonce(alice.user.userId);
    const proof = parseStepUpProof({
      method: 'btc',
      address: mallory.wallet.address,
      signature: sign(mallory.wallet.wif, mallory.wallet.address, bindMessage(nonce)),
      nonce
    })!;
    const verdict = await verifyStepUpProof(alice.user.userId, proof);
    check(
      "another account's wallet is refused (credential_not_owned)",
      !verdict.ok && verdict.code === 'credential_not_owned',
      JSON.stringify(verdict)
    );
  }

  // ── 3. Replay: a nonce is single-use.
  {
    const nonce = await stepUpNonce(alice.user.userId);
    const signature = sign(alice.wallet.wif, alice.wallet.address, bindMessage(nonce));
    const first = await verifyStepUpProof(
      alice.user.userId,
      parseStepUpProof({ method: 'btc', address: alice.wallet.address, signature, nonce })!
    );
    check('first use accepted', first.ok);
    const replay = await verifyStepUpProof(
      alice.user.userId,
      parseStepUpProof({ method: 'btc', address: alice.wallet.address, signature, nonce })!
    );
    check('replayed nonce is refused', !replay.ok && replay.code === 'invalid_or_expired_challenge', JSON.stringify(replay));
  }

  // ── 4. Cross-user nonce: a challenge minted for Mallory cannot authorise
  // Alice's upgrade, even signed by Alice's own key.
  {
    const nonce = await stepUpNonce(mallory.user.userId);
    const proof = parseStepUpProof({
      method: 'btc',
      address: alice.wallet.address,
      signature: sign(alice.wallet.wif, alice.wallet.address, bindMessage(nonce)),
      nonce
    })!;
    const verdict = await verifyStepUpProof(alice.user.userId, proof);
    check("another user's challenge is refused", !verdict.ok && verdict.code === 'invalid_or_expired_challenge');
  }

  // ── 5. A LOGIN-purpose nonce must not work here (the /bind SEQ-1 lesson).
  {
    const login = await createChallenge({ purpose: 'login', userId: alice.user.userId, ttlSeconds: 300 });
    const proof = parseStepUpProof({
      method: 'btc',
      address: alice.wallet.address,
      signature: sign(alice.wallet.wif, alice.wallet.address, bindMessage(login.nonce)),
      nonce: login.nonce
    })!;
    const verdict = await verifyStepUpProof(alice.user.userId, proof);
    check('a login-purpose challenge is refused', !verdict.ok && verdict.code === 'invalid_or_expired_challenge');
  }

  // ── 6. Tampered signature.
  {
    const nonce = await stepUpNonce(alice.user.userId);
    const good = sign(alice.wallet.wif, alice.wallet.address, bindMessage(nonce));
    const tampered = good.slice(0, -4) + (good.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const verdict = await verifyStepUpProof(
      alice.user.userId,
      parseStepUpProof({ method: 'btc', address: alice.wallet.address, signature: tampered, nonce })!
    );
    check('tampered signature is refused', !verdict.ok, JSON.stringify(verdict));
  }

  // ── 7. Signing the WRONG message (a login message, not the bind message).
  {
    const nonce = await stepUpNonce(alice.user.userId);
    const verdict = await verifyStepUpProof(
      alice.user.userId,
      parseStepUpProof({
        method: 'btc',
        address: alice.wallet.address,
        signature: sign(alice.wallet.wif, alice.wallet.address, `something else ${nonce}`),
        nonce
      })!
    );
    check('a signature over the wrong message is refused', !verdict.ok && verdict.code === 'bad_signature');
  }

  // ── 8. Malformed proofs never reach verification.
  {
    check('missing nonce rejected at parse', parseStepUpProof({ method: 'btc', address: 'a', signature: 'b' }) === null);
    check('unknown method rejected at parse', parseStepUpProof({ method: 'sms', nonce: 'x' }) === null);
    check('empty signature rejected at parse', parseStepUpProof({ method: 'btc', address: 'a', signature: '', nonce: 'x' }) === null);
    check('google without idToken rejected at parse', parseStepUpProof({ method: 'google', nonce: 'x' }) === null);
    check('non-object rejected at parse', parseStepUpProof('nope') === null);
    check('undefined rejected at parse', parseStepUpProof(undefined) === null);
  }

  // Cleanup: these rows are test-only.
  await query('DELETE FROM lumen_auth_credential WHERE user_id = ANY($1)', [[alice.user.userId, mallory.user.userId]]);
  await query('DELETE FROM lumen_user WHERE user_id = ANY($1)', [[alice.user.userId, mallory.user.userId]]);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
