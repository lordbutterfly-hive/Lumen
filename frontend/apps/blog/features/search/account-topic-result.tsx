import { useInfiniteQuery } from '@tanstack/react-query';
import { SearchSort } from '@ui/hooks/use-search';
import { PER_PAGE } from './lib/utils';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import Loading from '@ui/components/loading';
import { getByText } from '@transaction/lib/hive-api';
import { Link } from '@hive/ui';
import { Activity } from 'lucide-react';
import { Entry, Preferences } from '@hive/common-hiveio-packages/wax';
import { PostListItemSkeleton } from '@hive/ui';
import PostList from '../list-of-posts/posts-loader';
import { useTranslation } from '@/blog/i18n/client';
import NoDataError from '@/blog/components/no-data-error';
import { DEFAULT_OBSERVER, chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useSSRObserver } from '@/blog/components/observer-provider';

const AccountTopicResult = ({
  author,
  query,
  sort,
  nsfwPreferences,
  initialData
}: {
  query: string;
  sort: SearchSort;
  author?: string;
  nsfwPreferences: Preferences['nsfw'];
  initialData?: Entry[] | null;
}) => {
  const ssrObserver = useSSRObserver();
  const { user, isHydrated } = useUserClient();
  const { ref, inView } = useInView();
  // Use SSR observer (from cookie) before hydration to match the prefetched
  // initialData and avoid sending DEFAULT_OBSERVER for a logged-in user during
  // the brief pre-hydration window.
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;
  const { ref: prefetchRef, inView: prefetchInView } = useInView({
    // Start prefetching when element is 1500px from entering viewport
    rootMargin: '1500px 0px',
    // Only trigger once per element
    triggerOnce: false
  });

  const { t } = useTranslation('common_blog');
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isError } = useInfiniteQuery({
    queryKey: ['similarPosts', query, author, sort, observer],
    queryFn: async ({ pageParam }: { pageParam?: { author: string; permlink: string } }) => {
      return await getByText({
        pattern: query,
        author,
        observer,
        start_permlink: pageParam?.permlink ?? '',
        start_author: pageParam?.author ?? '',
        limit: PER_PAGE,
        sort
      });
    },
    getNextPageParam: (lastPage) => {
      if (lastPage && lastPage.length === PER_PAGE) {
        return {
          author: lastPage[lastPage.length - 1].author,
          permlink: lastPage[lastPage.length - 1].permlink
        };
      }
    },

    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled: !!query,
    staleTime: StaleTime.MEDIUM,
    initialData: initialData ? { pages: [initialData], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: initialData ? Date.now() : undefined
  });
  // Prefetch when user is getting close to the end
  useEffect(() => {
    if (prefetchInView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [prefetchInView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Fallback: still trigger when reaching the actual button
  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const totalPosts = data?.pages?.reduce((acc, page) => acc + (page?.length || 0), 0) || 0;

  /**
   * ★ A SEARCH THAT FAILED IS NOT A BROKEN NODE.
   *
   * The generic <NoDataError /> here told the reader "There was a problem
   * fetching the data. Please check if permlink is correct or the node is
   * running properly" — on a SEARCH page, where there is no permlink, and where
   * the node is fine.
   *
   * The real cause, measured against api.hive.blog 2026-08-06: `sort=created`
   * ("Newest") makes the search backend scan far enough to hit its own
   * statement timeout (PostgreSQL 57014) for any common word — `photography`
   * and `hive engine` both fail, while a rare term like `lumen` returns
   * instantly. So it is neither always-broken nor safely removable; it is a
   * sort that cannot serve broad queries. The reader waits ~14 s and is then
   * told to go inspect node status.
   *
   * Say what happened, and offer the one thing that will work.
   */
  // Only surrender the surface when there is nothing to show — a failed
  // `fetchNextPage` must not erase the results already on screen.
  if (isError && totalPosts === 0) {
    if (sort === 'created') {
      const fallback = author
        ? `/search?a=${encodeURIComponent(author)}&p=${encodeURIComponent(query)}&s=relevance`
        : `/search?q=${encodeURIComponent(query)}&s=relevance`;
      return (
        <div className="mx-auto flex flex-col items-center gap-3 py-10 text-center">
          <p className="font-sans text-sm text-muted-foreground">{t('search_page.newest_too_broad')}</p>
          <Link href={fallback} className="font-sans text-sm text-primary hover:underline">
            {t('search_page.try_relevance')}
          </Link>
        </div>
      );
    }
    return <NoDataError />;
  }

  return (
    <div>
      {!query ? null : isLoading ? (
        <Loading loading={isLoading} />
      ) : data ? (
        data.pages.map((page, pageIndex) => {
          return page ? (
            <div key={`ai-${pageIndex}`}>
              <PostList data={page} nsfwPreferences={nsfwPreferences} />
              {/* Add prefetch trigger before the last page, when we have more than one page */}
              {pageIndex === data.pages.length - 1 && totalPosts > 10 && (
                <div ref={prefetchRef} className="h-1 w-full" aria-hidden="true" />
              )}
            </div>
          ) : (
            ''
          );
        })
      ) : (
        <div className="mx-auto flex flex-col items-center py-8">
          <h3 className="py-4 text-lg">No Data Available</h3>
          <p className="mb-4 text-center text-muted-foreground">
            There was a problem fetching the data.
          </p>{' '}
          <Link
            href="/status/settings"
            className="mt-4 inline-flex items-center text-primary hover:underline"
          >
            <Activity className="mr-2 h-4 w-4" />
            Check Node Status
          </Link>
        </div>
      )}
      <div>
        <button
          ref={ref}
          onClick={() => {
            fetchNextPage(), console.log('fetchNextPage');
          }}
          disabled={!hasNextPage || isFetchingNextPage}
        >
          {/* ★ "Nothing more to load" is pagination copy. On a search that
              matched NOTHING it read as the only answer the page gave — the
              reader is told there is no MORE of a thing they were never shown
              any of. Say what actually happened. */}
          {isFetchingNextPage ? (
            <PostListItemSkeleton />
          ) : hasNextPage ? (
            t('user_profile.load_newer')
          ) : isLoading ? null : totalPosts === 0 ? (
            <span className="font-sans text-sm text-muted-foreground">
              {t('search_page.no_results_for', { query })}
            </span>
          ) : (
            t('user_profile.nothing_more_to_load')
          )}
        </button>
      </div>
    </div>
  );
};

export default AccountTopicResult;
