import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { verifyGoogleIdToken } from '@/blog/lib/lite/auth/google-verify';
import { encryptEmail, emailHash } from '@/blog/lib/lite/auth/email-crypto';
import { resolveLogin } from '@/blog/lib/lite/auth/auth-service';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/google  — { idToken }
 * Verifies the Google ID token server-side, then resolves to an existing
 * account (session) or flags `needs_name` for first-time sign-up.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const idToken = body?.idToken;
  if (typeof idToken !== 'string') {
    return NextResponse.json({ error: 'idToken_required' }, { status: 400 });
  }

  let identity;
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (error) {
    logger.error(error, 'Google ID token verification failed');
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }
  if (!identity.emailVerified) {
    return NextResponse.json({ error: 'email_not_verified' }, { status: 401 });
  }

  try {
    const ciphertext = encryptEmail(identity.email);
    const result = await resolveLogin('google_passkey', identity.sub, {
      emailCiphertextB64: ciphertext?.toString('base64'),
      emailHash: emailHash(identity.email)
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite Google login resolution failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
