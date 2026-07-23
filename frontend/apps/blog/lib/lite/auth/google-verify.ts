import { OAuth2Client } from 'google-auth-library';

/**
 * Server-side Google ID-token verification — the ROOT OF TRUST for Google
 * sign-in (spec §A.3). `verifyIdToken` checks the token's signature against
 * Google's public keys and validates `aud` (our client id), `iss`
 * (accounts.google.com) and `exp`. We deliberately do NOT reuse Altera's
 * client-side `parseIdToken`, which never verified the signature.
 */

const clientId = process.env.LITE_GOOGLE_CLIENT_ID || '';
const client = new OAuth2Client(clientId);

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** The OIDC `nonce` claim, echoed from the sign-in request — used to bind a
   *  bind/step-up request to a server-issued nonce (XC-2, PRUNED 2026-07-22). */
  nonce: string | null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!clientId) {
    throw new Error('LITE_GOOGLE_CLIENT_ID is not configured');
  }
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error('Google ID token missing subject');
  }
  return {
    sub: payload.sub,
    email: (payload.email ?? '').toLowerCase(),
    emailVerified: payload.email_verified === true,
    nonce: payload.nonce ?? null
  };
}
