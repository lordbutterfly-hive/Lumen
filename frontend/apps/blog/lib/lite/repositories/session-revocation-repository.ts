import { query } from '../db/pool';

/**
 * Per-DEVICE session revocation — the half of F-L3 that was missing.
 *
 * `lumen_user.session_epoch` revokes an ACCOUNT: every cookie at once. That is
 * exactly right for "sign out everywhere", and exactly wrong for "sign out",
 * which in this product means one device — and which is what the sign-out button
 * has always called (`use-sign-out.tsx` -> POST /api/lite/auth/logout). Bumping
 * the account counter there is the long-standing "epoch drift": one tab signing
 * out silently signed out every other tab, phone and laptop.
 *
 * Sessions issued from now on carry a random `sessionId` in the cookie. Signing
 * out records that ONE id here; every acting request refuses a cookie whose id is
 * listed. The account-wide epoch is left to the jobs it was built for: logout-all,
 * suspend/ban, upgrade.
 *
 * ★ WHY A DENY-LIST. See 0034_session_revocation.sql — an allow-list of live
 * sessions signs users out whenever a write is lost or a prune misfires, which is
 * the failure this codebase has already had to revert once. The deny-list's window
 * is bounded by the cookie's own 14-day seal life.
 */

/** Well past the 14-day cookie TTL: a forgotten row can only be forgotten once the cookie it revokes is unusable anyway. */
const PRUNE_AFTER_DAYS = 30;

/**
 * Record that one session id may no longer act.
 *
 * Idempotent, and it prunes on the way past — revocation is a rare, explicit user
 * action, so this is the cheapest place to keep the table small without a cron.
 * Throws on failure: the caller MUST NOT report a successful sign-out for a
 * revocation that was not written.
 */
export async function revokeSessionId(userId: string, sessionId: string): Promise<void> {
  await query(
    `INSERT INTO lumen_revoked_session (session_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO NOTHING`,
    [sessionId, userId]
  );
  await query(`DELETE FROM lumen_revoked_session WHERE revoked_at < now() - $1::interval`, [
    `${PRUNE_AFTER_DAYS} days`
  ]);
}

/**
 * Has this session been signed out?
 *
 * Keyed on the id AND the user: the id alone is the primary key, but a session
 * cookie asserts both, and refusing to answer about a (id, user) pair that was
 * never issued together costs one predicate.
 */
export async function isSessionRevoked(userId: string, sessionId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM lumen_revoked_session WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows.length > 0;
}

/**
 * Forget every per-device revocation for one account.
 *
 * Called after a `logout-all` epoch bump: the epoch now refuses every cookie
 * issued before it, so the individual rows can no longer refuse anything — and
 * leaving them would let one id keep blocking a session id that some future
 * cookie could (astronomically improbably) reuse. Purely janitorial; never the
 * revocation itself.
 */
export async function forgetRevocations(userId: string): Promise<void> {
  await query(`DELETE FROM lumen_revoked_session WHERE user_id = $1`, [userId]);
}
