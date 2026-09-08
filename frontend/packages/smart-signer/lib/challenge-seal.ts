import { sealData, unsealData } from 'iron-session';

/**
 * SMS-01 (2026-09-08): the "server half" of the login challenge
 * (`${cookieNamePrefix}login_challenge_server`) used to be a plain,
 * unauthenticated value written by the middleware and read back verbatim by
 * `login.ts`. `req.cookies` is parsed from the caller's own `Cookie` header, so
 * a non-browser client sent whatever value it liked and supplied BOTH halves of
 * the challenge comparison — the freshness check was vacuous. `httpOnly` stops a
 * browser script from READING the cookie; it does nothing to stop `curl` from
 * WRITING one.
 *
 * The fix is to make the server half a value the caller cannot mint: it is now
 * SEALED (authenticated encryption via iron-session, the same primitive that
 * already protects the session cookie — see `session.ts`). The middleware seals
 * it at issue; `login.ts` unseals it before comparing. An attacker cannot forge
 * a seal without `DENSER_SERVER_SECRET_COOKIE_PASSWORD`, so the challenge is
 * once again something only the server can vouch for.
 *
 * The JS-visible client half (`${cookieNamePrefix}login_challenge`, read by
 * `ensure-login-challenge.ts` / `process.tsx` to build the op the wallet signs)
 * stays plaintext and unchanged — the client legitimately needs its value.
 */

// A version tag sealed into the payload gives domain separation from the
// session seal (which reuses the same password): a session cookie fed to
// `unsealLoginChallenge` has no `challenge`/`v` and is rejected, and vice versa.
const CHALLENGE_SEAL_VERSION = 'login-challenge.v1';

// iron-session's `Fe26.2` token prefix. The middleware uses it as a cheap,
// crypto-free "is this already sealed?" test so it can transparently re-mint the
// legacy plaintext cookies visitors still hold across the deploy of this fix,
// without an unseal on every request. Exported so the minter and this module
// agree on one constant.
export const IRON_SEAL_PREFIX = 'Fe26.2';

/**
 * Seal TTL in SECONDS (iron-session's unit). 0 disables the seal's own expiry,
 * which is the default here: the real time bound on a captured login proof is
 * the transaction's own `expiration` (checked in `login.ts`, ~1h), and the
 * challenge cookie pair is a browser session cookie that the middleware re-mints
 * whenever either half is missing. An operator may set a positive value, but
 * note a TTL shorter than the tab's lifetime can reject a legitimate late login
 * whose (still-present) cookie has crypto-expired.
 */
const rawTtl = Number(process.env.LOGIN_CHALLENGE_TTL_SECONDS);
export const LOGIN_CHALLENGE_TTL_SECONDS =
  Number.isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : 0;

function challengeSealPassword(): string {
  const password = process.env.DENSER_SERVER_SECRET_COOKIE_PASSWORD;
  if (!password) {
    // Same precondition the session seal already relies on; fail loudly rather
    // than silently sealing under `undefined`.
    throw new Error('DENSER_SERVER_SECRET_COOKIE_PASSWORD is not set; cannot seal login challenge');
  }
  return password;
}

/**
 * Seal a login challenge for the `login_challenge_server` cookie. Async because
 * iron-session/iron-webcrypto is async (and edge-runtime compatible, which the
 * middleware needs).
 */
export async function sealLoginChallenge(challenge: string): Promise<string> {
  return sealData(
    { v: CHALLENGE_SEAL_VERSION, challenge },
    { password: challengeSealPassword(), ttl: LOGIN_CHALLENGE_TTL_SECONDS }
  );
}

/**
 * Recover the challenge from a sealed cookie value. Returns '' for anything that
 * is missing, not a valid seal, tampered, forged, expired, or not one of OUR
 * login-challenge seals. The caller compares the result to the challenge carried
 * in the signed transaction; '' never matches a real (truthy) challenge, so a
 * forged or absent cookie is rejected by the existing comparison.
 */
export async function unsealLoginChallenge(sealed: string): Promise<string> {
  if (!sealed) return '';
  try {
    const data = await unsealData<{ v?: string; challenge?: string }>(sealed, {
      password: challengeSealPassword(),
      ttl: LOGIN_CHALLENGE_TTL_SECONDS
    });
    if (!data || data.v !== CHALLENGE_SEAL_VERSION || typeof data.challenge !== 'string') {
      return '';
    }
    return data.challenge;
  } catch {
    // iron-session returns {} on a bad seal rather than throwing, but guard
    // anyway: a malformed cookie must never become a 500.
    return '';
  }
}
