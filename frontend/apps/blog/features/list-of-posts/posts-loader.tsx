'use client';

import PostListItem from '@/blog/features/list-of-posts/post-list-item';
import MediumPostCard from '@/blog/features/discovery-feed/medium-post-card';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { Preferences } from '@/blog/lib/utils';
import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { useRankLuminosity, useRankMarks } from '@/blog/features/retention/hooks/use-rank-marks';
import { useTokenPriceChips } from '@/blog/features/creator-tokens/live/use-token-price-chips';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★ TWO CARDS, ONE LIST, CHOSEN BY THE ROUTE (2026-08-21, owner: "bring the
 * feed page onto the new card").
 *
 * `/@user/feed` rendered `PostListItem`, the CLASSIC card, while every other
 * feed in the product — home, topics, search, the profile Posts tab — rendered
 * `MediumPostCard`. Same posts, visibly different object: no identity cluster,
 * thumbnail on the opposite side, payout inline beside the vote count instead of
 * anchored right. A reader's own feed looked like a different product.
 *
 * ★ WHY A VARIANT AND NOT A STRAIGHT SWAP. This component is also the list for
 * the profile COMMENTS tab, through the same `PostsContent`. A comment is not a
 * post: `MediumPostCard` renders a headline, a dek, a thumbnail column and a
 * top-comment drawer, none of which a reply has. Swapping unconditionally would
 * have quietly rebuilt the Comments tab as something it is not. So the route
 * asks for the card it wants and `classic` stays the default — the conservative
 * direction, since every existing caller keeps exactly what it had.
 *
 * ★★ THE BATCHED HOOKS ARE CALLED UNCONDITIONALLY, above the branch. They are
 * hooks, so they cannot live inside the `variant === 'medium'` arm without
 * breaking the rules of hooks. Each is a no-op on an empty handle list, so the
 * classic path pays nothing for them. All three are ONE request per page, never
 * one per card — see `use-rank-marks.ts` and `use-token-price-chips.ts`, both of
 * which document the N+1 this codebase has already paid for twice.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const PostList = ({
  data,
  isCommunityPage,
  testFilter,
  nsfwPreferences,
  variant = 'classic'
}: {
  data: Entry[];
  isCommunityPage?: boolean;
  testFilter?: string;
  nsfwPreferences: Preferences['nsfw'];
  /**
   * `classic` = `PostListItem`, the dense list row this component has always
   * rendered. `medium` = `MediumPostCard`, the editorial card every other feed
   * uses. Defaults to `classic` so no existing caller changes by accident.
   */
  variant?: 'classic' | 'medium';
}) => {
  const { user } = useUserClient();
  const { data: blacklist } = useFollowListQuery(user.username, 'blacklisted');

  const posts = data?.filter((post) => post?.author && post.permlink) ?? [];
  const authors = posts.map((p) => p.author);
  const marks = useRankMarks(authors);
  const { prices } = useTokenPriceChips(authors);
  const luminosity = useRankLuminosity(authors);

  return (
    <ul data-testid={`post-list-${testFilter}`}>
      {posts.map((post: Entry) =>
        variant === 'medium' ? (
          /* `MediumPostCard` renders its own <article>; the <li> keeps this a
             real list for assistive tech, which is what the classic path relied
             on `PostListItem`'s own <li> for. */
          <li key={`${post.author}/${post.permlink}`}>
            <MediumPostCard
              post={post}
              mark={marks.get(post.author?.toLowerCase() ?? '')}
              price={prices.get(post.author)}
              luminosity={luminosity.get((post.author ?? '').toLowerCase())}
            />
          </li>
        ) : (
          <PostListItem
            nsfwPreferences={nsfwPreferences}
            post={post}
            key={`${post.author}/${post.permlink}`}
            isCommunityPage={isCommunityPage}
            blacklist={blacklist}
          />
        )
      )}
    </ul>
  );
};

export default PostList;
