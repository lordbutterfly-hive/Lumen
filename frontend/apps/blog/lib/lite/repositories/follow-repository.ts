import { query } from '../db/pool';

/**
 * Off-chain follow graph for lite users (spec §E.4). FOLLOW-RECSYS-1
 * (PRUNED 2026-07-22): an edge is SOFT-deleted (an `active` flag) and its `seq`
 * is bumped on every state change, so the recsys delta feed re-observes BOTH
 * follows and unfollows. A hard-delete would leave a phantom edge the
 * incremental consumer never retracts, letting follow/unfollow churn inflate an
 * account's apparent reach.
 */

// The BIGSERIAL sequence behind `seq`; re-drawn on every state change so the
// edge re-surfaces on the recsys cursor feed.
const NEXT_SEQ = `nextval(pg_get_serial_sequence('lumen_follow', 'seq'))`;

export async function follow(follower: string, followee: string): Promise<boolean> {
  if (follower === followee) return false;
  // New pair -> insert (active). Previously-unfollowed pair -> reactivate + bump
  // seq (so the feed re-adds it). An already-active pair is a no-op (rowCount 0).
  const { rowCount } = await query(
    `INSERT INTO lumen_follow (follower_user_id, followee_user_id)
     VALUES ($1, $2)
     ON CONFLICT (follower_user_id, followee_user_id)
       DO UPDATE SET active = true, seq = ${NEXT_SEQ}, created_at = now()
       WHERE lumen_follow.active = false`,
    [follower, followee]
  );
  return (rowCount ?? 0) > 0;
}

export async function unfollow(follower: string, followee: string): Promise<void> {
  // Soft-delete + bump seq so the recsys feed emits the retraction (active=false);
  // only acts on a currently-active edge.
  await query(
    `UPDATE lumen_follow SET active = false, seq = ${NEXT_SEQ}
       WHERE follower_user_id = $1 AND followee_user_id = $2 AND active = true`,
    [follower, followee]
  );
}

export async function isFollowing(follower: string, followee: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM lumen_follow
       WHERE follower_user_id = $1 AND followee_user_id = $2 AND active`,
    [follower, followee]
  );
  return rows.length > 0;
}

export async function countFollowers(userId: string): Promise<number> {
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow WHERE followee_user_id = $1 AND active`,
    [userId]
  );
  return Number(rows[0]?.c ?? 0);
}

export async function countFollowing(userId: string): Promise<number> {
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow WHERE follower_user_id = $1 AND active`,
    [userId]
  );
  return Number(rows[0]?.c ?? 0);
}

export interface FollowEdge {
  follower: string;
  followee: string;
  seq: number;
  active: boolean; // false = a retraction (unfollow) the recsys consumer must remove
}

/**
 * Follow edges after a cursor — recsys pulls these to build the graph over
 * user_id. INCLUDES retracted (inactive) edges so an incremental consumer can
 * remove a previously-added edge: key on (follower, followee), apply the latest
 * `seq` — `active` adds the edge, `!active` removes it.
 */
export async function listEdges(afterSeq: number, limit: number): Promise<FollowEdge[]> {
  const { rows } = await query<{
    follower_user_id: string;
    followee_user_id: string;
    seq: string;
    active: boolean;
  }>(
    `SELECT follower_user_id, followee_user_id, seq, active
       FROM lumen_follow WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
    [afterSeq, limit]
  );
  return rows.map((r) => ({
    follower: r.follower_user_id,
    followee: r.followee_user_id,
    seq: Number(r.seq),
    active: r.active
  }));
}
