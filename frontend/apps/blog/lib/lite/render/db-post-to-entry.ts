import { liteConfig } from '../config';
import { Entry, JsonMetadata } from '@hive/common-hiveio-packages/wax';
import { LumenPost } from '../types';

/**
 * Adapt a DB post to the bridge `Entry` shape the feed renders (spec §E.1).
 * Pre-publish, the author is the lite user's `display_name` so the card renders
 * and links (`/@{display_name}`) as their own — Lumen resolves that namespace
 * DB-first. Post-publish, the chain entry is fetched under its REAL author and the
 * lite identity is laid over it (see render/lite-entry.ts).
 */
export function dbPostToEntry(post: LumenPost, publicName?: string): Entry {
  // `publicName` is the author's name TODAY (see render/current-name.ts). It differs
  // from the snapshot after an upgrade, when the account has a new Hive name and its
  // whole Lumen history has to move with it. Callers that cannot resolve it fall back
  // to the snapshot rather than rendering nothing.
  const author = publicName || post.displayNameSnapshot;
  const permlink = post.hivePermlink ?? `lite-${post.postId.toLowerCase()}`;
  const created = post.createdAt.toISOString();

  const json_metadata: JsonMetadata = {
    image: post.thumbnailUrl ?? '',
    images: post.thumbnailUrl ? [post.thumbnailUrl] : [],
    author,
    tags: post.tags,
    app: 'lumen/1.0',
    summary: post.summary ?? undefined
  };

  return {
    // Marked as already-resolved. The client overlay used to infer that from the author
    // string matching the lite name — which anyone could arrange by registering that
    // name on Hive, since a lite handle is by construction a name that was FREE on Hive
    // at signup. An explicit flag cannot be forged from chain data.
    // The account that signed it — or, before publishing, the one that WILL. Never the
    // empty string: consumers use this as the target of chain operations, and '' is a
    // value `??` cannot catch, so it silently became "no author" at every call site.
    _lite: {
      author,
      title: post.title,
      chainAuthor: post.hiveAuthor || liteConfig.frontendAccount,
      // See LiteIdentity.userId — the identity the block filters key on.
      userId: post.userId
    },
    active_votes: [],
    author,
    author_payout_value: '0.000 HBD',
    author_reputation: 0,
    beneficiaries: [],
    blacklists: [],
    body: post.body,
    category: post.community ?? 'blog',
    children: 0,
    community: post.community ?? undefined,
    created,
    curator_payout_value: '0.000 HBD',
    depth: post.parentRef ? 1 : 0,
    is_paidout: false,
    json_metadata,
    max_accepted_payout: '1000000.000 HBD',
    net_rshares: 0,
    payout: 0,
    payout_at: created,
    pending_payout_value: '0.000 HBD',
    percent_hbd: 10000,
    permlink,
    post_id: 0,
    promoted: '0.000 HBD',
    replies: [],
    title: post.title,
    updated: created,
    url: `/@${author}/${permlink}`,
    // ★ TRUTHFUL FLAG (O7 F2a/F2b, 2026-08-13). This was unconditionally `true` —
    // meaning a lite entry that has ALREADY been broadcast to Hive (`hivePermlink`
    // set) still claimed to be "not yet published" forever. Two proven, separate
    // consumers of that lie:
    //   1. A published lite reply is served from BOTH `/api/lite/posts/replies`
    //      (this constructor, keyed on the lite author) and `/api/discussion`
    //      (the chain copy, keyed on the real publishing account). The two
    //      author strings never match, so the post page's union renders both —
    //      and this constructor's copy carried a permanent "Publishing…"
    //      spinner on what was, in reality, a fully-landed comment.
    //   2. `comment-list-item.tsx`'s badge had no way to tell "just broadcast,
    //      resolving in seconds" from "queued for hours/days" — both read this
    //      one flag as the same truth.
    // `!post.hivePermlink` is exactly "has this row actually reached chain yet".
    // The dedup fix for (1) itself lives in `content.tsx` (out of this file's
    // ownership per the build map's file partition) — this one-line change does
    // not deduplicate the row, but it does kill the permanent spinner on it,
    // which was the visible harm.
    _optimistic: !post.hivePermlink
  };
}
