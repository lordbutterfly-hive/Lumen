'use client';

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
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
  const { ref, inView } = useInView();
  // Create a separate ref for prefetching - triggers earlier than the main ref
  const { ref: prefetchRef, inView: prefetchInView } = useInView({
    // Start prefetching when element is 1500px from entering viewport
    rootMargin: '1500px 0px',
    // Only trigger once per element
    triggerOnce: false
  });

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

  // Auto-fetch the next page when either the prefetch sentinel (1500px ahead)
  // or the load-more button enters view. Guard on !isFetching so a single cycle
  // can't fire while any fetch is in flight — otherwise empty/short pages keep
  // the sentinel in view and we'd loop until exhausting the feed.
  useEffect(() => {
      // ★ DO NOT REFIRE INTO A FAILURE.
      // The sentinel refired every time a failed attempt's retries exhausted —
      // roughly one request every 2s, unbounded, for as long as the reader sat
      // at the bottom of the list — while the control read "Loading". Adding
      // `!isError` stops the storm and lets the button say what happened.
    if ((prefetchInView || inView) && hasNextPage && !isFetching && !isError) {
      fetchNextPage();
    }
  }, [prefetchInView, inView, hasNextPage, isFetching, isError, fetchNextPage]);

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
    return <LumenLoader size="lg" />;
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
                {/* Add prefetch trigger before the last page, when we have more than one page */}
                {pageIndex === data.pages.length - 1 && totalPosts > 10 && (
                  <div ref={prefetchRef} className="h-1 w-full" aria-hidden="true" />
                )}
              </div>
            ) : null;
          })}
      <div>
        <button ref={ref} onClick={() => fetchNextPage()} disabled={!hasNextPage || isFetchingNextPage}>
          {isFetchingNextPage && !!data && data.pages.length > 0 ? (
            <div>Loading...</div>
          ) : hasNextPage ? (
            t('user_profile.load_newer')
          ) : data?.pages?.[0] && data.pages[0].length > 0 ? (
            t('user_profile.nothing_more_to_load')
          ) : null}
        </button>
      </div>
      <div>{isFetching && !isFetchingNextPage ? 'Background Updating...' : null}</div>
    </>
  );
};
export default SortedPagesPosts;
