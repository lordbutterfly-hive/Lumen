import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { findByMethodAndRef } from '@/blog/lib/lite/repositories/credential-repository';
import {
  bindMessage as btcBindMessage,
  isTaproot,
  normalizeBtcAddress,
  verifyBtcSignature
} from '@/blog/lib/lite/auth/btc-verify';
import {
  bindMessage as evmBindMessage,
  isEvmAddress,
  normalizeEvmAddress,
  verifyEvmSignature
} from '@/blog/lib/lite/auth/evm-verify';
import { verifyGoogleIdToken } from '@/blog/lib/lite/auth/google-verify';

/**
 * F-L1 — proof that the person driving an account-security action still holds
 * one of the account's OWN credentials, not merely its session cookie.
 *
 * THE SPEC REQUIRES THIS. LUMEN-LITE-ACCOUNTS-SPEC-2026-07-22 §"Sessions":
 * "Step-up re-auth required only for account-security actions (upgrade,
 * add/remove binder, set payout target) — not ordinary posting", and again:
 * "Step-up (fresh assertion/signature) required for account-security actions
 * regardless of method." /bind implemented it; the UPGRADE route never did,
 * which left the single most destructive and least reversible action in the
 * system riding on the ambient session alone.
 *
 * WHY A BARE NONCE WOULD BE THEATRE, AND THIS IS NOT. The threat is a stolen or
 * transient session. Such a session can mint its own step-up nonce, so a nonce
 * by itself adds nothing beyond CSRF/replay cover that already exists. What a
 * session thief CANNOT do is produce a fresh SIGNATURE from the wallet key (or
 * a fresh Google assertion) the account was registered with. That is what this
 * verifies, and it is why the check resolves the credential and requires it to
 * belong to the acting user — proving control of *a* wallet is not enough.
 *
 * Distinct from /bind: bind proves a NEW credential the account does not have
 * yet, so it deliberately does not require the credential to already exist.
 * Here the opposite is the whole point.
 */

export type StepUpProof =
  | { method: 'btc'; address: string; signature: string; nonce: string }
  | { method: 'evm'; address: string; signature: string; nonce: string }
  | { method: 'google'; idToken: string; nonce: string };

export type StepUpResult =
  | { ok: true; credentialId: string }
  | { ok: false; code: string; status: number };

/** Narrow an untrusted request body into a StepUpProof, or null. */
export function parseStepUpProof(raw: unknown): StepUpProof | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const nonce = p.nonce;
  if (typeof nonce !== 'string' || nonce === '') return null;

  if (p.method === 'google') {
    return typeof p.idToken === 'string' && p.idToken !== '' ? { method: 'google', idToken: p.idToken, nonce } : null;
  }
  if (p.method === 'btc' || p.method === 'evm') {
    if (typeof p.address !== 'string' || typeof p.signature !== 'string') return null;
    if (p.address === '' || p.signature === '') return null;
    return { method: p.method, address: p.address, signature: p.signature, nonce };
  }
  return null;
}

/**
 * Consume the user-bound step-up challenge and verify the proof against a
 * credential this user actually owns.
 *
 * The challenge is consumed FIRST and unconditionally, so a failed proof burns
 * the nonce rather than leaving it available for another guess.
 */
export async function verifyStepUpProof(userId: string, proof: StepUpProof): Promise<StepUpResult> {
  const consumed = await consumeChallenge(proof.nonce, 'stepup');
  if (!consumed || consumed.userId !== userId) {
    return { ok: false, code: 'invalid_or_expired_challenge', status: 401 };
  }

  if (proof.method === 'btc') {
    if (isTaproot(proof.address)) return { ok: false, code: 'taproot_unsupported', status: 400 };
    if (!verifyBtcSignature({ address: proof.address, message: btcBindMessage(proof.nonce), signatureBase64: proof.signature })) {
      return { ok: false, code: 'bad_signature', status: 401 };
    }
    return ownedCredential(userId, 'btc_wallet', normalizeBtcAddress(proof.address));
  }

  if (proof.method === 'evm') {
    if (!isEvmAddress(proof.address)) return { ok: false, code: 'invalid_address', status: 400 };
    if (!(await verifyEvmSignature({ address: proof.address, message: evmBindMessage(proof.nonce), signature: proof.signature }))) {
      return { ok: false, code: 'bad_signature', status: 401 };
    }
    return ownedCredential(userId, 'evm_wallet', normalizeEvmAddress(proof.address));
  }

  // google
  let identity;
  try {
    identity = await verifyGoogleIdToken(proof.idToken);
  } catch {
    return { ok: false, code: 'invalid_token', status: 401 };
  }
  if (!identity.emailVerified) return { ok: false, code: 'email_not_verified', status: 401 };
  // The ID token must echo OUR nonce, exactly as /bind requires — otherwise a
  // token minted for any other purpose would satisfy this.
  if (identity.nonce !== proof.nonce) return { ok: false, code: 'nonce_mismatch', status: 401 };
  return ownedCredential(userId, 'google_passkey', identity.sub);
}

/**
 * The step that separates this from /bind: the proven credential must be one of
 * THIS account's. Proving control of some wallet is not proof of control of
 * this account — without this, a session thief could sign with their own key.
 */
async function ownedCredential(
  userId: string,
  method: 'btc_wallet' | 'evm_wallet' | 'google_passkey',
  externalRef: string
): Promise<StepUpResult> {
  const credential = await findByMethodAndRef(method, externalRef);
  if (!credential || credential.userId !== userId) {
    return { ok: false, code: 'credential_not_owned', status: 401 };
  }
  return { ok: true, credentialId: credential.credentialId };
}
