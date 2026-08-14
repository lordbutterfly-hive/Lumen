'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchAccount } from '@/blog/lib/chain-fetch';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useFollowersInfiniteQuery } from '@/blog/features/account-lists/hooks/use-followers-infinitequery';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import FollowListView, { type FollowListEntry } from '@/blog/features/account-lists/follow-list/follow-list-view';
import { FOLLOW_LIST_PAGE_SIZE } from '@/blog/features/account-lists/follow-list/tokens';

/**
 * `/@user/followers`.
 *
 * All chrome now lives in `FollowListView` (features/account-lists/follow-list),
 * which this page and `/@user/following` share. What is left here is exactly the
 * data this route owns: the followers cursor, the page index, and the count.
 *
 * ★ WHAT THIS FILE NO LONGER DOES, and why each was removed:
 *   - the `div.p-2` wrapper: it made the list 16px narrower than the masthead.
 *   - two `<h1>` "Followers page 1 from 54" sentences: not grammatical, and a
 *     page counter is not a heading — the masthead already carries the h1.
 *   - two `<PrevNextButtons>` blocks: rendered above AND below, both in the
 *     `outlineRed` variant whose `text-ink-info-1` is rgb(71,85,105), a colour
 *     that appears nowhere else in the product.
 *   - the whole-list `isMutating` spinner overlay: every row's own Follow button
 *     already shows and disables itself while its mutation is in flight, so the
 *     overlay greyed out 49 rows the reader was not touching.
 */
const FollowersContent = ({
  username,
  initialFollowers
}: {
  username: string;
  initialFollowers: IFollow[] | null;
}) => {
  const [page, setPage] = useState(0);
  const { user } = useUserClient();
  /**
   * ★★★ SEEDED FROM THE SESSION COOKIE, NOT `useUserClient()` (2026-08-12, G1).
   * Raw `user.isLoggedIn`/`user.username` cannot answer during SSR, so the
   * viewer's own follow/mute list fetches below started late and every row's
   * control was hidden until `/api/users/me` returned. `user` (raw, unchanged)
   * still goes down into the row actions, which need `account_tier` — not a
   * field on `identity`.
   */
  const identity = useSessionIdentity();

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `enabled` gate). See `apps/blog/app/api/account/route.ts`.
  const { data: profileData } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => fetchAccount(username)
  });

  const followersData = useFollowersInfiniteQuery(username, FOLLOW_LIST_PAGE_SIZE, initialFollowers);
  const following = useFollowingInfiniteQuery(identity.username, 1000, 'blog', ['blog']);
  const mute = useFollowingInfiniteQuery(identity.username, 1000, 'ignore', ['ignore']);

  const handleNextPage = () => {
    if (!followersData.data) return;

    if (page + 1 < followersData.data.pages.length) {
      return setPage((prev) => prev + 1);
    }
    // ★ ADVANCE ONLY IF THE PAGE ACTUALLY ARRIVED.
    // react-query's `fetchNextPage()` RESOLVES on failure too, so `.then()` fired
    // regardless and `page` moved to an index that was never fetched: the list
    // body rendered empty, the pagination chrome duplicated, "page 3 of 287" was
    // a claim about nothing, and Next went permanently disabled with no error —
    // recoverable only by a full reload. Pre-existing; surfaced by a forced
    // network failure 2026-08-07.
    followersData.fetchNextPage().then((result) => {
      if (result.isError) return;
      setPage((prev) => prev + 1);
    });
  };
  const handlePrevPage = () => {
    if (page <= 0) return;
    setPage((prev) => prev - 1);
  };

  const items: FollowListEntry[] = useMemo(
    () => (followersData.data?.pages[page] ?? []).map((edge) => ({ username: edge.follower })),
    [followersData.data?.pages, page]
  );

  // Every follower fetched so far, for the search's client-side half.
  const loadedNames = useMemo(
    () => (followersData.data?.pages ?? []).flat().map((edge) => edge.follower),
    [followersData.data?.pages]
  );

  const followerCount = profileData?.follow_stats?.follower_count;
  const totalPages = followerCount ? Math.ceil(followerCount / FOLLOW_LIST_PAGE_SIZE) : 1;

  return (
    <FollowListView
      variant="followers"
      account={username}
      items={items}
      loadedNames={loadedNames}
      isLoading={followersData.isLoading}
      totalCount={followerCount}
      page={page}
      totalPages={totalPages}
      hasNextPage={!!followersData.hasNextPage}
      hasPrevPage={page > 0}
      isPageLoading={followersData.isFetchingNextPage}
      onNextPage={handleNextPage}
      onPrevPage={handlePrevPage}
      user={user}
      follow={following}
      mute={mute}
    />
  );
};

export default FollowersContent;
