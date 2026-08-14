'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import {
  FEED_AUTO_PAGE_CAP,
  useInfiniteScrollSentinel
} from '@/blog/features/discovery-feed/hooks/use-infinite-scroll-sentinel';
import { getPostsRanked } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { DEFAULT_OBSERVER, DEFAULT_PREFERENCES, Preferences, SortTypes, chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { Entry } from '@hive/common-hiveio-packages/wax';
import PostList from '../list-of-posts/posts-loader';
import NoDataError from '@/blog/components/no-data-error';
import { isCommunity } from '@ui/lib/utils';
import { LumenLoader } from '@hive/ui';
import { useSSRObserver, useInitialPosts } from '@/blog/components/observer-provider';

/**
 * ★★★ THIS COMPONENT IS NOT REACHABLE FROM ANY ROUTE (verified 2026-08-13).
 *
 * `/trending/[tag]`, `/hot/[tag]`, `/created/[tag]`, `/payout/[tag]` and
 * `/muted/[tag]` are all one-line `redirect()` pages to `/topics/[tag]`, and
 * their `/my` and bare variants redirect to `/`. Nothing under `app/` imports
 * this file or `features/tags-pages/sort-page.tsx` — the same conclusion
 * `features/votes/hooks/use-vote-mutation.ts` already records for the
 * `entriesInfinite` query key it defines.
 *
 * So the infinite-scroll fixes below are applied for shape, not for a measured
 * effect: this list carried the identical double-fetching, unbounded sentinel
 * as its live siblings, and leaving the defect sitting in a file someone may
 * revive is how it comes back. It is STRUCTURALLY UNREACHABLE and therefore
 * UNTESTABLE in a browser — no before/after numbers are claimed for it.
 */
const SortedPagesPosts = ({ sort, tag = '' }: { sort: SortTypes; tag?: string }) => {
  const ssrObserver = useSSRObserver();
  const initialPosts = useInitialPosts();
  const { user, isHydrated } = useUserClient();
  /**
   * ★ THE "enabled" GATE WAS LAGGING BEHIND THE OBSERVER IT SITS NEXT TO
   * (2026-08-12, G2). `observer` already goes out of its way to use the
   * cookie/SSR-aware `ssrObserver` before hydration specifically so the query
   * key matches what the server prefetched — but the `enabled` flag for the
   * "my" (following) feed below was still gated on raw `user.isLoggedIn`, which
   * cannot answer during SSR and reports signed-out until `/api/users/me`
   * returns. So a signed-in reader on `/created` (tag `my`) could have the whole
   * infinite query wrongly disabled for that window even though `observer` was
   * already correct. `identity.isLoggedIn` (server-session.tsx) is seeded from
   * the same session cookie `ssrObserver` is built from, so the two now agree
   * from the first render.
   */
  const identity = useSessionIdentity();
  // Use SSR observer before hydration to match prefetched cache keys,
  // then switch to client observer (which should be the same value for logged-in users)
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;
  const { t } = useTranslation('common_blog');

  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );

  const { data, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, isError, error, isLoading } = useInfiniteQuery({
    queryKey: ['entriesInfinite', sort, tag, observer],
    queryFn: async ({ pageParam }) => {
      const { author, permlink } = (pageParam as { author?: string; permlink?: string }) || {};
      const postsData = await getPostsRanked(sort, tag, author ?? '', permlink ?? '', observer);
      return postsData ?? [];
    },
    getNextPageParam: (lastPage: Entry[]) => {
      if (!Array.isArray(lastPage) || lastPage.length === 0) return undefined;
      const last = lastPage[lastPage.length - 1] as { author?: string; permlink?: string };
      if (!last?.author || !last?.permlink) return undefined;
      return { author: last.author, permlink: last.permlink };
    },
    // Don't fetch "my communities" for anonymous users — the API would return
    // hive.blog's subscriptions which are meaningless to the actual user.
    enabled: !(tag === 'my' && !identity.isLoggedIn),
    // Server-fetched data passed directly via context, bypassing Hydrate/dehydrate
    // which has compatibility issues with Next.js App Router streaming SSR in RQ v4.
    // initialData is only used when the query has no cached data (first load).
    initialData: initialPosts ? { pages: [initialPosts], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: initialPosts ? Date.now() : undefined,
    staleTime: StaleTime.MEDIUM
  });

  // ★ ONE GEOMETRY-GATED, PAGE-CAPPED SENTINEL, at the same 1500px lead the
  // prefetch observer used to have. Both the "do not refire into a failure"
  // guard (`isError`) and the FX3 "keep paging through a fully filtered page"
  // behaviour are preserved by the hook; the double fetch per gesture and the
  // unbounded accumulation are not. See
  // features/discovery-feed/hooks/use-infinite-scroll-sentinel.ts.
  const sentinel = useInfiniteScrollSentinel({
    hasNextPage,
    isFetching,
    isError,
    fetchNextPage,
    rootMarginPx: 1500,
    pagesLoaded: data?.pages?.length ?? 0,
    autoPageCap: FEED_AUTO_PAGE_CAP
  });

  // Calculate total posts to determine when to show prefetch trigger
  const totalPosts = data?.pages?.reduce((acc, page) => acc + (page?.length || 0), 0) || 0;

  // ★ "Tag X does not exist" IS AN EMPTY RESULT, NOT A FAILURE.
  //
  // Hive answers a tag nobody has posted under with an assertion —
  // `assert_exception: Tag <x> does not exist` — so React Query calls it an
  // error and the reader was shown "There was a problem fetching the data.
  // Please check if permlink is correct or the node is running properly." for a
  // page the app had already labelled "Unmoderated tag" in its own header. The
  // node is fine; the tag is simply empty. Verified against api.hive.blog.
  const tagSimplyEmpty = /does not exist/i.test(
    error instanceof Error ? error.message : JSON.stringify(error ?? '')
  );

  // Only when there is nothing to show: a failed `fetchNextPage` must not wipe
  // out the pages already rendered (same fault as the profile tabs).
  if (isError && totalPosts === 0 && !tagSimplyEmpty) {
    return <NoDataError />;
  }

  // Handle initial loading state (also show skeleton when refetching with no data,
  // e.g. during observer transition after hydration)
  if (isLoading || (isFetching && !data?.pages?.[0]?.length)) {
    return <LumenLoader size="lg" label={t('global.loading_posts')} />;
  }

  // Handle empty feed for "my" (friends) page
  // Guard with !isFetching to avoid flash during observer transition
  // (when hydration briefly changes observer before auth state resolves)
  const isEmpty = !data?.pages?.[0]?.length || (isError && tagSimplyEmpty);
  if (isEmpty && tag === 'my' && !isFetching) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-lg text-primary/70">{t('user_profile.empty_feed_not_following')}</p>
      </div>
    );
  }
  // ★ A TAG WITH NO POSTS IS NOT A BROKEN NODE, AND IT IS NOT NOTHING EITHER.
  // A tag nobody has posted under rendered a blank column (or, when the upstream
  // call also failed, the "problem fetching the data… check if the node is
  // running properly" panel — for a page the app had already correctly labelled
  // "Unmoderated tag"). Both leave the reader unable to tell "no posts" from
  // "something is wrong".
  if (isEmpty && !isFetching) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-lg text-primary/70">{t('tags_page.no_posts_for_tag', { tag })}</p>
      </div>
    );
  }

  return (
    <>
      {!data
        ? null
        : data.pages.map((page, pageIndex) => {
            return page ? (
              <div key={`page-${pageIndex}`}>
                <PostList
                  nsfwPreferences={preferences.nsfw}
                  data={page}
                  key={`f-${pageIndex}`}
                  isCommunityPage={isCommunity(tag)}
                  testFilter={sort}
                />
                {/* The separate 1px prefetch trigger that sat here is gone —
                    it was the second of two observers driving one effect, and
                    it only rendered above 10 posts. The single sentinel on the
                    button below carries the 1500px lead unconditionally. */}
              </div>
            ) : null;
          })}
      <div className="flex items-center gap-3">
        <button
          ref={sentinel.ref}
          onClick={() => (sentinel.atPageCap ? sentinel.loadMore() : fetchNextPage())}
          disabled={!hasNextPage || isFetchingNextPage}
        >
          {isFetchingNextPage && !!data && data.pages.length > 0 ? (
            <div>Loading...</div>
          ) : sentinel.atPageCap ? (
            t('cards.comment_card.load_more')
          ) : hasNextPage ? (
            t('user_profile.load_newer')
          ) : data?.pages?.[0] && data.pages[0].length > 0 ? (
            t('user_profile.nothing_more_to_load')
          ) : null}
        </button>
        {sentinel.atPageCap ? (
          <button type="button" onClick={sentinel.backToTop}>
            Back to top
          </button>
        ) : null}
      </div>
      <div>{isFetching && !isFetchingNextPage ? 'Background Updating...' : null}</div>
    </>
  );
};
export default SortedPagesPosts;
