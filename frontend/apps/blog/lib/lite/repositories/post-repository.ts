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
export async function getUserPosts(
  userId: string,
  opts: { limit: number; before?: string }
): Promise<LumenPost[]> {
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post
       WHERE user_id = $1 AND deleted_locally = false
         AND ($2::text IS NULL OR post_id < $2)
     ORDER BY post_id DESC LIMIT $3`,
    [userId, opts.before ?? null, opts.limit]
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
  feedVisibility: FeedVisibility;
}

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
export async function listOrphaned(limit: number): Promise<LumenPost[]> {
  const res = await query<PostRow>(
    `SELECT p.* FROM lumen_post p
      WHERE p.deleted_locally = false
        AND p.hive_permlink IS NULL
        AND NOT EXISTS (SELECT 1 FROM publish_job j WHERE j.post_id = p.post_id)
      ORDER BY p.post_id
      LIMIT $1`,
    [limit]
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
export async function countByUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lumen_post WHERE user_id = $1 AND deleted_locally = false`,
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
