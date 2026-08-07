import { query } from '../db/pool';
import { ulid } from '../ids';
import {
  BeneficiaryRoute,
  FeedVisibility,
  LumenPost,
  ParentRef,
  PostTier,
  PublishMode
} from '../types';

interface PostRow {
  post_id: string;
  user_id: string;
  display_name_snapshot: string;
  parent_ref: ParentRef | null;
  tier: string;
  title: string;
  body: string;
  tags: string[];
  community: string | null;
  beneficiaries: BeneficiaryRoute[];
  thumbnail_url: string | null;
  summary: string | null;
  feed_visibility: string;
  publish_mode: string;
  hive_author: string | null;
  hive_permlink: string | null;
  shard: string | null;
  edit_of_post_id: string | null;
  deleted_locally: boolean;
  deleted_at: Date | null;
  edit_version: number;
  created_at: Date;
  published_at: Date | null;
}

function mapPost(r: PostRow): LumenPost {
  return {
    postId: r.post_id,
    userId: r.user_id,
    displayNameSnapshot: r.display_name_snapshot,
    parentRef: r.parent_ref,
    tier: r.tier as PostTier,
    title: r.title,
    body: r.body,
    tags: Array.isArray(r.tags) ? r.tags : [],
    community: r.community,
    beneficiaries: Array.isArray(r.beneficiaries) ? r.beneficiaries : [],
    thumbnailUrl: r.thumbnail_url,
    summary: r.summary,
    feedVisibility: r.feed_visibility as FeedVisibility,
    publishMode: r.publish_mode as PublishMode,
    hiveAuthor: r.hive_author,
    hivePermlink: r.hive_permlink,
    shard: r.shard,
    editOfPostId: r.edit_of_post_id,
    deletedLocally: r.deleted_locally,
    deletedAt: r.deleted_at,
    editVersion: Number(r.edit_version ?? 0),
    createdAt: r.created_at,
    publishedAt: r.published_at
  };
}

export interface CreatePostInput {
  userId: string;
  displayNameSnapshot: string;
  tier: PostTier;
  title: string;
  body: string;
  tags: string[];
  community?: string | null;
  beneficiaries?: BeneficiaryRoute[];
  thumbnailUrl?: string | null;
  summary?: string | null;
  parentRef?: ParentRef | null;
  feedVisibility?: FeedVisibility;
  shard?: string | null;
}

export async function createPost(input: CreatePostInput): Promise<LumenPost> {
  const { rows } = await query<PostRow>(
    `INSERT INTO lumen_post (
       post_id, user_id, display_name_snapshot, parent_ref, tier, title, body,
       tags, community, beneficiaries, thumbnail_url, summary, feed_visibility, shard
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      ulid(),
      input.userId,
      input.displayNameSnapshot,
      input.parentRef ? JSON.stringify(input.parentRef) : null,
      input.tier,
      input.title,
      input.body,
      JSON.stringify(input.tags ?? []),
      input.community ?? null,
      JSON.stringify(input.beneficiaries ?? []),
      input.thumbnailUrl ?? null,
      input.summary ?? null,
      input.feedVisibility ?? 'visible',
      input.shard ?? null
    ]
  );
  return mapPost(rows[0]);
}

export async function getPostById(postId: string): Promise<LumenPost | null> {
  const { rows } = await query<PostRow>(`SELECT * FROM lumen_post WHERE post_id = $1`, [postId]);
  return rows[0] ? mapPost(rows[0]) : null;
}

/** Batch lookup — ONE query for a whole feed page, never one per entry. */
export async function getPostsByIds(postIds: string[]): Promise<LumenPost[]> {
  if (postIds.length === 0) return [];
  const { rows } = await query<PostRow>(`SELECT * FROM lumen_post WHERE post_id = ANY($1::text[])`, [
    postIds
  ]);
  return rows.map(mapPost);
}

/** Newest-first keyset pagination by ULID post_id (which is time-sortable). */
/**
 * One account's own Lumen posts, newest first.
 *
 * ★ WHY THE FILTERS ARE NOT OPTIONAL EXTRAS (wired 2026-08-06).
 *
 * This function existed with ZERO callers while the profile's Posts tab asked
 * HIVE for a lite account's posts — `bridge.get_account_posts {account: "<lite
 * name>"}`, which answers `Account <name> does not exist`, retries three times
 * and settles empty. A reader saw "3 Posts" in the stat bar (counted from this
 * database) above a list that was permanently blank.
 *
 * `visibleOnly` defaults to TRUE because the first consumer is a PUBLIC profile:
 * a post hidden by moderation must not come back through a different door than
 * the feed it was removed from (`listRecent` filters the same way).
 *
 * `kind` splits the Posts tab from the Comments tab. A Lumen reply is a row in
 * this same table carrying a `parent_ref`, exactly as a Hive comment is a post
 * with a parent — so "root vs reply" is `parent_ref IS NULL`.
 */
export async function getUserPosts(
  userId: string,
  opts: { limit: number; before?: string; visibleOnly?: boolean; kind?: 'posts' | 'comments' | 'all' }
): Promise<LumenPost[]> {
  const visibleOnly = opts.visibleOnly ?? true;
  const kind = opts.kind ?? 'all';
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post
       WHERE user_id = $1 AND deleted_locally = false
         AND ($2::text IS NULL OR post_id < $2)
         AND ($4::boolean = false OR feed_visibility = 'visible')
         AND ($5::text = 'all'
              OR ($5::text = 'posts'    AND parent_ref IS NULL)
              OR ($5::text = 'comments' AND parent_ref IS NOT NULL))
     ORDER BY post_id DESC LIMIT $3`,
    [userId, opts.before ?? null, opts.limit, visibleOnly, kind]
  );
  return rows.map(mapPost);
}

/**
 * Visible root posts by ANY of these Lumen authors, newest first.
 *
 * One query, not one per author: a Following feed can name hundreds of people,
 * and a per-author round trip would make the feed's cost scale with how social
 * the reader is — precisely backwards.
 */
export async function listByUsers(
  userIds: readonly string[],
  opts: { limit: number; before?: string }
): Promise<LumenPost[]> {
  if (userIds.length === 0) return [];
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post
       WHERE user_id = ANY($1::text[])
         AND deleted_locally = false
         AND feed_visibility = 'visible'
         AND parent_ref IS NULL
         AND ($2::text IS NULL OR post_id < $2)
     ORDER BY post_id DESC LIMIT $3`,
    [[...userIds], opts.before ?? null, opts.limit]
  );
  return rows.map(mapPost);
}

export async function listRecent(opts: { limit: number; before?: string }): Promise<LumenPost[]> {
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post
       WHERE feed_visibility = 'visible' AND deleted_locally = false
         AND ($1::text IS NULL OR post_id < $1)
     ORDER BY post_id DESC LIMIT $2`,
    [opts.before ?? null, opts.limit]
  );
  return rows.map(mapPost);
}

export interface UpdatePostPatch {
  title: string;
  body: string;
  tags: string[];
  summary: string | null;
  thumbnailUrl: string | null;
  /** The edit's OWN pre-screen result (F-L32). See updatePostContent for why writing
   *  this cannot undo a moderator sanction. */
  feedVisibility: FeedVisibility;
}

/**
 * Replace a post's content AND persist the edit's own pre-screen visibility (F-L32).
 *
 * Earlier this deliberately left `feed_visibility` alone, because an unconditional edit
 * once overwrote a MODERATOR decision with the pre-screen default ('visible') — a
 * sanction short of a full takedown was undoable by its own author. That hole is now
 * closed at the CALLER instead: the edit path refuses any post whose current
 * feed_visibility !== 'visible' (post-service.ts), so an edit only ever reaches here on
 * an already-visible post, and the value written is the AUTOMATED screen of the NEW
 * text. It can therefore only DOWNGRADE ('limited'/'author_only') content that just
 * screened worse — never restore a moderator-hidden post. Without persisting it, an edit
 * could turn visible content into limited-worthy content while staying fully visible.
 */
export async function updatePostContent(postId: string, patch: UpdatePostPatch): Promise<LumenPost> {
  const { rows } = await query<PostRow>(
    `UPDATE lumen_post
       SET title = $2, body = $3, tags = $4, summary = $5, thumbnail_url = $6, feed_visibility = $7
     WHERE post_id = $1 RETURNING *`,
    [
      postId,
      patch.title,
      patch.body,
      JSON.stringify(patch.tags),
      patch.summary,
      patch.thumbnailUrl,
      patch.feedVisibility
    ]
  );
  return mapPost(rows[0]);
}

export async function softDelete(postId: string): Promise<void> {
  await query(
    `UPDATE lumen_post SET deleted_locally = true, feed_visibility = 'hidden' WHERE post_id = $1`,
    [postId]
  );
}

/** Reverse-lookup a published proxy post to its lite author (attribution, §E.1). */
export async function resolveByHive(
  hiveAuthor: string,
  hivePermlink: string
): Promise<LumenPost | null> {
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post WHERE hive_author = $1 AND hive_permlink = $2`,
    [hiveAuthor, hivePermlink]
  );
  return rows[0] ? mapPost(rows[0]) : null;
}

/**
 * Record the on-chain mapping after a successful publish. With `pruneBody`, the
 * stored body is dropped — Hive becomes the source of truth and the DB keeps only
 * the mapping (hybrid model). Without it, the body is kept as a rebuildable cache.
 */
export async function markPostPublished(
  postId: string,
  hiveAuthor: string,
  hivePermlink: string,
  opts: { pruneBody?: boolean } = {}
): Promise<void> {
  const prune = opts.pruneBody ? ", body = ''" : '';
  await query(
    `UPDATE lumen_post
       SET hive_author = $2, hive_permlink = $3, published_at = now()${prune}
     WHERE post_id = $1`,
    [postId, hiveAuthor, hivePermlink]
  );
}

export interface HiveAuthorMapping {
  hiveAuthor: string;
  hivePermlink: string;
  userId: string;
  displayName: string;
}

/** Batch reverse-lookup of published proxy posts -> lite user (recsys, §E.4). */
export async function resolveByHiveBatch(
  authors: string[],
  permlinks: string[]
): Promise<HiveAuthorMapping[]> {
  if (authors.length === 0) return [];
  const { rows } = await query<{
    hive_author: string;
    hive_permlink: string;
    user_id: string;
    display_name_snapshot: string;
  }>(
    `SELECT hive_author, hive_permlink, user_id, display_name_snapshot
       FROM lumen_post
      WHERE (hive_author, hive_permlink) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [authors, permlinks]
  );
  return rows.map((r) => ({
    hiveAuthor: r.hive_author,
    hivePermlink: r.hive_permlink,
    userId: r.user_id,
    displayName: r.display_name_snapshot
  }));
}

export interface RankedLiteMapping {
  hiveAuthor: string;
  hivePermlink: string;
  userId: string;
  displayName: string;
  /** False when a moderator hid it or the author deleted it in Lumen. */
  servable: boolean;
}

/**
 * ★ 2026-08-06 — chain identity -> lite identity AND SERVABILITY, for the
 * ranked "For You" feed.
 *
 * Distinct from `resolveByHiveBatch` on purpose. That one answers "whose post
 * is this?" for attribution and deliberately returns every row. This one is
 * consumed by a FEED, so it must also answer "may this still be shown?".
 *
 * The recsys ranker reads Hive through HAFSQL and has no idea what Lumen has
 * moderated — it will happily rank a post you took down an hour ago, because on
 * chain it is still there. Without the `servable` flag the ranked feed becomes a
 * way to resurface hidden content, which would quietly defeat the takedown that
 * is the whole moderation strategy. Same predicate as `listRecent`
 * (`feed_visibility = 'visible' AND deleted_locally = false`), kept in one shape
 * so the two feeds cannot disagree about what "hidden" means.
 *
 * Rows are returned for hidden posts too, flagged `servable: false`, rather than
 * filtered out here — the caller must be able to tell "this is a lite post I
 * must drop" apart from "this is not a lite post at all", and silently omitting
 * them would make those two cases identical.
 */
export async function resolveRankedLiteBatch(
  authors: string[],
  permlinks: string[]
): Promise<RankedLiteMapping[]> {
  if (authors.length === 0) return [];
  const { rows } = await query<{
    hive_author: string;
    hive_permlink: string;
    user_id: string;
    display_name_snapshot: string;
    servable: boolean;
  }>(
    `SELECT hive_author, hive_permlink, user_id, display_name_snapshot,
            (feed_visibility = 'visible' AND deleted_locally = false) AS servable
       FROM lumen_post
      WHERE (hive_author, hive_permlink) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [authors, permlinks]
  );
  return rows.map((r) => ({
    hiveAuthor: r.hive_author,
    hivePermlink: r.hive_permlink,
    userId: r.user_id,
    displayName: r.display_name_snapshot,
    servable: r.servable
  }));
}

/**
 * The on-chain parent this post was first published under (container or reply
 * target), or null if it has never been pinned.
 */
export async function getPublishParent(
  postId: string
): Promise<{ author: string; permlink: string } | null> {
  const res = await query<{ publish_parent_author: string | null; publish_parent_permlink: string | null }>(
    `SELECT publish_parent_author, publish_parent_permlink FROM lumen_post WHERE post_id = $1`,
    [postId]
  );
  const row = res.rows[0];
  if (!row?.publish_parent_author || !row.publish_parent_permlink) return null;
  return { author: row.publish_parent_author, permlink: row.publish_parent_permlink };
}

/**
 * Pin the on-chain parent, FIRST WRITE WINS — later calls return the pinned value
 * and change nothing. Hive rejects any edit that repoints a comment
 * ("The parent of a comment cannot change.", hive_evaluator_social.cpp:294/302),
 * so this must never be overwritten once a post has been published under it.
 */
/**
 * Unpin an UNPUBLISHED post's parent so it can be re-pointed.
 *
 * The pin is first-write-wins for a reason: a published comment's parent can never
 * change on chain. But a post that never reached Hive has no such commitment, and one
 * pinned to a container that turned out to be unopenable would otherwise wait on it
 * forever. Guarded on `hive_permlink IS NULL` so a published post can never be
 * re-pointed by this.
 */
export async function unpinPublishParent(postId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE lumen_post
        SET publish_parent_author = NULL, publish_parent_permlink = NULL
      WHERE post_id = $1 AND hive_permlink IS NULL`,
    [postId]
  );
  return (rowCount ?? 0) > 0;
}

export async function pinPublishParent(
  postId: string,
  author: string,
  permlink: string
): Promise<{ author: string; permlink: string }> {
  const res = await query<{ publish_parent_author: string; publish_parent_permlink: string }>(
    `UPDATE lumen_post
        SET publish_parent_author = COALESCE(publish_parent_author, $2),
            publish_parent_permlink = COALESCE(publish_parent_permlink, $3)
      WHERE post_id = $1
      RETURNING publish_parent_author, publish_parent_permlink`,
    [postId, author, permlink]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`pinPublishParent: post ${postId} not found`);
  return { author: row.publish_parent_author, permlink: row.publish_parent_permlink };
}

/**
 * Posts with NO publish job at all — the orphan case. A post row is committed
 * before its job is enqueued, so a crash (or a thrown container reservation, the
 * bug found by the 2026-07-28 burst test) can leave a post that would never
 * publish. `reconcileOrphans` in the publisher re-enqueues these.
 *
 * Excludes locally deleted posts and anything already on chain.
 */
/**
 * Posts that never reached Hive and have no LIVE job working on them.
 *
 * ★★★ B7 (2026-08-06) — THIS USED TO STRAND A FAILED POST FOREVER.
 *
 * The old predicate was `NOT EXISTS (any publish_job row)`. `publish_job.status`
 * includes the TERMINAL values `failed` and `rejected`, so a post whose create
 * job exhausted its retries was excluded from reconciliation permanently: no
 * retry path, no operator surface, and still served in feeds and profiles with
 * `hive_permlink: null` — indistinguishable from a post that really is on chain.
 *
 * Now only a job in a NON-terminal state (`pending`/`holding`/`publishing`/
 * `published`) suppresses reconciliation, so a dead job lets the post be picked
 * up again. `published` is deliberately in that list: a post with a completed
 * job is not orphaned, it is done.
 *
 * ★ BOUNDED, because "retry forever" is its own bug. `maxGenerations` caps how
 * many publish attempts a post may ever accumulate. Past that it stops being
 * reconciled and needs a human — retrying a post Hive keeps refusing (malformed
 * payload, banned content) would otherwise spin every drain for the life of the
 * deployment. `reconcileOrphans` logs the ones it gives up on.
 */
export async function listOrphaned(limit: number, maxGenerations = 3): Promise<LumenPost[]> {
  const res = await query<PostRow>(
    `SELECT p.* FROM lumen_post p
      WHERE p.deleted_locally = false
        AND p.hive_permlink IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM publish_job j
               WHERE j.post_id = p.post_id
                 AND j.status NOT IN ('failed','rejected')
            )
        AND (SELECT count(*) FROM publish_job j2 WHERE j2.post_id = p.post_id) < $2
      ORDER BY p.post_id
      LIMIT $1`,
    [limit, maxGenerations]
  );
  return res.rows.map(mapPost);
}

/**
 * ★ B7. Posts that have exhausted their publish generations — they will never
 * reach Hive without a human, and they are still being SERVED. The operator
 * surface the old code had none of.
 */
export async function listPermanentlyFailed(
  limit: number,
  maxGenerations = 3
): Promise<LumenPost[]> {
  const res = await query<PostRow>(
    `SELECT p.* FROM lumen_post p
      WHERE p.deleted_locally = false
        AND p.hive_permlink IS NULL
        AND (SELECT count(*) FROM publish_job j WHERE j.post_id = p.post_id) >= $2
        AND NOT EXISTS (
              SELECT 1 FROM publish_job j
               WHERE j.post_id = p.post_id
                 AND j.status NOT IN ('failed','rejected')
            )
      ORDER BY p.post_id
      LIMIT $1`,
    [limit, maxGenerations]
  );
  return res.rows.map(mapPost);
}

/** Bump and return the post's edit counter — drives per-edit idempotency keys. */
export async function bumpEditVersion(postId: string): Promise<number> {
  const res = await query<{ edit_version: number }>(
    `UPDATE lumen_post SET edit_version = edit_version + 1 WHERE post_id = $1
     RETURNING edit_version`,
    [postId]
  );
  if (!res.rows[0]) throw new Error(`bumpEditVersion: post ${postId} not found`);
  return Number(res.rows[0].edit_version);
}

/**
 * Mark a post deleted. `deletedLocally` hides it from our surfaces immediately;
 * `deleted_at` is the audit stamp and the guard that refuses later edits. Whether
 * the on-chain object can be hard-deleted is decided by the worker (Hive refuses to
 * delete a comment that has replies or net-positive votes).
 */
export async function markDeleted(postId: string, userId: string): Promise<LumenPost | null> {
  const res = await query<PostRow>(
    `UPDATE lumen_post
        SET deleted_locally = true, deleted_at = COALESCE(deleted_at, now())
      WHERE post_id = $1 AND user_id = $2
      RETURNING *`,
    [postId, userId]
  );
  return res.rows[0] ? mapPost(res.rows[0]) : null;
}

/** How many of this user's posts actually reached Hive — a real trust signal. */
export async function countPublishedByUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lumen_post
      WHERE user_id = $1 AND hive_permlink IS NOT NULL AND deleted_locally = false`,
    [userId]
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Total non-deleted posts by this user — the one profile figure we can state truly. */
/**
 * The post count shown on a PUBLIC profile.
 *
 * ★ Must exclude moderation-hidden rows, and this was measured wrong: an account
 * with three posts, one of them taken down, advertised "3 Posts" above a list of
 * two. A count that disagrees with the list it labels reads as a bug in the list
 * — and worse, it silently tells the world that something was removed. The
 * visibility rule here is deliberately the same one `getUserPosts` and
 * `listRecent` apply, so all three can only ever agree.
 */
export async function countByUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lumen_post
      WHERE user_id = $1 AND deleted_locally = false AND feed_visibility = 'visible'`,
    [userId]
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Moderator visibility override for a single post. `feed_visibility` existed in the
 * schema with no writer outside the automatic pre-screen, so a human had no way to
 * hide something the screen missed.
 */
export async function setFeedVisibility(
  postId: string,
  visibility: 'visible' | 'author_only' | 'hidden'
): Promise<LumenPost | null> {
  const res = await query<PostRow>(
    `UPDATE lumen_post SET feed_visibility = $2 WHERE post_id = $1 RETURNING *`,
    [postId, visibility]
  );
  return res.rows[0] ? mapPost(res.rows[0]) : null;
}

/**
 * Hide (or restore) every post by one author in a single statement — the spam case,
 * where suspending the account is useless if forty posts stay in the feed.
 *
 * Deliberately does NOT touch the chain: posts already broadcast stay on Hive, and
 * the caller is told so rather than being left to assume this removed them.
 */
export async function setFeedVisibilityForUser(
  userId: string,
  visibility: 'visible' | 'author_only' | 'hidden'
): Promise<number> {
  const res = await query(
    `UPDATE lumen_post SET feed_visibility = $2
      WHERE user_id = $1 AND feed_visibility <> $2 AND deleted_locally = false`,
    [userId, visibility]
  );
  return res.rowCount ?? 0;
}
