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

/**
 * Visible lite replies whose parent is a given post — the ones a reader should
 * see in that post's comment thread.
 *
 * ★ WHY THIS EXISTS (2026-08-09, tester NEWCOMER-06). A lite reply was saved,
 * confirmed with "It will appear in this thread once it reaches Hive", and then
 * was NOT in the thread — while being fully visible on the author's own profile
 * Comments tab. The thread is built from `bridge.get_discussion`, i.e. the
 * CHAIN, and a lite reply is not on chain until the publisher drains. So the one
 * place the author would naturally look was the one place it could not appear,
 * and top-level posts had no such gap because they render locally in both places.
 *
 * That gap widens to "forever" whenever the publisher is stalled — which it is
 * right now, on resource credits.
 *
 * Keyed on `publish_parent_*` (the chain identity of the parent) rather than
 * `parent_ref`, because the thread we are merging into is addressed by chain
 * author/permlink.
 */
export async function listRepliesToChainPost(
  parentAuthor: string,
  parentPermlink: string,
  opts: { limit: number } = { limit: 200 }
): Promise<LumenPost[]> {
  const { rows } = await query<PostRow>(
    `SELECT * FROM lumen_post
       WHERE publish_parent_author = $1
         AND publish_parent_permlink = $2
         AND deleted_locally = false
         AND feed_visibility = 'visible'
     ORDER BY post_id ASC LIMIT $3`,
    [parentAuthor, parentPermlink, opts.limit]
  );
  return rows.map(mapPost);
}

/**
 * Same as `listRepliesToChainPost`, batched over a SET of parents in one query.
 *
 * ★ WHY THIS EXISTS (2026-08-13, S6/S7 handover -- O4-stuck-states.md item 7).
 * `listRepliesToChainPost` above -- and `/api/lite/posts/replies` before this
 * change -- accepted exactly ONE parent: the chain identity of whatever post the
 * caller asked about, always the THREAD ROOT in practice. That is right for a
 * lite reply to the root post and silently wrong for a lite reply to a COMMENT: a
 * nested reply's `publish_parent_*` is the comment it replies to, not the post at
 * the top of the thread, so a caller that only ever asks about the root leaves
 * every nested lite reply permanently unmatched -- not merely hidden, never
 * fetched at all, on every page load. The fix is not a different WHERE clause on
 * the same single-pair shape; it is asking about every node in the thread that
 * could have a lite reply hanging off it, in ONE call, since the caller (the post
 * page) already knows the whole tree by the time it asks. One row per (author,
 * permlink) pair via `unnest` -- the same batching shape `getEngagementTotals`
 * (engagement-repository.ts) already uses for the identical class of problem.
 *
 * Returns each matched post ALONGSIDE the specific requested parent it matched --
 * not just the post -- because a batched caller cannot otherwise tell which of its
 * N requested parents a given row answers. `dbPostToEntry` cannot derive
 * `parent_author`/`parent_permlink` on its own (see the route's own doc), and with
 * more than one parent in play there is no longer a single implicit answer for the
 * route to fall back on the way the single-parent form still can.
 *
 * ★★★ THE CAP IS PER PARENT, THE ORDER IS NEWEST-FIRST, AND A CUT IS REPORTED
 * (2026-08-13, adversarial review S3). The first batched version of this query kept
 * the single-parent form's `ORDER BY post_id ASC LIMIT 200` verbatim, which silently
 * became three different bugs the moment more than one parent was passed:
 *
 *   1. **The 200 was GLOBAL across the whole batch, not per parent.** Before
 *      batching it belonged to ONE parent (the thread root) and was never close to
 *      binding; batched over up to 200 parents it is shared 200 ways, so one chatty
 *      comment could starve every other node in the thread of its replies. That is a
 *      capacity regression created by the batching, not a pre-existing limit.
 *   2. **`ASC` means the cut lands on the NEWEST rows.** This route exists because a
 *      lite reader posted a reply and could not find it (see the route's own header),
 *      so dropping the newest replies first defeats the exact purpose it was built
 *      for -- the reply a reader is looking for is the one they just wrote.
 *   3. **Nothing said a cut had happened.** A truncated answer is indistinguishable
 *      from a complete one, so "there are no more replies" gets asserted on a result
 *      that was quietly clipped.
 *
 * So: `row_number()` caps each parent independently (restoring the pre-batching
 * per-thread guarantee), both orderings are `post_id DESC` (ULIDs are monotonic, so
 * that is newest-first) and BOTH caps are queried with a +1 probe row whose presence
 * is the truncation signal. The caller gets `truncated` and is expected to say so
 * rather than present a clipped list as the whole story. Row ORDER is not part of the
 * contract -- the post page re-sorts the merged thread itself (`sorter` in
 * `[permlink]/content.tsx`) -- only which rows survive a cut is.
 */
export interface BatchedChainPostReplies {
  matches: { post: LumenPost; parentAuthor: string; parentPermlink: string }[];
  /** True when at least one parent hit `perParentLimit`, or the batch as a whole hit
   *  `totalLimit`. The answer is INCOMPLETE and must not be presented as final. */
  truncated: boolean;
}

export async function listRepliesToChainPosts(
  parents: { author: string; permlink: string }[],
  opts: { perParentLimit?: number; totalLimit?: number } = {}
): Promise<BatchedChainPostReplies> {
  const perParentLimit = opts.perParentLimit ?? 200;
  const totalLimit = opts.totalLimit ?? 2000;
  if (parents.length === 0) return { matches: [], truncated: false };

  // Dedup, same reasoning as `getEngagementTotals` -- the caller's own parent list
  // can legitimately repeat a pair (e.g. the thread root passed once as the post
  // itself, with no obligation on the caller to filter it back out before asking).
  const seen = new Set<string>();
  const authors: string[] = [];
  const permlinks: string[] = [];
  for (const p of parents) {
    const key = `${p.author}/${p.permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(p.author);
    permlinks.push(p.permlink);
  }

  // Both `$3` and `$4` are asked for ONE MORE row than we intend to keep. That extra
  // row is never returned to anyone -- its only job is to answer "was there more?"
  // without a second COUNT query, which is the difference between an honest cap and a
  // silent one.
  const { rows } = await query<
    PostRow & { matched_parent_author: string; matched_parent_permlink: string; parent_rank: string }
  >(
    `WITH matched AS (
       SELECT lp.*,
              w.parent_author AS matched_parent_author,
              w.parent_permlink AS matched_parent_permlink,
              row_number() OVER (
                PARTITION BY w.parent_author, w.parent_permlink
                ORDER BY lp.post_id DESC
              ) AS parent_rank
         FROM lumen_post lp
         JOIN unnest($1::text[], $2::text[]) AS w(parent_author, parent_permlink)
           ON lp.publish_parent_author = w.parent_author
          AND lp.publish_parent_permlink = w.parent_permlink
        WHERE lp.deleted_locally = false
          AND lp.feed_visibility = 'visible'
     )
     SELECT * FROM matched
      WHERE parent_rank <= $3
      ORDER BY post_id DESC
      LIMIT $4`,
    [authors, permlinks, perParentLimit + 1, totalLimit + 1]
  );

  // The batch-wide probe row. Checked FIRST: if the global limit bound, some
  // parents' probe rows may themselves have been cut off, so the per-parent check
  // below can no longer see everything -- but `truncated` is already true either way.
  const hitTotal = rows.length > totalLimit;
  const kept = hitTotal ? rows.slice(0, totalLimit) : rows;

  const seenPerParent = new Map<string, number>();
  const matches: BatchedChainPostReplies['matches'] = [];
  let hitPerParent = false;
  for (const row of kept) {
    const parentKey = `${row.matched_parent_author}/${row.matched_parent_permlink}`;
    const rank = (seenPerParent.get(parentKey) ?? 0) + 1;
    seenPerParent.set(parentKey, rank);
    if (rank > perParentLimit) {
      hitPerParent = true;
      continue;
    }
    matches.push({
      post: mapPost(row),
      parentAuthor: row.matched_parent_author,
      parentPermlink: row.matched_parent_permlink
    });
  }
  return { matches, truncated: hitTotal || hitPerParent };
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
 *
 * ★ `published_at` is FIRST-WRITE-WINS. This runs again after every successful edit
 * (an `update` job ends here too), and `= now()` made a post's publication date jump
 * to the moment of its latest edit — the same COALESCE the container publisher has
 * always used. Nothing outside the row mapper reads the column today, which is
 * exactly why it was free to be wrong.
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
       SET hive_author = $2, hive_permlink = $3, published_at = COALESCE(published_at, now())${prune}
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

/**
 * ★★★ RECORD THE PARENT THE POST IS ACTUALLY BEING BROADCAST UNDER (2026-08-10).
 *
 * THE BUG THIS FIXES. A reply is written against the parent's LOCAL placeholder name
 * (`lite-<ulid>` — what Lumen's own URLs use before a post reaches Hive), and that
 * placeholder is what gets pinned at intake. The publisher then resolves it to the
 * parent's REAL on-chain name (`lumen-<ulid>`) at broadcast time and publishes under
 * that — but only in the payload it holds in memory. The row kept the placeholder,
 * so the database's record of "what parent did this publish under" was WRONG for
 * every lite reply, with two live consequences:
 *
 *   1. Every later operation on that reply — an edit, a takedown — rebuilds its op
 *      from the pin, names the placeholder, and Hive refuses it permanently:
 *      "The parent of a comment cannot change." (hive_evaluator_social.cpp:294/302).
 *      A moderator's takedown of a lite reply could not succeed, ever.
 *   2. `listRepliesToChainPost` — the comment thread — keys on exactly these two
 *      columns, so the reply never merged into the thread it was written in.
 *
 * Guarded on `hive_permlink IS NULL` for the same reason {@link pinPublishParent} is
 * first-write-wins: once a post is on chain its parent is a fact, and rewriting the
 * record of a fact is how you lose the ability to operate on it. This runs in the
 * window before the broadcast, which is the only window in which the value is still
 * being decided.
 */
export async function setPublishParent(
  postId: string,
  author: string,
  permlink: string
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE lumen_post
        SET publish_parent_author = $2, publish_parent_permlink = $3
      WHERE post_id = $1 AND hive_permlink IS NULL`,
    [postId, author, permlink]
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

/**
 * ★★★ POSTS THAT ARE BEING SERVED BUT WILL NEVER REACH HIVE (2026-08-10).
 *
 * Distinct from {@link listPermanentlyFailed}, which asks "did this post exhaust its
 * generation budget?" — a question about the retry machinery. This asks the only
 * question a reader's experience depends on: is this post on chain, and is anything
 * at all still working on it? A post with three dead jobs and a post with zero jobs
 * are the same post to whoever is reading it.
 *
 * Deliberately UNBOUNDED by generation count, so it can see exactly the rows the
 * repair sweep has given up on — that is its entire purpose.
 */
export async function listStranded(limit: number): Promise<LumenPost[]> {
  const res = await query<PostRow>(
    `SELECT p.* FROM lumen_post p
      WHERE p.deleted_locally = false
        AND p.feed_visibility = 'visible'
        AND p.hive_permlink IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM publish_job j
               WHERE j.post_id = p.post_id
                 AND j.status IN ('pending','holding','publishing')
            )
      ORDER BY p.post_id
      LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapPost);
}

/**
 * Repair the parent record of an ALREADY-PUBLISHED reply that was pinned to the
 * parent's placeholder name.
 *
 * The rows this fixes were published before {@link setPublishParent} existed: the
 * broadcast named the parent's real permlink, the row kept `lite-<ulid>`. Since the
 * post is on chain, `setPublishParent` (rightly) refuses to touch it — so this is a
 * deliberate, narrow backfill, and it only ever writes the value the chain already
 * has: it requires the referenced parent to exist and to be published under the
 * `lumen-` name derived from the very id the placeholder names. It cannot invent a
 * parent, and it cannot change one that is already correct.
 */
export async function repairPlaceholderPublishParent(limit: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE lumen_post p
        SET publish_parent_author = parent.hive_author,
            publish_parent_permlink = parent.hive_permlink
       FROM lumen_post parent
      WHERE p.post_id IN (
              SELECT p2.post_id FROM lumen_post p2
               WHERE p2.publish_parent_permlink LIKE 'lite-%'
                 AND p2.hive_permlink IS NOT NULL
               ORDER BY p2.post_id
               LIMIT $1
            )
        AND parent.post_id = upper(substring(p.publish_parent_permlink from 6))
        AND parent.hive_permlink = 'lumen-' || lower(parent.post_id)
        AND parent.hive_author IS NOT NULL`,
    [limit]
  );
  return rowCount ?? 0;
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

/**
 * The number printed under the word "Posts" on a PUBLIC profile.
 *
 * ★ ROOT POSTS ONLY — `parent_ref IS NULL` (2026-08-08). Without that clause this
 * counted replies too, so an account with one post and one comment advertised
 * "2 Posts" above a list of one. Verified end to end on a freshly created
 * account: `/api/lite/posts?author=X&kind=posts` returned 1 entry while the
 * profile's SSR payload carried `post_count: 2` and the tab chip read "Posts 2".
 * The list was right and the label was wrong — a Lumen reply is a row in this
 * same table carrying a `parent_ref`, exactly as `getUserPosts(kind:'posts')`
 * defines it, so the count now uses that same definition and the two cannot
 * disagree.
 *
 * ★ Must also exclude moderation-hidden rows, and this was measured wrong once
 * before: an account with three posts, one of them taken down, advertised
 * "3 Posts" above a list of two. A count that disagrees with the list it labels
 * reads as a bug in the list — and worse, it silently tells the world that
 * something was removed. The visibility rule here is deliberately the same one
 * `getUserPosts` and `listRecent` apply, so all three can only ever agree.
 *
 * ★ NOT a general "how much has this person written" counter. `countAuthoredByUser`
 * below is that, deliberately, and answers a different question for a different
 * caller — see its own note. If a future caller wants posts+comments, it gets its
 * own function rather than loosening this one, because this one's correctness is
 * defined by the label above it.
 */
export async function countRootPostsByUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lumen_post
      WHERE user_id = $1 AND deleted_locally = false AND feed_visibility = 'visible'
        AND parent_ref IS NULL`,
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

/**
 * Has this person ever written ANYTHING here — post or comment, visible or not?
 *
 * ★ Deliberately ignores `feed_visibility` and `deleted_locally`, unlike
 * `countRootPostsByUser` above (which also counts ROOT posts only, because it is
 * printed under the word "Posts"). This answers "is this a blank-slate reader?", which the
 * interest picker uses to decide whether to introduce itself
 * (owner rule, 2026-08-08: the picker fires only for an account with zero posts
 * and zero comments, and only if it has not fired before).
 *
 * Counting only VISIBLE rows would be a trap: hiding a batch of posts — which a
 * moderator action or a QA cleanup does routinely — would make established
 * authors look like new readers and re-prompt them. Someone who wrote and then
 * deleted is still not a blank slate.
 */
export async function countAuthoredByUser(userId: string): Promise<number> {
  const res = await query<{ n: string }>(`SELECT count(*)::text AS n FROM lumen_post WHERE user_id = $1`, [
    userId
  ]);
  return Number(res.rows[0]?.n ?? 0);
}
