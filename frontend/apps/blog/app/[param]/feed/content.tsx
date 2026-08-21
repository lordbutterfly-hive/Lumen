'use client';

import PostsContent from '@/blog/features/account-profile/posts-content';

const query = 'feed';

/*
 * ★ THE READER'S OWN FEED USES THE SAME CARD AS EVERY OTHER FEED (2026-08-21,
 * owner: "bring the feed page onto the new card").
 *
 * This route rendered the classic dense list row while home, topics, search and
 * the profile Posts tab all rendered `MediumPostCard` — so the one feed a reader
 * thinks of as *theirs* was the odd one out: no identity cluster, thumbnail on
 * the other side, payout beside the vote count instead of on the card's right
 * edge. `variant` is the only change; the data path, pagination and infinite
 * scroll are untouched.
 *
 * The sibling Comments tab deliberately keeps `classic` — see `posts-loader.tsx`
 * for why a reply does not belong in an editorial card.
 */
const Content = () => <PostsContent query={query} variant="medium" />;

export default Content;
