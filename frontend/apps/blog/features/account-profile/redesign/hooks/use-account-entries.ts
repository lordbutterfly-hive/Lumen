'use client';

import { useEffect } from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';

// 'posts' (author-only, via bridge.get_account_posts sort='posts') — NOT
// 'blog', which also includes reblogs. The profile's Posts tab must show
// only what this account itself wrote (issue: reblogs were leaking in).
export type AccountEntryQuery = 'posts' | 'comments';

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
/**
 * ★★★ A LITE ACCOUNT'S POSTS ARE NOT ON HIVE UNDER ITS OWN NAME.
 *
 * Measured 2026-08-06 on a signed-in production build: the profile of a Lumen
 * lite author showed "3 Posts" in the stat bar above a list that never filled.
 * The count came from Lumen's database; the LIST asked
 * `bridge.get_account_posts {account: "<lite name>"}`, and Hive answered
 * `Account <lite name> does not exist` — three React Query retries, then an
 * empty tab. The posts were on chain the whole time, under the publisher
 * account with a `lumen_user_id` in their metadata, which is exactly why no
 * query keyed on the author's handle could ever find them.
 *
 * So the source has to follow the account TYPE, not the page. `lite` comes from
 * `_temporary` on the stand-in profile — the same signal the follow button
 * already uses to know a follow can only live on Lumen.
 */
async function fetchLiteAuthorEntries(
  username: string,
  query: AccountEntryQuery,
  before?: string
): Promise<Entry[]> {
  const params = new URLSearchParams({ author: username, kind: query, limit: '20' });
  if (before) params.set('before', before);
  const res = await fetch(`/api/lite/posts?${params.toString()}`);
  if (!res.ok) throw new Error(`lite posts ${res.status}`);
  const body = (await res.json()) as { entries?: Entry[] };
  return body.entries ?? [];
}

export function useAccountEntries(
  username: string,
  query: AccountEntryQuery,
  observer: string,
  initialEntries?: Entry[] | null,
  lite = false
): UseInfiniteQueryResult<Entry[]> & { entries: Entry[]; loadMoreRef: (node?: Element | null) => void } {
  const { ref, inView } = useInView({ rootMargin: '600px 0px' });
  const seed = lite ? undefined : initialEntries;

  const result = useInfiniteQuery({
    queryKey: ['profileRedesignEntries', username, query, observer, lite],
    queryFn: async ({ pageParam }: { pageParam?: PageParam }) =>
      lite
        ? await fetchLiteAuthorEntries(username, query, pageParam?.permlink)
        : (await getAccountPosts(query, username, observer, pageParam?.author ?? '', pageParam?.permlink ?? '')) ?? [],
    getNextPageParam: (lastPage) => {
      if (!Array.isArray(lastPage) || lastPage.length === 0) return undefined;
      const last = lastPage[lastPage.length - 1];
      if (!last?.author || !last?.permlink) return undefined;
      // The lite route pages on OUR post id (`before=`), which is embedded in the
      // permlink as `lite-<id>` pre-publish and `lumen-<id>` once on chain. Send
      // the id itself, not the permlink, or the cursor never matches a row.
      if (lite) {
        const id = /^(?:lite|lumen)-(.+)$/i.exec(last.permlink)?.[1];
        return id ? { permlink: id.toUpperCase() } : undefined;
      }
      return { author: last.author, permlink: last.permlink };
    },
    enabled: Boolean(username),
    // ★ Never seed a lite profile from the SSR prefetch. That prefetch is the
    //   bridge call, which for a lite handle returns nothing — and because an
    //   empty array is truthy, seeding it would install "no posts" as fresh data
    //   for the whole 2-minute staleTime and suppress the fetch that works.
    initialData: seed ? { pages: [seed], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: seed ? Date.now() : undefined,
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
