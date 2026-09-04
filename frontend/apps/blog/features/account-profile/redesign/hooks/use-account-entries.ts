'use client';

import { useInfiniteQuery, type UseInfiniteQueryResult } from '@tanstack/react-query';
import {
  FEED_AUTO_PAGE_CAP,
  useInfiniteScrollSentinel,
  type InfiniteScrollSentinel
} from '@/blog/features/discovery-feed/hooks/use-infinite-scroll-sentinel';
import { fetchAccountPostsPage } from '@/blog/lib/lite/client/account-posts-fetch';
import type { Entry } from '@hive/common-hiveio-packages/wax';
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

/**
 * One page as this hook stores it.
 *
 * It is an object rather than a bare `Entry[]` because the entries alone can no longer
 * answer "is there another page". `/api/account-posts` filters the node's page three
 * times (operator ban list, profile owner's blocks, viewer's own list), so a page that
 * arrives empty or short is not necessarily the end of the account. The server's own
 * `hasMore`/`nextCursor` travel with the entries and decide paging.
 */
export interface AccountEntriesPage {
  entries: Entry[];
  nextCursor: { author: string; permlink: string } | null;
  hasMore: boolean;
}

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
): UseInfiniteQueryResult<AccountEntriesPage> & {
  entries: Entry[];
  loadMoreRef: (node?: Element | null) => void;
  sentinel: InfiniteScrollSentinel;
} {
  const seed = lite ? undefined : initialEntries;
  const seedLast = seed && seed.length > 0 ? seed[seed.length - 1] : null;

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
    // ★ THE CHAIN BRANCH PAGES ON THE SERVER'S ANSWER, NOT ON `length` (2026-08-23).
    // `/api/account-posts` filters three times over (operator ban list, the profile
    // owner's blocks, then the viewer's own), so the array that arrives here is not the
    // page the node returned. Keying "is there more" on its length stopped paging on any
    // page the filters emptied, with the rest of the account still behind it. The route
    // now reports `hasMore` and `nextCursor` from the RAW page and this follows them.
    queryFn: async ({ pageParam }: { pageParam?: PageParam }): Promise<AccountEntriesPage> => {
      if (lite) {
        const liteEntries = (await fetchLiteAuthorEntries(username, query, pageParam?.permlink)) ?? [];
        return { entries: liteEntries, nextCursor: null, hasMore: liteEntries.length > 0 };
      }
      return await fetchAccountPostsPage(
        BRIDGE_SORT_FOR_QUERY[query],
        username,
        observer,
        pageParam?.author ?? '',
        pageParam?.permlink ?? ''
      );
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage) return undefined;
      // The lite route pages on OUR post id (`before=`), which is embedded in the
      // permlink as `lite-<id>` pre-publish and `lumen-<id>` once on chain. Send
      // the id itself, not the permlink, or the cursor never matches a row. It has no
      // server-side cursor, so it still reads its own last VISIBLE entry — correct
      // there, because that route applies no filter this hook cannot see.
      if (lite) {
        const last = lastPage.entries[lastPage.entries.length - 1];
        if (!last?.permlink) return undefined;
        const id = /^(?:lite|lumen)-(.+)$/i.exec(last.permlink)?.[1];
        return id ? { permlink: id.toUpperCase() } : undefined;
      }
      if (!lastPage.hasMore || !lastPage.nextCursor) return undefined;
      return { author: lastPage.nextCursor.author, permlink: lastPage.nextCursor.permlink };
    },
    enabled: Boolean(username),
    // ★ Never seed a lite profile from the SSR prefetch. That prefetch is the
    //   bridge call, which for a lite handle returns nothing — and because an
    //   empty array is truthy, seeding it would install "no posts" as fresh data
    //   for the whole 2-minute staleTime and suppress the fetch that works.
    initialData: seed
      ? {
          // The SSR seed is a raw bridge read, so it carries no server cursor. Rebuild one
          // from its own last entry, and let `hasMore` stay true while it looks full — a
          // seed that stopped paging outright would strand every page after the first.
          pages: [
            {
              entries: seed,
              nextCursor: seedLast ? { author: seedLast.author, permlink: seedLast.permlink } : null,
              hasMore: seed.length > 0
            }
          ],
          pageParams: [undefined]
        }
      : undefined,
    // ★ SEED IT FRESH, NOT STALE (T1g, 2026-09-04). The 2026-08-13 reasoning this
    // replaces: `Date.now()` told React Query the server-rendered page was freshly
    // fetched, so `staleTime` blocked the `queryFn` — and the queryFn (via
    // `/api/account-posts`) was the ONLY place Lumen's own engagement (a lite
    // reader's votes and reblogs, which never touch the chain) got merged in. A
    // fresh-looking seed with no merge froze a reader's just-cast Lumen vote at its
    // pre-vote count until the window expired.
    //
    // That gap is now closed at the source: `PostsPage` (posts-page.tsx) merges the
    // SAME `mergeLumenEngagement` into the SSR seed before it ever reaches here, so
    // the seed and a live `/api/account-posts` response carry identical totals. What
    // is genuinely per-VIEWER — "did I vote on this post" — was never sourced from
    // THIS query to begin with: MediumPostCard reads that off its own always-live
    // `['votes', author, permlink, voter]` query (medium-post-card.tsx), seeded from
    // the SSR `active_votes` snapshot for a chain vote or `fetchLiteEngagement` for a
    // lite voter — neither depends on this hook's staleness. So there is nothing
    // viewer-specific left for a forced revalidation to protect, for an anonymous OR
    // a signed-in reader.
    //
    // A real timestamp stops the redundant full refetch of the ~136KB page SSR
    // already sent (measured on a real profile) the instant this query mounts.
    // Reachable only when `seed` exists — never for a `lite` profile (seeded
    // `undefined` above, which never gets an SSR prefetch) or the Comments tab
    // (never seeded at all; see `profile-comments-list.tsx`).
    initialDataUpdatedAt: seed ? Date.now() : undefined,
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

  // ★ 2026-08-13. The effect that used to live here was
  //     if (inView && hasNextPage && !isFetching && !isError) fetchNextPage();
  // and it fetched TWICE for every scroll gesture — measured on :3000 against
  // `/@lordbutterfly`: one scroll to the bottom produced requests at t+21548ms
  // AND t+23675ms, then nothing for the remaining 18s of stillness. `inView` is
  // an IntersectionObserver callback delivered a task late, so it still reads
  // true for one commit after the page that landed pushed the sentinel 12,000px
  // below the viewport. The shared hook reads the sentinel's live geometry at
  // the moment of the decision instead, and caps how far passive scrolling can
  // grow the list. Full reasoning and measurements:
  // features/discovery-feed/hooks/use-infinite-scroll-sentinel.ts.
  //
  // ★ `!isError` IS NOT LOST — "do not refire into a failure" (the retry storm
  // that used to hit once every ~2s while the reader sat at the bottom) is now
  // the hook's `isError` option, same guard, one place.
  const sentinel = useInfiniteScrollSentinel({
    hasNextPage,
    isFetching,
    isError,
    fetchNextPage,
    // Unchanged from the `useInView({ rootMargin: '600px 0px' })` this replaced:
    // this list still starts paging 600px before the sentinel is on screen.
    rootMarginPx: 600,
    pagesLoaded: result.data?.pages?.length ?? 0,
    autoPageCap: FEED_AUTO_PAGE_CAP
  });

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
  const raw = result.data?.pages.flatMap((pg) => pg?.entries ?? []) ?? [];
  const entries = blockList.loaded ? raw.filter((entry) => !isBlockedEntry(entry, blockList)) : raw;
  return { ...result, entries, loadMoreRef: sentinel.ref, sentinel };
}
