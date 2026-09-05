'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IFollow } from '@hive/common-hiveio-packages/wax';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchAccount } from '@/blog/lib/chain-fetch';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import FollowListView, { type FollowListEntry } from '@/blog/features/account-lists/follow-list/follow-list-view';
import { FOLLOW_LIST_PAGE_SIZE } from '@/blog/features/account-lists/follow-list/tokens';

/**
 * `/@user/following` (formerly `/@user/followed`).
 *
 * Shares `FollowListView` with `/@user/followers`; what stays here is the
 * following cursor, the page index, the own-profile cross-filter and the count.
 * See `../followers/content.tsx` for the list of chrome this file no longer
 * carries and why each piece went.
 */
const FollowingContent = ({
  username,
  initialFollowing
}: {
  username: string;
  initialFollowing: IFollow[] | null;
}) => {
  const [page, setPage] = useState(0);
  const { user } = useUserClient();
  /**
   * ★★★ SEEDED FROM THE SESSION COOKIE, NOT `useUserClient()` (2026-08-12, G1).
   * This page's "am I looking at my own following list" check, the viewer's-own-
   * list queries that feed it, and the per-row "hide the follow button on
   * myself" check were all off raw `useUserClient()` — blank until
   * `/api/users/me` returns — so a genuine owner's own list briefly went
   * un-cross-filtered and EVERY row's control was hidden for that window, not
   * just their own. `user` (raw, unchanged) still goes into the row actions:
   * they need `account_tier`, which does not exist on `identity`.
   */
  const identity = useSessionIdentity();

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Unconditional
  // (no `enabled` gate). See `apps/blog/app/api/account/route.ts`.
  const { data: profileData } = useQuery({
    queryKey: ['profileData', username],
    queryFn: () => fetchAccount(username)
  });

  const followingData = useFollowingInfiniteQuery(
    username,
    FOLLOW_LIST_PAGE_SIZE,
    undefined,
    undefined,
    initialFollowing
  );
  const following = useFollowingInfiniteQuery(identity.username, 1000, 'blog', ['blog']);
  const mute = useFollowingInfiniteQuery(identity.username, 1000, 'ignore', ['ignore']);

  // When viewing own profile, cross-filter list against the optimistically-correct
  // follow status query to handle stale API responses from slow Hivemind indexing.
  const isOwnProfile = identity.isLoggedIn && username === identity.username;
  const followedSet = useMemo(() => {
    if (!isOwnProfile || !following.data?.pages) return null;
    const set = new Set<string>();
    for (const p of following.data.pages) {
      for (const f of p) {
        set.add(f.following);
      }
    }
    return set;
  }, [isOwnProfile, following.data?.pages]);

  const items: FollowListEntry[] = useMemo(() => {
    const rawItems = followingData.data?.pages[page] ?? [];
    const visible = followedSet
      ? rawItems.filter((e) => e._temporary || followedSet.has(e.following))
      : rawItems;
    return visible.map((edge) => ({ username: edge.following, temporary: edge._temporary }));
  }, [followingData.data?.pages, page, followedSet]);

  // Every followed account fetched so far, for the search's client-side half.
  // Cross-filtered on an own profile for the same reason the page rows are:
  // an account you have just unfollowed must not come back through search.
  const loadedNames = useMemo(() => {
    const all = (followingData.data?.pages ?? []).flat();
    const visible = followedSet ? all.filter((e) => e._temporary || followedSet.has(e.following)) : all;
    return visible.map((edge) => edge.following);
  }, [followingData.data?.pages, followedSet]);

  const handleNextPage = () => {
    if (!followingData.data) return;

    if (page + 1 < followingData.data.pages.length) {
      // ★ NEVER STAND ON AN EMPTY PAGE -- see the fetch branch below for how one
      // gets into `pages` in the first place.
      if ((followingData.data.pages[page + 1]?.length ?? 0) === 0) return;
      return setPage((prev) => prev + 1);
    }
    // ★ ADVANCE ONLY IF THE PAGE ACTUALLY ARRIVED.
    // react-query's `fetchNextPage()` RESOLVES on failure too, so `.then()` fired
    // regardless and `page` moved to an index that was never fetched: the list
    // body rendered empty, the pagination chrome duplicated, "page 3 of 287" was
    // a claim about nothing, and Next went permanently disabled with no error —
    // recoverable only by a full reload. Pre-existing; surfaced by a forced
    // network failure 2026-08-07.
    // ★ AND ONLY IF IT ACTUALLY HAS ROWS (2026-09-05, review). `get_following` pages by
    // cursor, so a list whose length is an exact multiple of the page size
    // answers the NEXT request with ZERO rows; react-query resolves that
    // successfully and appends the empty page, and `page` moved onto it -- an
    // empty list under a "page 6 of 6" label. This refuses a GENUINELY EMPTY
    // page only; a short-but-non-empty page is a real last page and is still
    // shown.
    //
    // It is deliberately NOT a "shorter than the page size" test. A page can be
    // short because the ban filter removed a name from it, and treating that as
    // the end used to stop a 500-follower list at page one. That is fixed at the
    // root instead -- `followFetchLimit` in hive-api.ts asks the chain for
    // `limit + ban list size` rows so a full page survives the filter full --
    // and this guard is left holding only the case it can actually judge.
    followingData.fetchNextPage().then((result) => {
      if (result.isError) return;
      const pages = result.data?.pages ?? [];
      if ((pages[pages.length - 1]?.length ?? 0) === 0) return;
      setPage((prev) => prev + 1);
    });
  };
  const handlePrevPage = () => {
    if (page <= 0) return;
    setPage((prev) => prev - 1);
  };

  // Use actual count from follow status query (source of truth) when viewing own profile
  const followingCount =
    isOwnProfile && followedSet ? followedSet.size : profileData?.follow_stats?.following_count;
  // ★ COUNT-DERIVED, AS IT HAS ALWAYS BEEN (2026-09-05, final gate). The count
  // and the rows come from different places and can disagree by up to the ban
  // list's size (6 names today): `get_following` strips banned accounts from every page
  // server-side while the count may not be corrected for them at all -- it never
  // is with LUMEN_BANNED_FOLLOW_EDGES=no. So the last page can be labelled one
  // page early. That is a generous label, and it is what shipped before.
  // Deriving the total from the pages actually fetched instead was tried and was
  // WORSE: on a page the ban filter had shortened it collapsed to 1 and hid the
  // pager completely on a 500-follower account. Root cause fixed in hive-api.ts.
  const totalPages = followingCount ? Math.ceil(followingCount / FOLLOW_LIST_PAGE_SIZE) : 1;

  return (
    <FollowListView
      variant="following"
      account={username}
      items={items}
      loadedNames={loadedNames}
      isLoading={followingData.isLoading}
      totalCount={followingCount}
      page={page}
      totalPages={totalPages}
      hasNextPage={!!followingData.hasNextPage}
      hasPrevPage={page > 0}
      isPageLoading={followingData.isFetchingNextPage}
      onNextPage={handleNextPage}
      onPrevPage={handlePrevPage}
      user={user}
      follow={following}
      mute={mute}
    />
  );
};

export default FollowingContent;
