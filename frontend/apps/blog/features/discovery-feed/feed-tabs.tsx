'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { StaleTime } from '@/blog/lib/react-query';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { PostListSkeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import NoDataError from '@/blog/components/no-data-error';
import MarketTab from '@/blog/features/prediction-market/market-tab';
import MediumPostCard from './medium-post-card';
import LiteFeedStrip from './lite-feed-strip';
import InterestPicker from '@/blog/features/lite-auth/interests/interest-picker';

// TODO: move to i18n
const LABELS = {
  forYou: 'For You',
  feed: 'Following',
  predictions: 'Prediction Market',
  loadingMore: 'Loading…',
  loadMore: 'Load more',
  nothingMore: "You're all caught up",
  empty: 'No posts yet.',
  degraded: 'Personalised ranking is warming up — showing popular posts meanwhile.',
  degradedAnonymous: 'Log in to see posts picked for you — showing trending posts for now.',
  loginPrompt: 'Log in to see your Feed'
};

type TabKey = 'for-you' | 'feed' | 'predictions';
const TAB_KEYS: readonly TabKey[] = ['for-you', 'feed', 'predictions'];
const TAB_PARAM = 'tab';

function toTabKey(raw: string | null): TabKey {
  return raw !== null && (TAB_KEYS as readonly string[]).includes(raw) ? (raw as TabKey) : 'for-you';
}

// ★★★ "For You" IS THE RANKING ENGINE NOW (2026-08-06).
//
// This used to be `const FOR_YOU_SORT: SortTypes = 'trending'` behind a
// PLACEHOLDER/TODO — Hive's global payout-ranked list, byte-identical for every
// viewer, on a product built around its own recommender. recsys had been
// hardened across five councils and 870 tests and had no consumer at all.
// `ForYouFeed` below calls `/api/feed/for-you`, which is that consumer.
//
// `trending` survives ONLY as the fallback inside that route (recsys is
// FAIL_CLOSED and refuses to rank on a stale trust snapshot, so a reader must
// still get a feed) — which is why no `trending` constant remains here. There is
// no trending TAB and there should not be one: trending content is meant to
// surface inside For You, ranked, not as a separate destination.

interface ForYouResponse {
  entries: Entry[];
  source: 'recsys' | 'trending-fallback' | 'chain-page';
  degraded?: string;
  detail?: string;
  ranked?: number;
  /** Where the next page starts. Null when Hive has nothing further. */
  nextCursor?: { author: string; permlink: string } | null;
}

/**
 * The ranked feed. One page: recsys `/feed` scores a candidate set and returns
 * an ORDER, and that order is the product — it has no cursor to paginate, and
 * inventing one client-side would just re-sort a slice by recency and quietly
 * undo the ranking.
 */
function ForYouFeed({ enabled }: { enabled: boolean }) {
  const { ref, inView } = useInView();

  // ★ INFINITE SCROLL (2026-08-07). This was a single `useQuery` for one page of
  // 30, on the reasoning that a ranked feed is one scored ORDER with no cursor —
  // true of recsys, but it left the reader at the end of the world after thirty
  // posts while every other Hive frontend scrolls indefinitely.
  //
  // Page 1 is still the ranking. Every page after it continues down the CHAIN
  // feed from the last post of the previous page, using the `nextCursor` the API
  // now returns. Hive caps a single request at 20, so the server pages
  // underneath as well — the cursor is the only thing the client has to know.
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<ForYouResponse>({
      queryKey: ['forYouRanked', enabled],
      queryFn: async ({ pageParam }) => {
        const cursor = pageParam as { author?: string; permlink?: string } | undefined;
        const params = new URLSearchParams({ limit: String(FOR_YOU_LIMIT) });
        if (cursor?.author && cursor?.permlink) {
          params.set('startAuthor', cursor.author);
          params.set('startPermlink', cursor.permlink);
        }
        const res = await fetch(`/api/feed/for-you?${params.toString()}`);
        if (!res.ok) throw new Error(`for-you ${res.status}`);
        return (await res.json()) as ForYouResponse;
      },
      getNextPageParam: (lastPage) => {
        // No cursor, or a page that came back empty, means Hive has nothing
        // further — stop asking rather than spinning forever at the bottom.
        if (!lastPage?.nextCursor) return undefined;
        if (!lastPage.entries || lastPage.entries.length === 0) return undefined;
        return lastPage.nextCursor;
      },
      staleTime: StaleTime.MEDIUM
    });

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isLoading) return <PostListSkeleton count={5} />;
  if (isError || !data) return <NoDataError />;

  const firstPage = data.pages[0];
  const ranked = firstPage?.source === 'recsys';
  // De-duplicate across pages: the ranked first page can legitimately contain a
  // post the chain pages reach again later, and a feed that repeats itself reads
  // as broken.
  const seen = new Set<string>();
  const entries = data.pages
    .flatMap((page) => page?.entries ?? [])
    .filter((e) => {
      const key = `${e.author}/${e.permlink}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // ★ BUG FOUND 2026-08-06 (owner report: "for you isnt populated... seems it
  // has mock posts"). Live-verified against the running dev server: an
  // anonymous request to /api/feed/for-you returns REAL trending posts
  // (`source: "trending-fallback"`, `degraded: "anonymous"`) — never mocks.
  // But this banner used to gate on the client's `enabled` (== `loggedIn`)
  // prop, which is FALSE for exactly the anonymous case, so the one message
  // that would have explained "you're seeing trending, not your feed" was the
  // one message that never rendered — an unlabelled trending list is
  // indistinguishable from junk. It also used the wrong copy ("warming up")
  // for every other degraded reason regardless of `enabled`. Both are fixed by
  // reading `data.degraded` — the server's own reason — instead of client
  // login state, which can also be stale relative to the session cookie.
  const degradedMessage = ranked
    ? null
    : firstPage?.degraded === 'anonymous'
      ? LABELS.degradedAnonymous
      : LABELS.degraded;

  return (
    <div>
      {/* The lite strip is the ONLY place lite posts appear when the ranker is
          not serving. Once it is, lite posts arrive ranked inline and showing
          them twice is duplication, so the strip stands down.

          ★ NEVER FOR A SIGNED-OUT VISITOR (2026-08-07). `ranked` is false for
          EVERY anonymous request by definition — there is no viewer to rank for —
          so this rendered on every logged-out visit. And the strip is not a feed:
          `/api/lite/posts` is globally unscoped, returning the ten most recent
          Lumen posts by ANYONE. On this box that is a wall of QA scratch posts,
          which is precisely what a first-time visitor saw instead of Hive.
          A logged-out visitor gets the real trending feed and nothing else. */}
      {!ranked && enabled ? <LiteFeedStrip /> : null}

      {degradedMessage ? (
        <p className="mb-4 rounded-[9px] bg-[#fdf6e7] px-3 py-2 font-sans text-[12.5px] text-[#9a7b2e]">
          {degradedMessage}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="py-12 text-center font-sans text-sm text-muted-foreground">{LABELS.empty}</p>
      ) : (
        entries.map((entry) => (
          <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
        ))
      )}

      {/* The sentinel: scrolling it into view fetches the next page. */}
      {entries.length > 0 && hasNextPage ? (
        <div ref={ref} className="py-8 text-center font-sans text-[13px] text-muted-foreground">
          {isFetchingNextPage ? 'Loading more…' : ''}
        </div>
      ) : null}
      {entries.length > 0 && !hasNextPage ? (
        <p className="py-8 text-center font-sans text-[13px] text-muted-foreground">
          That’s everything for now.
        </p>
      ) : null}
    </div>
  );
}

const FOR_YOU_LIMIT = 30;
// ★ SWITCHED 2026-08-06 (owner item 5b: reblogs must show in Following, with no
// separate reblog feed on the profile). This used to be
// `bridge.get_ranked_posts({ sort: 'created', tag: 'my' })` — Hive's "people I
// follow, newest first" list — but LIVE-VERIFIED against api.hive.blog that
// endpoint never populates `reblogged_by`: 96 posts fetched across 5 pages of
// a real account's "my" feed, zero carried it, and posts independently
// confirmed reblogged by a followee didn't even appear in the list. Hivemind's
// reblog-aware feed lives in a DIFFERENT endpoint: `bridge.get_account_posts`
// with `sort: 'feed'` (the classic "Feed" tab), backed by account_feed_cache —
// verified live: a followee's reblog of another author's post arrives with
// `reblogged_by: [<the reblogging followee>]` set. `account` and `observer`
// are both the viewer here: it's their own follow-feed, viewed by themselves.
const FEED_SORT = 'feed';

/**
 * Same `useInfiniteQuery` shape as `SortedPagesPosts`
 * (apps/blog/features/tags-pages/list-of-posts.tsx), rendering
 * `MediumPostCard`s instead of the classic `PostList` item. Uses
 * `getAccountPosts` (bridge.get_account_posts), not `getPostsRanked` — see the
 * FEED_SORT note above for why.
 */
/**
 * ★★★ A LITE ACCOUNT HAS NO FOLLOW FEED ON HIVE, BECAUSE IT HAS NO ACCOUNT ON HIVE.
 *
 * `bridge.get_account_posts({ sort: 'feed', account: <viewer> })` is Hive's own
 * follow feed, keyed on a real chain account. Asking it for a lite handle got
 * `assert_exception — "Account <name> does not exist"` back, six retries deep,
 * and then rendered "There was a problem fetching the data… check if permlink
 * is correct or the node is running properly" — on a feed, about no permlink,
 * with a healthy node. Unconditionally broken for the product's whole target
 * audience, on the tab right next to For You.
 *
 * Their follows live in Lumen's own store and point at both Lumen and Hive
 * authors, so a lite viewer reads `/api/lite/feed/following`, which merges the
 * two. A Hive-keyed viewer keeps the chain feed, which is correct for them.
 */
async function fetchLiteFollowing(limit: number): Promise<Entry[]> {
  const res = await fetch(`/api/lite/feed/following?limit=${limit}`);
  if (!res.ok) throw new Error(`following feed ${res.status}`);
  const body = (await res.json()) as { entries?: Entry[] };
  return body.entries ?? [];
}

const LITE_FOLLOWING_LIMIT = 30;

function EntryFeed({ sort, observer, lite = false }: { sort: string; observer: string; lite?: boolean }) {
  const { ref, inView } = useInView();
  const { data, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, isError, isLoading } = useInfiniteQuery({
    queryKey: ['discoveryFeedEntries', sort, observer, lite],
    queryFn: async ({ pageParam }) => {
      if (lite) return await fetchLiteFollowing(LITE_FOLLOWING_LIMIT);
      const { author, permlink } = (pageParam as { author?: string; permlink?: string }) || {};
      const postsData = await getAccountPosts(sort, observer, observer, author ?? '', permlink ?? '');
      return postsData ?? [];
    },
    getNextPageParam: (lastPage: Entry[]) => {
      // The lite route returns one merged page today; paging it would have to
      // page two stores at once, and offering a "load more" that silently
      // repeats the same page is worse than not offering one.
      if (lite) return undefined;
      if (!Array.isArray(lastPage) || lastPage.length === 0) return undefined;
      const last = lastPage[lastPage.length - 1] as { author?: string; permlink?: string };
      if (!last?.author || !last?.permlink) return undefined;
      return { author: last.author, permlink: last.permlink };
    },
    staleTime: StaleTime.MEDIUM
  });

  useEffect(() => {
    if (inView && hasNextPage && !isFetching) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetching, fetchNextPage]);

  if (isError) {
    return <NoDataError />;
  }

  if (isLoading || (isFetching && !data?.pages?.[0]?.length)) {
    return <PostListSkeleton count={5} />;
  }

  const entries = data?.pages.flat() ?? [];

  if (entries.length === 0) {
    return <p className="py-12 text-center font-sans text-sm text-muted-foreground">{LABELS.empty}</p>;
  }

  return (
    <div>
      {entries.map((entry) => (
        <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
      ))}
      <div className="flex justify-center py-6">
        <button
          ref={ref}
          type="button"
          onClick={() => fetchNextPage()}
          disabled={!hasNextPage || isFetchingNextPage}
          className="font-sans text-sm text-muted-foreground hover:text-foreground disabled:cursor-default"
        >
          {isFetchingNextPage ? LABELS.loadingMore : hasNextPage ? LABELS.loadMore : LABELS.nothingMore}
        </button>
      </div>
    </div>
  );
}

function TabButton({
  isActive,
  onClick,
  children
}: {
  isActive: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        'whitespace-nowrap rounded-[9px] px-5 py-2.5 font-sans text-[14.5px] font-semibold transition-colors',
        isActive
          ? 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08),0_1px_3px_rgba(20,18,10,0.05)]'
          : 'bg-transparent text-[#6b7280] hover:text-[#161511]'
      )}
    >
      {children}
    </button>
  );
}

export default function FeedTabs() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<TabKey>(() => toTabKey(searchParams?.get(TAB_PARAM) ?? null));
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  // NOTE: the SSR observer resolution that used to live here went with the
  // trending For You feed. The ranked route resolves the viewer from the SESSION
  // server-side (a client-supplied viewer would let anyone request anyone else's
  // personalised feed), and the Following tab passes `user.username` directly.

  // Keep the tab in sync with ?tab= so the right-rail widget's "View market"
  // link and browser back/forward switch tabs without remounting.
  useEffect(() => {
    setActiveTab(toTabKey(searchParams?.get(TAB_PARAM) ?? null));
  }, [searchParams]);

  const selectTab = (tab: TabKey) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (tab === 'for-you') {
      params.delete(TAB_PARAM); // default tab keeps the URL clean
    } else {
      params.set(TAB_PARAM, tab);
    }
    const query = params.toString();
    const path = pathname ?? '/';
    router.replace(query ? `${path}?${query}` : path, { scroll: false });
  };

  return (
    <div>
      {/* Post-login onboarding: renders only for a lite account that has never
          been asked. Self-gating, so mounting it here costs a logged-out or
          full-Hive visitor nothing. */}
      <InterestPicker />
      <div
        role="tablist"
        /* ★ At 390px the three labels are wider than the viewport, and every
           ancestor had `overflow-x: visible`, so "Prediction Market" was simply
           cut off at the screen edge with nothing to scroll — worse once
           selected, because the active state is wider still. Measured by a
           small-screen tester: tab bar right edge at 416px against a 390px
           viewport. `max-w-full` + `overflow-x-auto` lets the row scroll
           itself; `w-fit` keeps it hugging its content at every larger size,
           where it already fit (820px: 674px against 820). */
        className="mb-5 inline-flex w-fit max-w-full gap-1.5 overflow-x-auto rounded-[14px] border border-[#ebedf0] bg-[#f4f5f7] p-[5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabButton isActive={activeTab === 'for-you'} onClick={() => selectTab('for-you')}>
          {LABELS.forYou}
        </TabButton>
        <TabButton isActive={activeTab === 'feed'} onClick={() => selectTab('feed')}>
          {LABELS.feed}
        </TabButton>
        <TabButton isActive={activeTab === 'predictions'} onClick={() => selectTab('predictions')}>
          {LABELS.predictions}
        </TabButton>
      </div>

      {activeTab === 'predictions' ? (
        <MarketTab />
      ) : activeTab === 'feed' ? (
        loggedIn ? (
          <EntryFeed sort={FEED_SORT} observer={user.username} lite={user.account_tier === 'lite'} />
        ) : (
          <div className="flex items-center justify-center py-16 font-sans text-sm text-muted-foreground">
            {LABELS.loginPrompt}
          </div>
        )
      ) : (
        <ForYouFeed enabled={loggedIn} />
      )}
    </div>
  );
}
