import { query } from '../db/pool';
import { FollowActor, actorKey, sameActor } from '../social/follow-actor';

/**
 * Lumen's block graph (migration 0030).
 *
 * A block is stored exactly like a follow edge — see `social/follow-actor.ts` — so
 * every one of the four tier combinations is representable and a Lumen account is
 * identified by its `user_id`, which survives an upgrade to a real Hive account. A
 * block written against a lite account therefore still binds after that account
 * becomes a Hive one, which is the whole point: an upgrade must not be a way to walk
 * out of everybody's block list.
 *
 * TWO CONSUMERS, AND THEY ASK DIFFERENT QUESTIONS:
 *
 *   (A) "who has THIS VIEWER blocked" — one viewer, whole list, once per feed
 *       request. `listBlockedKeysOf` / `listBlockedIdentitiesOf`.
 *   (B) "did any of THESE thread ancestors block any of THESE comment authors" —
 *       many-to-many, once per comment thread. `blockedPairsAmong`, one query for
 *       the whole page, because a query per comment would be a thread-sized fan-out
 *       on the hottest read in the product.
 *
 * Edges are SOFT-deleted (`active = false`) with a re-drawn `seq`, the same rule
 * `lumen_follow` follows: a consumer reading a cursor feed has to be able to observe
 * the RETRACTION, and a hard delete gives it nothing to observe.
 */

// The BIGSERIAL sequence behind `seq`, re-drawn on every state change so an edge
// that changes state re-surfaces at the end of a cursor feed.
const NEXT_SEQ = `nextval(pg_get_serial_sequence('lumen_block', 'seq'))`;

/** The four column values for one edge, in insert order. */
function edgeParams(blocker: FollowActor, blocked: FollowActor) {
  return [
    blocker.userId ?? null,
    blocker.hive ?? null,
    blocked.userId ?? null,
    blocked.hive ?? null
  ];
}

/** @returns true when this call actually changed the state (new or re-activated). */
export async function block(blocker: FollowActor, blocked: FollowActor): Promise<boolean> {
  if (sameActor(blocker, blocked)) return false;
  const { rowCount } = await query(
    `INSERT INTO lumen_block (blocker_user_id, blocker_hive, blocked_user_id, blocked_hive)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (blocker_key, blocked_key)
       DO UPDATE SET active = true, seq = ${NEXT_SEQ}, created_at = now()
       WHERE lumen_block.active = false`,
    edgeParams(blocker, blocked)
  );
  return (rowCount ?? 0) > 0;
}

export async function unblock(blocker: FollowActor, blocked: FollowActor): Promise<void> {
  await query(
    `UPDATE lumen_block SET active = false, seq = ${NEXT_SEQ}
       WHERE blocker_key = $1 AND blocked_key = $2 AND active = true`,
    [actorKey(blocker), actorKey(blocked)]
  );
}

export async function isBlocked(blocker: FollowActor, blocked: FollowActor): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM lumen_block WHERE blocker_key = $1 AND blocked_key = $2 AND active`,
    [actorKey(blocker), actorKey(blocked)]
  );
  return rows.length > 0;
}

/**
 * Every node this actor has blocked, as stable `u:`/`h:` keys.
 *
 * This is what a served-entry filter matches against, so it is deliberately the KEY
 * and not a display name: a name can change (an upgrade, a handle edit) and a filter
 * keyed on names would quietly stop matching the moment it did.
 */
export async function listBlockedKeysOf(blocker: FollowActor, limit = 5000): Promise<string[]> {
  const { rows } = await query<{ blocked_key: string }>(
    `SELECT blocked_key FROM lumen_block
      WHERE blocker_key = $1 AND active = true
      ORDER BY seq DESC LIMIT $2`,
    [actorKey(blocker), limit]
  );
  return rows.map((r) => r.blocked_key);
}

/**
 * The same list in the identity the RANKER uses — a Lumen `user_id` where we have
 * one, the Hive account name otherwise.
 *
 * Handed to recsys as `?mutes=`, exactly as `listFolloweesOf` is handed over as
 * `?follows=`: recsys keys an author by `lumen_user_id` for a lite post and by the
 * Hive account for an ordinary one (`Post.chain_author`), so returning display names
 * here would match nothing for lite authors and silently rank a blocked person right
 * back into the feed.
 */
export async function listBlockedIdentitiesOf(blocker: FollowActor, limit = 5000): Promise<string[]> {
  const { rows } = await query<{ blocked: string | null }>(
    `SELECT COALESCE(blocked_user_id, blocked_hive::text) AS blocked
       FROM lumen_block
      WHERE blocker_key = $1 AND active = true
      ORDER BY seq DESC LIMIT $2`,
    [actorKey(blocker), limit]
  );
  return rows.map((r) => r.blocked).filter((b): b is string => Boolean(b));
}

export interface BlockEdgePeer {
  userId: string | null;
  hive: string | null;
}

/** The people behind the list — for a "Blocked accounts" settings screen. */
export async function listBlockedPeers(
  blocker: FollowActor,
  opts: { limit: number; before?: number } = { limit: 100 }
): Promise<BlockEdgePeer[]> {
  const { rows } = await query<{ blocked_user_id: string | null; blocked_hive: string | null }>(
    `SELECT blocked_user_id, blocked_hive::text AS blocked_hive
       FROM lumen_block
      WHERE blocker_key = $1 AND active = true
        AND ($2::bigint IS NULL OR seq < $2)
      ORDER BY seq DESC LIMIT $3`,
    [actorKey(blocker), opts.before ?? null, opts.limit]
  );
  return rows.map((r) => ({ userId: r.blocked_user_id, hive: r.blocked_hive }));
}

/** `blocker|blocked` — the key shape {@link blockedPairsAmong} returns. */
export function pairKey(blockerKey: string, blockedKey: string): string {
  return `${blockerKey}|${blockedKey}`;
}

/**
 * ★★★ EFFECT (B) IN ONE QUERY.
 *
 * Answers "which of these (ancestor, comment author) pairs is a live block" for a
 * whole comment thread at once. The caller collects the distinct authors in the
 * thread, asks once, and then filters the tree in memory.
 *
 * It has to be a many-to-many question because a thread has many owners: the root
 * post's author, and the author of every comment the reply hangs under. The owner's
 * rule is "a comment, reply or post made by the account that blocked them", so ANY
 * ancestor's block is enough to hide the reply.
 *
 * Both sides are bounded by the page being rendered, so this is one indexed scan
 * over at most a few hundred keys — not a per-comment lookup.
 */
export async function blockedPairsAmong(
  blockerKeys: string[],
  blockedKeys: string[]
): Promise<Set<string>> {
  if (blockerKeys.length === 0 || blockedKeys.length === 0) return new Set();
  const { rows } = await query<{ blocker_key: string; blocked_key: string }>(
    `SELECT blocker_key, blocked_key FROM lumen_block
      WHERE blocker_key = ANY($1::text[]) AND blocked_key = ANY($2::text[]) AND active`,
    [[...new Set(blockerKeys)], [...new Set(blockedKeys)]]
  );
  return new Set(rows.map((r) => pairKey(r.blocker_key, r.blocked_key)));
}

/**
 * Move every edge that names a Hive account onto the Lumen user who now owns that
 * name — called when a lite account upgrades, alongside the follow-graph equivalent.
 *
 * Unlike follows this is NOT a formality. Somebody can genuinely have blocked the
 * Hive name before its owner ever linked it to a Lumen account (they are two nodes
 * until the upgrade), and leaving the `h:` edge behind would release that block the
 * instant the upgrade landed — an upgrade would be a way out of everyone's block
 * list. Re-pointing keeps it binding.
 */
export async function absorbHiveActor(userId: string, hiveName: string): Promise<void> {
  const name = hiveName.toLowerCase();
  // Re-point what can be re-pointed; `seq` is re-drawn because the row now names a
  // different node and a cursor consumer has to re-observe it under the new key.
  await query(
    `UPDATE lumen_block SET blocker_user_id = $1, blocker_hive = NULL, seq = ${NEXT_SEQ}
       WHERE blocker_hive = $2
         AND NOT EXISTS (
           SELECT 1 FROM lumen_block existing
            WHERE existing.blocker_key = 'u:' || $1 AND existing.blocked_key = lumen_block.blocked_key
         )`,
    [userId, name]
  );
  await query(
    `UPDATE lumen_block SET blocked_user_id = $1, blocked_hive = NULL, seq = ${NEXT_SEQ}
       WHERE blocked_hive = $2
         AND NOT EXISTS (
           SELECT 1 FROM lumen_block existing
            WHERE existing.blocked_key = 'u:' || $1 AND existing.blocker_key = lumen_block.blocker_key
         )`,
    [userId, name]
  );
  // Whatever could not be re-pointed would have collided with an edge the user
  // already has, i.e. the same relationship expressed twice. Retract the duplicate
  // rather than hard-deleting it, so a cursor consumer drops the stale `h:` node
  // instead of keeping the same person as two.
  await query(
    `UPDATE lumen_block SET active = false, seq = ${NEXT_SEQ}
      WHERE (blocker_hive = $1 OR blocked_hive = $1) AND active`,
    [name]
  );
}
