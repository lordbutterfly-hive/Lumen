import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { verifyGoogleIdToken } from '@/blog/lib/lite/auth/google-verify';
import { encryptEmail, emailHash } from '@/blog/lib/lite/auth/email-crypto';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { verifyBtcSignature, bindMessage, btcNetwork, isTaproot, normalizeBtcAddress } from '@/blog/lib/lite/auth/btc-verify';
import { verifiedBtcKeyFingerprint } from '@/blog/lib/lite/auth/btc-key-fingerprint';
import {
  verifyEvmSignature,
  bindMessage as evmBindMessage,
  evmNetwork,
  isEvmAddress,
  normalizeEvmAddress
} from '@/blog/lib/lite/auth/evm-verify';
import { bindMethod } from '@/blog/lib/lite/auth/auth-service';
import { writeCredentialAudit } from '@/blog/lib/lite/repositories/credential-repository';
import { checkAndConsume } from '@/blog/lib/lite/repositories/rate-limit-repository';
import { dayKey } from '@/blog/lib/lite/antispam/windows';

/** Binds are a rare recovery-setup action; a per-user/day ceiling blunts a
 *  stolen-session bind-flood without ever getting in a legitimate user's way. */
const BIND_LIMIT_PER_DAY = 20;

const logger = getLogger('app');

/**
 * POST /api/lite/auth/bind  — link a SECOND auth method to the signed-in lite
 * account (the account-recovery mechanism, spec §A.1). Requires an authenticated
 * lite session AND a fresh proof of the new credential.
 *   google: { method:'google', idToken }
 *   btc:    { method:'btc', address, signature, nonce }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  // F-L2: gate on the DB row's status (checkLiteActorById), not the cookie tier — a
  // suspended/banned/revoked session must not be able to bind a new recovery method.
  // Carries the F-L3 epoch check too.
  const actor = await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  // F-L2: rate-limit binds per user/day. Counts every attempt (a valid step-up is
  // still required below), so a stolen session cannot flood recovery methods.
  if (!(await checkAndConsume('user:' + user.userId, 'bind', BIND_LIMIT_PER_DAY, dayKey()))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const method = body?.method;

  try {
    if (method === 'google') {
      const idToken = body?.idToken;
      const nonce = body?.nonce;
      if (typeof idToken !== 'string' || typeof nonce !== 'string') {
        return NextResponse.json({ error: 'idToken_and_nonce_required' }, { status: 400 });
      }
      // XC-2 (PRUNED 2026-07-22): step-up. Consume a user-bound 'stepup' challenge
      // and require the Google ID token to echo it as its `nonce` claim, so an
      // attacker cannot pre-bind a victim's Google identity without our nonce.
      const consumed = await consumeChallenge(nonce, 'stepup');
      if (!consumed || consumed.userId !== user.userId) {
        return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
      }
      let identity;
      try {
        identity = await verifyGoogleIdToken(idToken);
      } catch (error) {
        logger.error(error, 'Bind: Google verification failed');
        return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
      }
      if (!identity.emailVerified) {
        return NextResponse.json({ error: 'email_not_verified' }, { status: 401 });
      }
      if (identity.nonce !== nonce) {
        return NextResponse.json({ error: 'nonce_mismatch' }, { status: 401 });
      }
      const ciphertext = encryptEmail(identity.email);
      const result = await bindMethod(user.userId, 'google_passkey', identity.sub, {
        emailCiphertextB64: ciphertext?.toString('base64'),
        emailHash: emailHash(identity.email)
      });
      return result.status === 'ok'
        ? NextResponse.json({ status: 'ok' })
        : NextResponse.json(result, { status: 409 });
    }

    if (method === 'btc') {
      const address = body?.address;
      const signature = body?.signature;
      const nonce = body?.nonce;
      if (typeof address !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
      }
      if (isTaproot(address)) {
        return NextResponse.json({ error: 'taproot_unsupported' }, { status: 400 });
      }
      // SEQ-1 (PRUNED 2026-07-22): bind requires a STEP-UP challenge (distinct
      // purpose, user-bound) — a plain login nonce can no longer be replayed here,
      // and the signed message is the distinct bindMessage, not loginMessage.
      const consumed = await consumeChallenge(nonce, 'stepup');
      if (!consumed || consumed.userId !== user.userId) {
        return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
      }
      if (!verifyBtcSignature({ address, message: bindMessage(nonce), signatureBase64: signature })) {
        return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
      }
      const result = await bindMethod(user.userId, 'btc_wallet', normalizeBtcAddress(address), {
        network: btcNetwork(address),
        // F-L29: bind the fingerprint to the proven address (network-aware), so a
        // spliced witness cannot register a victim's key under the attacker's account.
        keyFingerprint: verifiedBtcKeyFingerprint(bindMessage(nonce), signature, address) ?? undefined
      });
      return result.status === 'ok'
        ? NextResponse.json({ status: 'ok' })
        : NextResponse.json(result, { status: 409 });
    }

    if (method === 'evm') {
      const address = body?.address;
      const signature = body?.signature;
      const nonce = body?.nonce;
      if (typeof address !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
      }
      if (!isEvmAddress(address)) {
        return NextResponse.json({ error: 'invalid_address' }, { status: 400 });
      }
      // Same step-up rule as BTC (SEQ-1): a user-bound 'stepup' challenge, and the
      // signed message is the distinct evmBindMessage, never the login message.
      const consumed = await consumeChallenge(nonce, 'stepup');
      if (!consumed || consumed.userId !== user.userId) {
        return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
      }
      if (!(await verifyEvmSignature({ address, message: evmBindMessage(nonce), signature }))) {
        return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
      }
      const result = await bindMethod(user.userId, 'evm_wallet', normalizeEvmAddress(address), {
        network: evmNetwork()
      });
      return result.status === 'ok'
        ? NextResponse.json({ status: 'ok' })
        : NextResponse.json(result, { status: 409 });
    }

    return NextResponse.json({ error: 'unknown_method' }, { status: 400 });
  } catch (error) {
    logger.error(error, 'Lite bind failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
