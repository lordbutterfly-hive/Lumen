import { query } from '../db/pool';
import { FollowActor, actorKey, sameActor } from '../social/follow-actor';

/**
 * Lumen's own follow graph (spec §E.4).
 *
 * It carries the three follow directions Hive cannot: lite→lite, lite→Hive and
 * Hive→lite. A Hive user following another Hive user is broadcast on chain and never
 * touches this table.
 *
 * Two invariants worth keeping in mind when changing anything here:
 *
 *  * A Lumen account is stored by `user_id`, never by name (see `social/follow-actor`),
 *    so an upgrade to a real Hive account rewrites nothing and loses no followers.
 *  * FOLLOW-RECSYS-1 (PRUNED 2026-07-22): an edge is SOFT-deleted (an `active` flag)
 *    and its `seq` is bumped on every state change, so the recsys delta feed
 *    re-observes BOTH follows and unfollows. A hard delete would leave a phantom edge
 *    the incremental consumer never retracts, letting follow/unfollow churn inflate
 *    an account's apparent reach.
 */

// The BIGSERIAL sequence behind `seq`; re-drawn on every state change so the
// edge re-surfaces on the recsys cursor feed.
const NEXT_SEQ = `nextval(pg_get_serial_sequence('lumen_follow', 'seq'))`;

/** The four column values for one edge, in insert order. */
function edgeParams(follower: FollowActor, followee: FollowActor) {
  return [
    follower.userId ?? null,
    follower.hive ?? null,
    followee.userId ?? null,
    followee.hive ?? null
  ];
}

export async function follow(follower: FollowActor, followee: FollowActor): Promise<boolean> {
  if (sameActor(follower, followee)) return false;
  // New pair -> insert (active). Previously-unfollowed pair -> reactivate + bump
  // seq (so the feed re-adds it). An already-active pair is a no-op (rowCount 0).
  // The conflict target is the generated key pair, which is what makes the same
  // person one node whichever tier they are.
  const { rowCount } = await query(
    `INSERT INTO lumen_follow (follower_user_id, follower_hive, followee_user_id, followee_hive)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (follower_key, followee_key)
       DO UPDATE SET active = true, seq = ${NEXT_SEQ}, created_at = now()
       WHERE lumen_follow.active = false`,
    edgeParams(follower, followee)
  );
  return (rowCount ?? 0) > 0;
}

export async function unfollow(follower: FollowActor, followee: FollowActor): Promise<void> {
  // Soft-delete + bump seq so the recsys feed emits the retraction (active=false);
  // only acts on a currently-active edge.
  await query(
    `UPDATE lumen_follow SET active = false, seq = ${NEXT_SEQ}
       WHERE follower_key = $1 AND followee_key = $2 AND active = true`,
    [actorKey(follower), actorKey(followee)]
  );
}

export async function isFollowing(follower: FollowActor, followee: FollowActor): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM lumen_follow
       WHERE follower_key = $1 AND followee_key = $2 AND active`,
    [actorKey(follower), actorKey(followee)]
  );
  return rows.length > 0;
}

export async function countFollowers(actor: FollowActor): Promise<number> {
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow WHERE followee_key = $1 AND active`,
    [actorKey(actor)]
  );
  return Number(rows[0]?.c ?? 0);
}

export async function countFollowing(actor: FollowActor): Promise<number> {
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow WHERE follower_key = $1 AND active`,
    [actorKey(actor)]
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Which of these names the follower already follows on Lumen. One query for a whole
 * page of authors, so a feed never issues a request per card.
 */
export async function followingAmong(
  follower: FollowActor,
  followees: FollowActor[]
): Promise<Set<string>> {
  if (followees.length === 0) return new Set();
  const { rows } = await query<{ followee_key: string }>(
    `SELECT followee_key FROM lumen_follow
       WHERE follower_key = $1 AND followee_key = ANY($2::text[]) AND active`,
    [actorKey(follower), followees.map(actorKey)]
  );
  return new Set(rows.map((r) => r.followee_key));
}

/**
 * Move every edge that names a Hive account onto the Lumen user who now owns that
 * name — called when a lite account upgrades.
 *
 * In practice there is nothing to move: the Hive account is brand new, so nobody can
 * have followed it before it existed. It runs anyway because the cost is one
 * statement and the failure it prevents is silent — the same person appearing as two
 * nodes in the graph, with their followers split across both.
 */
/**
 * ★ 2026-08-06 — every account this actor follows, in the identity the RANKER
 * uses. Added for the "For You" feed: recsys cannot resolve a Lumen follow graph
 * on its own (a lite viewer is a ULID, invisible on chain), so the caller has to
 * hand it over per request via `?follows=`.
 *
 * The identity returned is deliberately `followee_user_id` when present and the
 * Hive name otherwise, because that is exactly how recsys keys an author: a lite
 * post is ranked under its writer's `lumen_user_id` (see `Post.chain_author`),
 * an ordinary post under the Hive account. Returning display names here would
 * match nothing for lite followees and silently produce an emptier feed than the
 * viewer actually earned.
 *
 * Only `active` edges — an unfollow soft-deletes, and a feed built from
 * retracted follows would be a bug the user cannot see.
 */
export async function listFolloweesOf(actor: FollowActor, limit = 2000): Promise<string[]> {
  const { rows } = await query<{ followee: string }>(
    `SELECT COALESCE(followee_user_id, followee_hive::text) AS followee
       FROM lumen_follow
      WHERE follower_key = $1 AND active = true
      ORDER BY seq DESC
      LIMIT $2`,
    [actorKey(actor), limit]
  );
  return rows.map((r) => r.followee).filter((f): f is string => Boolean(f));
}

export async function absorbHiveActor(userId: string, hiveName: string): Promise<void> {
  const name = hiveName.toLowerCase();
  // Re-point what can be re-pointed, and bump `seq` while doing it: the re-pointed edge
  // is a NEW node id to the recsys consumer, and an edge it never re-observes is an
  // edge it never gains. Then retract — never hard-delete — what would collide with an
  // edge the user already has, so the consumer drops the old `h:` node instead of
  // keeping the same person as two.
  await query(
    `UPDATE lumen_follow SET follower_user_id = $1, follower_hive = NULL, seq = ${NEXT_SEQ}
       WHERE follower_hive = $2
         AND NOT EXISTS (
           SELECT 1 FROM lumen_follow existing
            WHERE existing.follower_key = 'u:' || $1 AND existing.followee_key = lumen_follow.followee_key
         )`,
    [userId, name]
  );
  await query(
    `UPDATE lumen_follow SET followee_user_id = $1, followee_hive = NULL, seq = ${NEXT_SEQ}
       WHERE followee_hive = $2
         AND NOT EXISTS (
           SELECT 1 FROM lumen_follow existing
            WHERE existing.followee_key = 'u:' || $1 AND existing.follower_key = lumen_follow.follower_key
         )`,
    [userId, name]
  );
  await query(
    `UPDATE lumen_follow SET active = false, seq = ${NEXT_SEQ}
      WHERE (follower_hive = $1 OR followee_hive = $1) AND active`,
    [name]
  );
}

export interface FollowEdge {
  /** Stable node id: `u:<user_id>` for a Lumen account, `h:<name>` for a Hive one. */
  follower: string;
  followee: string;
  seq: number;
  active: boolean; // false = a retraction (unfollow) the recsys consumer must remove
}

/**
 * Follow edges after a cursor — recsys pulls these to build the graph. INCLUDES
 * retracted (inactive) edges so an incremental consumer can remove a previously-added
 * edge: key on (follower, followee), apply the latest `seq` — `active` adds the edge,
 * `!active` removes it.
 *
 * Node ids are the prefixed keys rather than bare user ids, because an edge can now
 * name a Hive account that has no Lumen row. A Lumen user keeps the same `u:` id
 * across an upgrade, so the graph never has to be rebuilt for one.
 */
export async function listEdges(afterSeq: number, limit: number): Promise<FollowEdge[]> {
  const { rows } = await query<{
    follower_key: string;
    followee_key: string;
    seq: string;
    active: boolean;
  }>(
    `SELECT follower_key, followee_key, seq, active
       FROM lumen_follow WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
    [afterSeq, limit]
  );
  return rows.map((r) => ({
    follower: r.follower_key,
    followee: r.followee_key,
    seq: Number(r.seq),
    active: r.active
  }));
}
