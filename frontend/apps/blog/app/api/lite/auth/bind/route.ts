import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { verifyGoogleIdToken } from '@/blog/lib/lite/auth/google-verify';
import { encryptEmail, emailHash } from '@/blog/lib/lite/auth/email-crypto';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { verifyBtcSignature, bindMessage, btcNetwork, isTaproot } from '@/blog/lib/lite/auth/btc-verify';
import { bindMethod } from '@/blog/lib/lite/auth/auth-service';

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
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
      const result = await bindMethod(user.userId, 'btc_wallet', address.trim().toLowerCase(), {
        network: btcNetwork(address)
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
