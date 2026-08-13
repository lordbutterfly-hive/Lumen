'use client';

import { useEffect } from 'react';
import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { fetchAccountPosts } from '@/blog/lib/lite/client/account-posts-fetch';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';

// Lumen's own label for a profile tab — a query-key and a lite-path `kind`.
// It is NOT the value Hive's bridge receives; see BRIDGE_SORT_FOR_QUERY.
export type AccountEntryQuery = 'posts' | 'comments';

/**
 * ★ A PROFILE SHOWS WHAT THAT PERSON WROTE (owner ruling, 2026-08-08).
 *
 * Hive's `sort: 'blog'` returns own posts PLUS reblogs; `sort: 'posts'` is
 * author-only. Lumen wants author-only here — **reblogs surface in the
 * Following feed on the home page instead**, which is where someone looks to
 * see what the people they follow are passing along.
 *
 * This was briefly switched to 'blog' and reverted the same day. It is not an
 * oversight; do not "fix" it. The seed in
 * `app/[param]/(user-profile)/page.tsx` must match whatever this says.
 */
const BRIDGE_SORT_FOR_QUERY: Record<AccountEntryQuery, string> = {
  posts: 'posts',
  comments: 'comments'
};

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
  const body = (await res.json()) as { entries?: Entry[]; degraded?: string | boolean };
  // ★ THROW ON `degraded`, EXACTLY AS THE CHAIN BRANCH DOES (2026-08-13,
  // adversarial review S2). `account-posts-fetch.ts` already refuses to turn a
  // failed read into "no posts"; this lite twin was answering `[]` for the same
  // class of failure, so the identical false "@user hasn't posted yet" survived on
  // the lite half of the very same Comments tab. `isError` here renders the honest
  // error branch the caller already has (`profile-comments-list.tsx`,
  // `profile-posts-list.tsx`); a genuinely empty lite account never sets the flag.
  if (body.degraded) throw new Error(`lite posts degraded: ${body.degraded}`);
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
    // ★ CHAIN BRANCH GOES THROUGH `/api/account-posts`, NOT A DIRECT CHAIN
    // READ (2026-08-12). This hook feeds the LIVE Comments tab (`?tab=comments`
    // on `/@username` -- see `profile-comments-list.tsx`), and this is exactly
    // where a post owner's block on the account being viewed has to remove
    // their replies from every reader, not just the blocker's own browser
    // (effect B, `lib/lite/social/block-filter.ts`). A filter that only runs
    // in the browser is enforced by precisely the people it exists to
    // constrain. The Posts tab query carries no `parent_author` (root posts
    // have no parent), so routing it through the same call is a no-op there
    // and keeps the two tabs on one code path.
    queryFn: async ({ pageParam }: { pageParam?: PageParam }) =>
      lite
        ? await fetchLiteAuthorEntries(username, query, pageParam?.permlink)
        : (await fetchAccountPosts(
            BRIDGE_SORT_FOR_QUERY[query],
            username,
            observer,
            pageParam?.author ?? '',
            pageParam?.permlink ?? ''
          )) ?? [],
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
    // ★ SEED IT STALE, NOT FRESH (2026-08-13). `Date.now()` here told React Query the
    // server-rendered page was freshly fetched, so the `staleTime` window blocked the
    // `queryFn` — and the queryFn is where Lumen's own engagement (a lite reader's
    // votes and reblogs, which never touch the chain) gets merged in. The SSR seed is
    // a raw chain read with no merge, so a vote a reader had just cast vanished on
    // every reload until the window expired. Verified in a browser: the count reverted
    // 2/2 on this surface while the API itself returned the correct number.
    //
    // 0 means "paint this instantly, then revalidate" — the seed still avoids a
    // loading flash, it just no longer suppresses the merge. Same two-token change
    // already applied to the post page's `postData` query for the same reason; this
    // surface was its twin and was missed.
    initialDataUpdatedAt: seed ? 0 : undefined,
    // ★ A FAILED READ MUST SURFACE FAST (2026-08-13). `/api/account-posts` now
    // THROWS on a degraded upstream read instead of answering `{entries: null}`,
    // which is correct — but this query never overrode React Query's default
    // `retry: 3`, so the honest error it now produces would sit behind three
    // attempts and ~7s of backoff before the reader is told anything. That is the
    // exact "spreads the wait to two more profile tabs" regression the sequencing
    // note warned about. One retry absorbs a genuine blip; three only delays bad news.
    retry: 1,
    staleTime: StaleTime.MEDIUM
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = result;

  useEffect(() => {
      // ★ DO NOT REFIRE INTO A FAILURE.
      // The sentinel refired every time a failed attempt's retries exhausted —
      // roughly one request every 2s, unbounded, for as long as the reader sat
      // at the bottom of the list — while the control read "Loading". Adding
      // `!isError` stops the storm and lets the button say what happened.
    if (inView && hasNextPage && !isFetching && !isError) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetching, isError, fetchNextPage]);

  // ★ EFFECT (A) STAYS HERE, EVEN THOUGH THE CHAIN BRANCH NOW GOES THROUGH OUR
  // OWN SERVER (2026-08-12, see the `fetchAccountPosts` call above).
  //
  // Effect (A) -- "I never see them again" -- is the READER's own preference,
  // and `/api/account-posts` is deliberately session-less (same reasoning as
  // `/api/discussion`): it answers the same for every caller so the response
  // can be cached and effect (B) stays a property of the ACCOUNT being
  // viewed, not of who happens to be looking. So the viewer's own block list
  // is still applied client-side, on top of whatever the server already
  // filtered. This is honest HERE and only here: the sole person who could
  // defeat it is the reader, and all they would win is seeing something they
  // asked not to see. The OTHER half of blocking -- a post owner hiding
  // somebody's replies from OTHER readers -- is effect (B), and that is now
  // enforced on the server this hook fetches from (`applyOwnerBlocksToAuthoredEntries`
  // in `lib/lite/social/block-filter.ts`), never here.
  const blockList = useLumenBlockList(Boolean(username));
  const raw = result.data?.pages.flat() ?? [];
  const entries = blockList.loaded ? raw.filter((entry) => !isBlockedEntry(entry, blockList)) : raw;
  return { ...result, entries, loadMoreRef: ref };
}
