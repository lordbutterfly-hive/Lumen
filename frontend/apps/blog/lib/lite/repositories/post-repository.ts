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
