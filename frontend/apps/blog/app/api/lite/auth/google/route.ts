import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardBodySize, guardWrite, payloadTooLarge, readBoundedJson } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import {
  googleCodeFlowConfigured,
  verifyGoogleAuthCode,
  verifyGoogleIdToken
} from '@/blog/lib/lite/auth/google-verify';
import { encryptEmail, emailHash } from '@/blog/lib/lite/auth/email-crypto';
import { resolveLogin } from '@/blog/lib/lite/auth/auth-service';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/google  — { idToken }
 * Verifies the Google ID token server-side, then resolves to an existing
 * account (session) or flags `needs_name` for first-time sign-up.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;
  // This endpoint had NO per-source cap while both wallet paths did, so it was the
  // open door: unlimited Google sign-in/sign-up attempts from one source.
  if (!(await enforceChallengeRate(getClientIp(req), 'google'))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // ★ STREAM-BOUNDED, not header-bounded (2026-08-23). This route is reachable with no
  // token and no session, so the caller chooses whether to send `content-length` — and
  // `guardBodySize` trusts it. `readBoundedJson` counts bytes as it reads and cancels past
  // the limit, so an oversized body is never fully buffered.
  const parsed = await readBoundedJson<Record<string, unknown>>(req);
  if (!parsed) return payloadTooLarge();
  const body = parsed.body;
  const idToken = body?.idToken;
  /**
   * ★ TWO WAYS IN, ONE VERIFICATION (2026-08-28).
   *
   * `idToken` comes from GIS's own rendered button. `code` comes from
   * `initCodeClient`, which is what lets Lumen draw its OWN button — GIS refuses to
   * act on a click when its rendered button is transparent, transformed or clipped,
   * so a Lumen-styled row can never be an overlay over it.
   *
   * Both paths end at `verifyGoogleIdToken`, so the audience check, the signature
   * check and — the one that matters — the `nonce` echo binding below are identical.
   * The code path is NOT a weaker door; it is the same door reached differently.
   */
  const code = body?.code;
  const nonce = body?.nonce;
  if (typeof nonce !== 'string' || (typeof idToken !== 'string' && typeof code !== 'string')) {
    return NextResponse.json({ error: 'idToken_or_code_and_nonce_required' }, { status: 400 });
  }
  if (typeof code === 'string' && !googleCodeFlowConfigured()) {
    // Absence of the secret is a CONFIGURATION state, not a client error: the browser
    // should fall back to the rendered button rather than show the reader a failure.
    return NextResponse.json({ error: 'code_flow_not_configured' }, { status: 501 });
  }

  // F-L11: consume the server-issued single-use `login` nonce FIRST. A captured Google
  // ID token was replayable for its ~1h validity because nothing tied it to a
  // server-side single-use value (unlike BTC/EVM, which consume a challenge). Consuming
  // here means a replay presents a spent nonce and is refused before the token is even
  // read; the identity.nonce echo check below binds THIS token to THIS challenge.
  const consumed = await consumeChallenge(nonce, 'login');
  if (!consumed) {
    return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
  }

  let identity;
  try {
    identity =
      typeof code === 'string'
        ? await verifyGoogleAuthCode(code)
        : await verifyGoogleIdToken(idToken as string);
  } catch (error) {
    logger.error(error, 'Google ID token verification failed');
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (!identity.emailVerified) {
    return NextResponse.json({ error: 'email_not_verified' }, { status: 401 });
  }
  // The token MUST echo the nonce we just issued (OIDC `nonce` claim), or a token
  // obtained for a different nonce could be presented against a freshly-consumed one.
  if (identity.nonce !== nonce) {
    return NextResponse.json({ error: 'nonce_mismatch' }, { status: 401 });
  }

  try {
    const ciphertext = encryptEmail(identity.email);
    const result = await resolveLogin('google_passkey', identity.sub, {
      emailCiphertextB64: ciphertext?.toString('base64'),
      emailHash: emailHash(identity.email)
    });
    if (result.status === 'error') {
      return NextResponse.json({ error: result.code }, { status: result.httpStatus }); // F-L27: 403 refusal, not 500
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite Google login resolution failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
