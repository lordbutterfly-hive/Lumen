import { User } from '@smart-signer/types/common';
import { enforceFollowRate, enforceHiveFollowRate } from '../antispam/rate-limit';
import { checkLiteActorById } from '../auth/account-status';
import * as follows from '../repositories/follow-repository';
import * as users from '../repositories/user-repository';
import { FollowActor, resolveFollowTarget, sameActor, sessionActor } from './follow-actor';

/**
 * Following on Lumen, for whichever tier the two people are.
 *
 * The routes were lite-only in both directions, which left a lite user unable to
 * follow a real Hive account and a Hive user unable to follow a lite one. Neither of
 * those can be a chain follow — one side has no key, the other has no account — so
 * both belong here.
 *
 * A suspended lite account may not add a follow (participation) but may always remove
 * one (withdrawal), which is the same distinction `http/actor.ts` draws elsewhere.
 */

export type FollowOutcome =
  | { ok: true; following: boolean; changed: boolean }
  | { ok: false; status: number; error: string };

/**
 * Lumen only records a follow the chain cannot: if BOTH sides own Hive accounts, the
 * follow belongs on chain, and quietly writing it here as well would create a
 * relationship only Lumen can see — invisible everywhere else, and diverging the
 * moment the user follows or unfollows from another front end.
 */
function belongsOnLumen(viewerIsKeyless: boolean, targetIsLite: boolean): boolean {
  return viewerIsKeyless || targetIsLite;
}

/**
 * Does this viewer have Hive keys of their own?
 *
 * Read from the DATABASE, never the cookie. Upgrading does not rewrite the session, so
 * a freshly upgraded user still presents `account_tier: 'lite'` for two weeks — and
 * judging by that wrote their follows of REAL Hive accounts into our table instead of
 * on chain: invisible to every other front end, and diverging the moment they follow
 * from one.
 */
async function viewerIsKeyless(
  sessionUser: User | undefined,
  actor: FollowActor
): Promise<boolean> {
  if (sessionUser?.account_tier !== 'lite') return false;
  if (!actor.userId) return false;
  const row = await users.findUserById(actor.userId);
  return !row?.hiveAccountName && row?.accountTier !== 'full';
}

/**
 * Rate limit for whichever kind of actor this is. A Lumen account is scored by trust
 * and age; a Hive login has no such row, so it gets its own flat counter keyed on the
 * name — which is safe, because that name was proved by a signed challenge at login.
 */
function allowFollowAction(actor: FollowActor): Promise<boolean> {
  return actor.userId ? enforceFollowRate(actor.userId) : enforceHiveFollowRate(actor.hive ?? '');
}

async function actorFor(
  sessionUser: User | undefined,
  requireActive: boolean
): Promise<{ ok: true; actor: FollowActor } | { ok: false; status: number; error: string }> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return { ok: false, status: 401, error: 'unauthorized' };

  // A Hive login is already authenticated by a signed challenge and has no Lumen row
  // to check — the status model only applies to accounts we host.
  if (!actor.userId) return { ok: true, actor };

  if (!requireActive) return { ok: true, actor };
  // Checked by USER ID, not by the cookie's tier. An upgraded user signs in with their
  // own Hive keys, so their session has no lite tier at all — checking the cookie
  // rejected every one of them with a bare 401 while their unfollow still worked.
  // `allowUpgraded`: an upgraded user still needs this path, because a lite account has
  // no on-chain identity to follow — there is no keyed alternative for them to use.
  const check = await checkLiteActorById(actor.userId, { allowUpgraded: true });
  if (!check.ok) return { ok: false, status: check.status, error: check.code };
  return { ok: true, actor };
}

export async function followByName(
  sessionUser: User | undefined,
  targetName: string
): Promise<FollowOutcome> {
  const from = await actorFor(sessionUser, true);
  if (!from.ok) return from;

  // Charged BEFORE the target is resolved, because resolving hits a Hive API node for
  // any name we do not already know. Limiting afterwards meant a loop of nonsense names
  // never consumed a single unit while spending one upstream request each — the same
  // free-ammunition hole that was closed for the name-availability endpoint.
  if (!(await allowFollowAction(from.actor))) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  const target = await resolveFollowTarget(targetName);
  if (!target.ok) return { ok: false, status: 404, error: target.error };
  if (sameActor(from.actor, target.actor)) {
    return { ok: false, status: 400, error: 'cannot_follow_self' };
  }
  if (!belongsOnLumen(await viewerIsKeyless(sessionUser, from.actor), target.isLite)) {
    return { ok: false, status: 400, error: 'use_chain_follow' };
  }

  const changed = await follows.follow(from.actor, target.actor);
  return { ok: true, following: true, changed };
}

export async function unfollowByName(
  sessionUser: User | undefined,
  targetName: string
): Promise<FollowOutcome> {
  const from = await actorFor(sessionUser, false);
  if (!from.ok) return from;

  // FOLLOW-RECSYS-1: unfollow is capped too — it was not, so follow/unfollow churn
  // could spam the recsys edge feed. Charged before the chain lookup, as above.
  if (!(await allowFollowAction(from.actor))) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  const target = await resolveFollowTarget(targetName);
  if (!target.ok) return { ok: false, status: 404, error: target.error };
  if (!belongsOnLumen(await viewerIsKeyless(sessionUser, from.actor), target.isLite)) {
    return { ok: false, status: 400, error: 'use_chain_follow' };
  }

  await follows.unfollow(from.actor, target.actor);
  return { ok: true, following: false, changed: true };
}

export interface FollowState {
  /** True when this pair is a Lumen follow rather than an on-chain one. */
  lumenEdge: boolean;
  following: boolean;
}

/**
 * Whether the viewer follows this person on Lumen, and whether Lumen is where that
 * follow belongs at all.
 *
 * The second answer is what the button needs: for two Hive accounts the chain owns
 * the relationship and this must stay out of the way, but the moment either side is a
 * lite account, the chain cannot represent it and we do.
 */
export async function followState(
  sessionUser: User | undefined,
  targetName: string
): Promise<FollowState> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return { lumenEdge: false, following: false };

  const target = await resolveFollowTarget(targetName);
  if (!target.ok) return { lumenEdge: false, following: false };

  const lumenEdge = belongsOnLumen(await viewerIsKeyless(sessionUser, actor), target.isLite);
  if (!lumenEdge) return { lumenEdge: false, following: false };
  if (sameActor(actor, target.actor)) return { lumenEdge, following: false };

  return { lumenEdge, following: await follows.isFollowing(actor, target.actor) };
}
