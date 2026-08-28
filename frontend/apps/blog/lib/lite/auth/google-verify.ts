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

/**
 * Exchange an OAuth authorization CODE for Google's ID token, then verify it with
 * the exact same check `verifyGoogleIdToken` already applies.
 *
 * ★ WHY THIS EXISTS (2026-08-28, owner decision). Google Identity Services refuses
 * to act on a click when its rendered button is transparent, transformed or clipped
 * — anti-clickjacking, and silent. That killed the previous design, where a
 * Lumen-styled row sat over an invisible GSI button. The owner wants Lumen's own
 * button back, so the flow has to be driven by us rather than by GSI's iframe, and
 * `initCodeClient` hands back a code instead of an ID token.
 *
 * ★ THE NONCE BINDING IS NOT LOST. The exchanged response still contains a real
 * Google-signed `id_token`, so it goes through `verifyGoogleIdToken` unchanged and
 * the `nonce` claim (XC-2) is still checked against the server-issued challenge.
 * That was the one property worth protecting in this change, and it survives.
 *
 * Requires `LITE_GOOGLE_CLIENT_SECRET`. Callers must treat its absence as "code
 * flow not configured" and fall back, never as an error — see the route.
 */
export function googleCodeFlowConfigured(): boolean {
  return Boolean(process.env.LITE_GOOGLE_CLIENT_ID && process.env.LITE_GOOGLE_CLIENT_SECRET);
}

export async function verifyGoogleAuthCode(code: string): Promise<GoogleIdentity> {
  const id = process.env.LITE_GOOGLE_CLIENT_ID;
  const secret = process.env.LITE_GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Google code flow is not configured (client id or secret missing)');
  }
  // 'postmessage' is the redirect_uri GIS uses for the popup code flow; it is not a
  // real URL and must NOT be added to the console's redirect list.
  const exchange = new OAuth2Client(id, secret, 'postmessage');
  const { tokens } = await exchange.getToken(code);
  if (!tokens.id_token) {
    throw new Error('Google code exchange returned no id_token');
  }
  return verifyGoogleIdToken(tokens.id_token);
}
