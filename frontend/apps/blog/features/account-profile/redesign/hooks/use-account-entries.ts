'use client';

import { useEffect } from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';

export type AccountEntryQuery = 'blog' | 'comments';

interface PageParam {
  author?: string;
  permlink?: string;
}

/**
 * Shared infinite-query + auto-load-more hook for the redesigned profile's
 * Posts and Comments tabs. Same `getAccountPosts` bridge call the legacy
 * `PostsContent` (features/account-profile/posts-content.tsx) uses, so the
 * underlying data is identical — only the query key and rendering differ
 * (this hook feeds MediumPostCard / ProfileCommentCard instead of the
 * classic PostList/PostListItem). Deliberately a DIFFERENT query key
 * (`profileRedesignEntries`) than the legacy hook's `accountEntriesInfinite`
 * so the two UIs' caches never collide.
 *
 * TODO: the "blog" (Posts) tab can seed `initialEntries` from the route's
 * SSR-prefetched `useInitialPosts()` context to avoid a client refetch on
 * first paint (see PostsPage / observer-provider.tsx). The "comments" tab
 * has no equivalent SSR prefetch today, so it always client-fetches.
 */
export function useAccountEntries(
  username: string,
  query: AccountEntryQuery,
  observer: string,
  initialEntries?: Entry[] | null
): UseInfiniteQueryResult<Entry[]> & { entries: Entry[]; loadMoreRef: (node?: Element | null) => void } {
  const { ref, inView } = useInView({ rootMargin: '600px 0px' });

  const result = useInfiniteQuery({
    queryKey: ['profileRedesignEntries', username, query, observer],
    queryFn: async ({ pageParam }: { pageParam?: PageParam }) =>
      (await getAccountPosts(query, username, observer, pageParam?.author ?? '', pageParam?.permlink ?? '')) ?? [],
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage) || lastPage.length === 0) return undefined;
      const last = lastPage[lastPage.length - 1];
      if (!last?.author || !last?.permlink) return undefined;
      return { author: last.author, permlink: last.permlink };
    },
    enabled: Boolean(username),
    initialData: initialEntries ? { pages: [initialEntries], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: initialEntries ? Date.now() : undefined,
    staleTime: StaleTime.MEDIUM
  });
  const { hasNextPage, isFetching, fetchNextPage } = result;

  useEffect(() => {
    if (inView && hasNextPage && !isFetching) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetching, fetchNextPage]);

  const entries = result.data?.pages.flat() ?? [];
  return { ...result, entries, loadMoreRef: ref };
}
