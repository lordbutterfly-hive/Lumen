import { User } from '@smart-signer/types/common';
import * as users from '../repositories/user-repository';
import { isSessionRevoked } from '../repositories/session-revocation-repository';
import { LumenUser, SessionRef } from '../types';

/**
 * "Is this session still allowed to act?" — checked against the DB, not the cookie.
 *
 * Login already refuses a suspended or banned account (auth/auth-service.ts), but a
 * session issued BEFORE the suspension keeps working for as long as the cookie lives:
 * every write path trusted `account_tier` alone, so suspending an account did not
 * stop the account. That made `lumen_user.status` decorative — the value could be
 * written but changed nothing.
 *
 * One extra read per write. Every one of these paths already touches the database,
 * and a moderation decision that only applies at next login is not a moderation
 * decision.
 */

/** Why a session may not act. Split out so a refusal-only return type is expressible. */
export type ActorRefusal = { ok: false; status: number; code: string; message: string };

export type ActorCheck = { ok: true; user: LumenUser } | ActorRefusal;

const MESSAGES: Record<string, string> = {
  suspended: 'This account is suspended.',
  banned: 'This account has been banned.',
  upgraded: 'This account is now a full Hive account — sign in with your own keys.'
};

/**
 * THE one place that decides whether a presented cookie is still a live session.
 *
 * Two independent revocations, and they answer different questions:
 *
 *   ACCOUNT-WIDE (`session_epoch`) — "every cookie for this account is void."
 *   Bumped by logout-all, suspend/ban and upgrade. F-L3.
 *
 *   PER-DEVICE (`sessionId`) — "this one cookie is void." Written by an ordinary
 *   sign-out, which is a per-DEVICE action in this product and must not take the
 *   user's other devices with it (0034_session_revocation.sql).
 *
 * Both are compared against the DATABASE, never against the cookie's own claims.
 *
 * @returns the refusal, or null when the cookie is still good.
 */
export async function checkSessionValidity(user: LumenUser, ref: SessionRef): Promise<ActorRefusal | null> {
  // ★★ 2026-08-08: "undefined = a legacy cookie; skip" WAS THE BYPASS. Skipping
  // means a cookie with no stamp is exempt from revocation entirely — and that is
  // precisely the cookie a revoked session carries once it predates the stamping.
  // Proven on the sibling path in `http/actor.ts`: a no-epoch cookie for a user
  // whose stored epoch was 6 wrote a real `lumen_follow` row.
  //
  // Comparing against `?? 0` keeps the backward compatibility the old comment was
  // reaching for WITHOUT the hole: `session_epoch` is `NOT NULL DEFAULT 0`, so a
  // never-revoked user reads 0, a stampless cookie reads 0, and they still match.
  // Only a user who has actually revoked (>= 1) now refuses the stampless cookie,
  // which is the entire point of having revoked.
  if (user.sessionEpoch !== (ref.sessionEpoch ?? 0)) {
    return { ok: false, status: 401, code: 'session_revoked', message: 'Please sign in again.' };
  }
  // No id = a cookie issued before per-device revocation existed. There is nothing
  // to look up, and the epoch above has already spoken; refusing here would sign
  // out every outstanding session on deploy, which is the failure this subsystem
  // has already had to revert once. They age out within the 14-day cookie life.
  if (ref.sessionId && (await isSessionRevoked(user.userId, ref.sessionId))) {
    return { ok: false, status: 401, code: 'session_revoked', message: 'Please sign in again.' };
  }
  return null;
}

/**
 * @param ref  The caller's cookie: the epoch stamped at issue and the per-device id.
 *   Compared against the live row by {@link checkSessionValidity}. Routes pass their
 *   iron `session` straight in — it satisfies the shape.
 */
export async function checkLiteActor(
  sessionUser: User | undefined,
  ref: SessionRef,
  options: { allowUpgraded?: boolean } = {}
): Promise<ActorCheck> {
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
  return checkLiteActorById(sessionUser.userId, { ...ref, ...options });
}

/**
 * @param options.allowUpgraded  Permit an account that now owns a real Hive account.
 *   Default FALSE, which is the safe answer for anything that acts THROUGH the shared
 *   publishing account (posting, voting, reblogging): once a user has their own keys,
 *   those actions must be signed by them, not proxied by us. Set true only for
 *   Lumen-local records that have no on-chain equivalent — following a lite user is the
 *   one real case, since there is nothing on chain to follow.
 */
export async function checkLiteActorById(
  userId: string,
  options: { allowUpgraded?: boolean } & SessionRef = {}
): Promise<ActorCheck> {
  const user = await users.findUserById(userId);
  // The row is gone but the cookie is not: treat as signed out rather than 500.
  if (!user) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'Account not found.' };
  }
  // Revocation — account-wide and per-device — is checked BEFORE the upgrade/status
  // branches so a dead cookie gets the honest "sign in again" rather than a stale
  // upgraded/suspended message.
  const revoked = await checkSessionValidity(user, options);
  if (revoked) return revoked;
  // ★ Judged from the DATABASE, not the cookie. Upgrading does not rewrite the session,
  // so a freshly upgraded user's cookie still says `account_tier: 'lite'` for its full
  // 14-day life. Without this they keep proxy-posting through the shared account —
  // spending its Resource Credits, its 3-second reply interval and its container slots
  // — while their posts render under their REAL Hive name, i.e. content signed by our
  // account presented as authored by a real on-chain identity.
  if (!options.allowUpgraded && (user.accountTier === 'full' || user.hiveAccountName)) {
    return {
      ok: false,
      status: 403,
      code: 'account_upgraded',
      message: MESSAGES.upgraded
    };
  }
  // 'upgraded' is a status, not a punishment: when the caller has said this action has
  // no on-chain equivalent, it must not be treated like a suspension.
  const upgradedButAllowed = options.allowUpgraded && user.status === 'upgraded';
  if (user.status !== 'active' && !upgradedButAllowed) {
    return {
      ok: false,
      // 403, not 401: the session is valid, the account is not permitted to act.
      // A 401 would send the client into a re-login loop that can never succeed.
      status: 403,
      code: `account_${user.status}`,
      message: MESSAGES[user.status] ?? 'This account cannot post right now.'
    };
  }
  return { ok: true, user };
}
