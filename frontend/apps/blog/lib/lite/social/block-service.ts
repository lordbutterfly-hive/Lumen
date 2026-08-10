import { User } from '@smart-signer/types/common';
import { enforceBlockRate, enforceHiveBlockRate } from '../antispam/rate-limit';
import { checkLiteActorById, checkSessionValidity } from '../auth/account-status';
import * as blocks from '../repositories/block-repository';
import * as users from '../repositories/user-repository';
import { isBannedAuthor } from '@/blog/lib/moderation/banned-authors';
import { FollowActor, sameActor, sessionActor } from './follow-actor';
import { BlockTargetKind, resolveBlockTarget } from './block-actor';
import { SessionRef } from '../types';

/**
 * ★★★ BLOCKING ON LUMEN.
 *
 * Two effects, and the second one is why this is a new mechanism rather than a
 * re-use of Hive's mute:
 *
 *   (A) VIEWER-SIDE — I never see the blocked account again, in any feed or thread.
 *   (B) OWNER-SIDE  — their comments UNDER MY CONTENT stop being served to EVERY
 *       reader, not just to me.
 *
 * =====================================================================
 * DESIGN DECISION: A FULL HIVE ACCOUNT'S BLOCK DOES **NOT** ALSO WRITE
 * THE ON-CHAIN `ignore` (mute) CUSTOM_JSON. IT IS LUMEN-LOCAL FOR BOTH
 * TIERS. The owner should overrule this if they disagree.
 * =====================================================================
 *
 * Four reasons, in order of weight:
 *
 *  1. AN ON-CHAIN MUTE CANNOT EXPRESS EFFECT (B). Hive's `ignore` is a per-viewer
 *     preference: every front end reads it as "hide this person FROM ME". There is
 *     no on-chain object that says "hide this person's replies under my post from
 *     EVERYONE". So broadcasting one would record a strictly weaker promise than the
 *     button makes — and the half it does record is the half we already implement
 *     locally.
 *  2. ONE BUTTON MUST MEAN ONE THING. A lite account has no key and can never sign a
 *     mute. If a full account's block also went on chain, the same control would have
 *     different reach, different persistence and different reversibility depending on
 *     which tier pressed it, and only one of the two could ever be undone from
 *     another front end. That is the kind of split that produces "I blocked them and
 *     they are still there" reports nobody can reproduce.
 *  3. A CHAIN WRITE IS NOT OURS TO MAKE. `ignore` is a public, permanent, signed
 *     statement broadcast under the user's own name to every Hive front end. Pressing
 *     a Lumen product control should not publish anything on the user's behalf
 *     unless they asked for exactly that. Lumen's existing on-chain Mute button is
 *     still there for anyone who wants the chain-wide version, and it is unchanged.
 *  4. IT WOULD NEED A SIGNER IN THE BROWSER. Blocking would then fail for the
 *     Keychain-less half of full accounts, and would be unavailable from any
 *     server-side path — including moderation tooling.
 *
 * The cost of this decision, stated plainly: a Lumen block is invisible to other Hive
 * front ends. Somebody reading the same thread on a different site still sees the
 * blocked comment. That is unavoidable — no chain operation exists that would hide
 * it there either — and it is exactly why (B) is enforced where WE serve the thread.
 *
 * A suspended lite account may still block (self-protection is withdrawal, not
 * participation) and may always unblock.
 */

export type BlockOutcome =
  | { ok: true; blocked: boolean; changed: boolean }
  | { ok: false; status: number; error: string };

/**
 * Rate limit for whichever kind of actor this is — its own bucket, never the follow
 * one (see `antispam/rate-limit.ts`).
 */
function allowBlockAction(actor: FollowActor): Promise<boolean> {
  return actor.userId ? enforceBlockRate(actor.userId) : enforceHiveBlockRate(actor.hive ?? '');
}

/**
 * Who is acting, and may they act.
 *
 * Modelled on `follow-service.actorFor`, with the SAME epoch rule and for the same
 * reason: the epoch check sits ABOVE the status exemption, so a revoked cookie cannot
 * mutate this table even on the withdrawal path. What differs is `requireActive`:
 * blocking is never refused for a suspended account. A suspended user is still
 * entitled to stop somebody following them around, and a block only ever REMOVES
 * content — it cannot be used to spam.
 */
async function actorFor(
  sessionUser: User | undefined,
  session: SessionRef
): Promise<{ ok: true; actor: FollowActor } | { ok: false; status: number; error: string }> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return { ok: false, status: 401, error: 'unauthorized' };

  // A Hive login is authenticated by a signed challenge and has no Lumen row.
  if (!actor.userId) return { ok: true, actor };

  const row = await users.findUserById(actor.userId);
  if (!row) return { ok: false, status: 401, error: 'session_revoked' };
  // Account-wide epoch AND this device's own sign-out, in the one shared check.
  const revoked = await checkSessionValidity(row, session);
  if (revoked) return { ok: false, status: revoked.status, error: revoked.code };
  // Banned accounts are refused outright; everything else — including `suspended` —
  // may block. `checkLiteActorById` is still consulted so a DELETED/unknown actor is
  // caught by the same code path every other write uses.
  const check = await checkLiteActorById(actor.userId, { allowUpgraded: true, ...session });
  if (!check.ok && check.code !== 'account_suspended') {
    return { ok: false, status: check.status, error: check.code };
  }
  return { ok: true, actor };
}

export async function blockByName(
  sessionUser: User | undefined,
  targetName: string,
  kind: BlockTargetKind,
  session: SessionRef
): Promise<BlockOutcome> {
  const from = await actorFor(sessionUser, session);
  if (!from.ok) return from;

  // A globally banned chain account writes nothing into Lumen's graphs — same rule
  // `follow-service` applies, and for the same reason: his rows would consume rate
  // budget, `seq` space and, here, would let him delete other people's comments from
  // threads under content nobody can even see.
  if (isBannedAuthor(from.actor.hive)) {
    return { ok: false, status: 403, error: 'account_banned' };
  }

  // Charged BEFORE resolution, because resolving an unknown name costs a Hive API
  // call — the same free-ammunition hole `follow-service` closed.
  if (!(await allowBlockAction(from.actor))) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  const target = await resolveBlockTarget(targetName, kind);
  if (!target.ok) return { ok: false, status: 404, error: target.error };
  if (sameActor(from.actor, target.actor)) {
    return { ok: false, status: 400, error: 'cannot_block_self' };
  }

  // ★ NO `belongsOnLumen` GATE HERE, and that is the deliberate difference from
  // following. A follow between two Hive accounts belongs on chain, so Lumen refuses
  // to record it. A BLOCK between two Hive accounts has nowhere else to live: the
  // chain has no way to express effect (B), so refusing it would leave the largest
  // pairing — two full accounts — with a button that does nothing. All four
  // directions are recorded here.
  const changed = await blocks.block(from.actor, target.actor);
  return { ok: true, blocked: true, changed };
}

export async function unblockByName(
  sessionUser: User | undefined,
  targetName: string,
  kind: BlockTargetKind,
  session: SessionRef
): Promise<BlockOutcome> {
  const from = await actorFor(sessionUser, session);
  if (!from.ok) return from;

  if (!(await allowBlockAction(from.actor))) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  const target = await resolveBlockTarget(targetName, kind);
  if (!target.ok) return { ok: false, status: 404, error: target.error };

  await blocks.unblock(from.actor, target.actor);
  return { ok: true, blocked: false, changed: true };
}

export interface BlockState {
  /** Whether a Block control should be offered at all (someone is signed in). */
  available: boolean;
  blocking: boolean;
}

export async function blockState(
  sessionUser: User | undefined,
  targetName: string,
  kind: BlockTargetKind
): Promise<BlockState> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return { available: false, blocking: false };

  const target = await resolveBlockTarget(targetName, kind);
  if (!target.ok) return { available: false, blocking: false };
  if (sameActor(actor, target.actor)) return { available: false, blocking: false };

  return { available: true, blocking: await blocks.isBlocked(actor, target.actor) };
}

/** The viewer's own block list, as stable node keys — for the read-side filters. */
export async function viewerBlockedKeys(sessionUser: User | undefined): Promise<string[]> {
  const actor = await sessionActor(sessionUser);
  if (!actor) return [];
  return blocks.listBlockedKeysOf(actor);
}

/** The same list in the ranker's identity space — handed to recsys as `?mutes=`. */
export async function viewerBlockedIdentities(sessionActorValue: FollowActor | null): Promise<string[]> {
  if (!sessionActorValue) return [];
  return blocks.listBlockedIdentitiesOf(sessionActorValue);
}
