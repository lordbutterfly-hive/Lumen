import { apiHandler } from '@smart-signer/lib/api';
import { getUser } from '@smart-signer/lib/api-handlers/users/me';

/**
 * ★ NO SESSION-REVOCATION CHECK HERE, DELIBERATELY.
 *
 * One was added 2026-08-08 and reverted the same day: this endpoint decides what
 * the whole app believes about who you are, so any condition that makes it say
 * "logged out" signs a real person out everywhere at once.
 *
 * The security property holds without it — every route that MUTATES anything
 * (`requireLiteUser` / `checkLiteActorById`) compares the epoch itself and
 * refuses a revoked cookie with 401. A revoked session can still READ as signed
 * in, which is a cosmetic lie, but it can no longer DO anything.
 *
 * Re-landing it needs the epoch drift reproduced and understood first — why a
 * valid session's stamped epoch stops matching its row. Still unknown.
 */
export default apiHandler({
  GET: getUser
});
