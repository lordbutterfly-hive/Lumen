import { Entry, JsonMetadata } from '@hive/common-hiveio-packages/wax';
import { LumenPost } from '../types';

/**
 * Adapt a DB post to the bridge `Entry` shape the feed renders (spec §E.1).
 * Pre-publish, the author is the lite user's `display_name` so the card renders
 * and links (`/@{display_name}`) as their own — Lumen resolves that namespace
 * DB-first. Post-publish, the chain entry is fetched under its REAL author and the
 * lite identity is laid over it (see render/lite-entry.ts).
 */
export function dbPostToEntry(post: LumenPost): Entry {
  const author = post.displayNameSnapshot;
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
    _optimistic: true
  };
}
