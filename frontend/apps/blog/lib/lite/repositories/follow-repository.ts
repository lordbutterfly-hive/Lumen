import { query } from '../db/pool';
import { FollowActor, actorKey, sameActor } from '../social/follow-actor';
import { bannedAuthorList, isBannedAuthor } from '@/blog/lib/moderation/banned-authors';

/**
 * ★ A BANNED CHAIN ACCOUNT MUST NOT MOVE A NUMBER IN THIS TABLE.
 *
 * `lumen_follow` is the one graph a banned HIVE account can still write to
 * through Lumen: a full Hive account signing in here is stored as `follower_hive`
 * (an `h:<name>` node), so nothing about being banned stops him pressing Follow.
 * Left alone, his edges would keep counting toward other people's follower
 * totals, keep him listed on their Followers page, and — via `listFolloweesOf`
 * — keep feeding the ranker a follow edge that shapes what a reader is shown.
 *
 * Every read below therefore excludes rows whose Hive side is a banned name. The
 * edges are LEFT IN PLACE rather than deleted: unbanning is then a config change,
 * not a data-recovery problem, and nothing is lost if a name is added by mistake.
 */
const bannedHiveNames = (): string[] => bannedAuthorList();

/** SQL fragment: `<column>` is not one of the banned Hive names in `$n`. */
const notBannedHive = (column: string, param: number): string =>
  `(${column} IS NULL OR NOT (lower(${column}::text) = ANY($${param}::text[])))`;

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
  // A banned account has no audience of its own to report.
  if (isBannedAuthor(actor.hive)) return 0;
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow
       WHERE followee_key = $1 AND active AND ${notBannedHive('follower_hive', 2)}`,
    [actorKey(actor), bannedHiveNames()]
  );
  return Number(rows[0]?.c ?? 0);
}

export async function countFollowing(actor: FollowActor): Promise<number> {
  if (isBannedAuthor(actor.hive)) return 0;
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM lumen_follow
       WHERE follower_key = $1 AND active AND ${notBannedHive('followee_hive', 2)}`,
    [actorKey(actor), bannedHiveNames()]
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
  // This list is handed to the RANKER as `?follows=`. A banned author in it would
  // shape what the reader is shown even though not one of his posts can be
  // rendered — the ban has to reach the ranking inputs, not just the output.
  return rows
    .map((r) => r.followee)
    .filter((f): f is string => Boolean(f) && !isBannedAuthor(f));
}

/**
 * ★★★ THE PEOPLE BEHIND THE COUNT.
 *
 * The Followers/Following PAGES asked Hive (`condenser_api.get_following`) for a
 * name that has no chain account, so a lite reader saw an accurate header —
 * "1 Following", counted from this very table — above a list body that rendered
 * nothing, forever. Two numbers from two different stores, one of which could
 * never be shown. Found by an exploratory UX tester 2026-08-06 and reproduced.
 *
 * Returns each edge as either a Lumen `userId` or a Hive `name`, exactly as it
 * is stored — the caller resolves display names, because a Lumen account's name
 * can change (an upgrade) and the edge deliberately does not record it.
 */
export interface FollowEdgePeer {
  userId: string | null;
  hive: string | null;
}

export async function listFollowingPeers(
  actor: FollowActor,
  opts: { limit: number; before?: number } = { limit: 100 }
): Promise<FollowEdgePeer[]> {
  const { rows } = await query<{ followee_user_id: string | null; followee_hive: string | null }>(
    `SELECT followee_user_id, followee_hive::text AS followee_hive
       FROM lumen_follow
      WHERE follower_key = $1 AND active = true
        AND ($2::bigint IS NULL OR seq < $2)
      ORDER BY seq DESC LIMIT $3`,
    [actorKey(actor), opts.before ?? null, opts.limit]
  );
  return rows
    .filter((r) => !isBannedAuthor(r.followee_hive))
    .map((r) => ({ userId: r.followee_user_id, hive: r.followee_hive }));
}

export async function listFollowerPeers(
  actor: FollowActor,
  opts: { limit: number; before?: number } = { limit: 100 }
): Promise<FollowEdgePeer[]> {
  const { rows } = await query<{ follower_user_id: string | null; follower_hive: string | null }>(
    `SELECT follower_user_id, follower_hive::text AS follower_hive
       FROM lumen_follow
      WHERE followee_key = $1 AND active = true
        AND ($2::bigint IS NULL OR seq < $2)
      ORDER BY seq DESC LIMIT $3`,
    [actorKey(actor), opts.before ?? null, opts.limit]
  );
  return rows
    .filter((r) => !isBannedAuthor(r.follower_hive))
    .map((r) => ({ userId: r.follower_user_id, hive: r.follower_hive }));
}

/**
 * Recent followers of an actor, WITH their timestamps — the raw material for a
 * "someone followed you" notification.
 *
 * ★ WHY (2026-08-09, tester BASELINE-03). Nobody is ever told when they gain a
 * follower. The bell asks `bridge.account_notifications` — the CHAIN — and a
 * Lumen follow is never written there, so a real social action produced silence
 * for the follower AND the followed. That holds for a full Hive account too: a
 * lite reader following @alice is invisible to @alice, because the bell has
 * exactly one data source and it cannot see Lumen at all.
 *
 * Derived from `lumen_follow` rather than a new notifications table on purpose:
 * the row already carries who, whom and when, so a follow notification is a
 * QUERY, not a second copy of the truth that can drift from it. Unfollow then
 * needs no compensating delete — the edge goes `active = false` and the
 * notification stops existing, which is the correct behaviour and is free.
 */
export async function listRecentFollowersWithTime(
  actor: FollowActor,
  opts: { limit: number } = { limit: 30 }
): Promise<{ userId: string | null; hive: string | null; at: string }[]> {
  const { rows } = await query<{
    follower_user_id: string | null;
    follower_hive: string | null;
    created_at: string;
  }>(
    `SELECT follower_user_id, follower_hive::text AS follower_hive, created_at
       FROM lumen_follow
      WHERE followee_key = $1 AND active = true
      ORDER BY seq DESC LIMIT $2`,
    [actorKey(actor), opts.limit]
  );
  return rows
    .filter((r) => !isBannedAuthor(r.follower_hive))
    .map((r) => ({ userId: r.follower_user_id, hive: r.follower_hive, at: r.created_at }));
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
  return rows
    // ★ THE RANKER'S TRUST/BREADTH GRAPH IS BUILT FROM THIS FEED. A banned
    // account's edges are withheld from it, so he is not a node recsys can
    // propagate trust through and cannot vouch anything into anyone's feed.
    // Node keys are `u:<userId>` (a Lumen account, never banned by this list)
    // or `h:<hive name>` — only the latter can name a banned chain account.
    .filter((r) => !isBannedFollowKey(r.follower_key) && !isBannedFollowKey(r.followee_key))
    .map((r) => ({
      follower: r.follower_key,
      followee: r.followee_key,
      seq: Number(r.seq),
      active: r.active
    }));
}

/** `h:<name>` -> is `<name>` banned? Anything else is a Lumen id and never is. */
function isBannedFollowKey(key: string): boolean {
  return key.startsWith('h:') && isBannedAuthor(key.slice(2));
}
