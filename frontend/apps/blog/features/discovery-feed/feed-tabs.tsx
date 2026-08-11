'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { StaleTime } from '@/blog/lib/react-query';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { PostListSkeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import NoDataError from '@/blog/components/no-data-error';
import { getMarketDataSource } from '@/blog/features/prediction-market/lib/market-data-source';
import MarketTab from '@/blog/features/prediction-market/market-tab';
import MediumPostCard from './medium-post-card';
// ONE batched request per list, never one per card — see use-rank-marks.ts.
import { useRankMarks } from '@/blog/features/retention/hooks/use-rank-marks';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import InterestPicker from '@/blog/features/lite-auth/interests/interest-picker';
import DialogLogin from '@/blog/components/dialog-login';

// TODO: move to i18n
const LABELS = {
  forYou: 'For You',
  feed: 'Following',
  predictions: 'Prediction Market',
  loadingMore: 'Loading…',
  loadMore: 'Load more',
  nothingMore: "You're all caught up",
  empty: 'No posts yet.',
  degraded: 'Personalised ranking is warming up. Showing popular posts meanwhile.',
  degradedAnonymous: 'Showing trending. Log in for your own feed.',
  loginPrompt: 'Following shows the people you follow.',
  loginCta: 'Log in',
  newPost: 'Show 1 new post',
  newPosts: (count: number) => `Show ${count} new posts`
};

type TabKey = 'for-you' | 'feed' | 'predictions';
const TAB_KEYS: readonly TabKey[] = ['for-you', 'feed', 'predictions'];
const TAB_PARAM = 'tab';

function toTabKey(raw: string | null, marketAvailable: boolean): TabKey {
  if (raw === null || !(TAB_KEYS as readonly string[]).includes(raw)) return 'for-you';
  // ★ item 3 (adversarial review): `?tab=predictions` used to resolve to
  // 'predictions' even when the market is unconfigured, so the button for it
  // is hidden (see `marketAvailable` below) AND the panel falls through to
  // ForYouFeed — but `activeTab` itself stayed 'predictions', which no
  // rendered TabButton matches, so neither tab showed as active while the
  // for-you feed rendered. Falling back to the default tab here keeps the
  // active-tab indicator in sync with whatever actually renders.
  if (raw === 'predictions' && !marketAvailable) return 'for-you';
  return raw as TabKey;
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
const FOR_YOU_KEY = ['forYouRanked'];
const FOR_YOU_INCOMING_KEY = ['forYouIncoming'];
/** How often the silent poll below looks for posts the reader has not been shown. */
const FEED_POLL_MS = 3 * 60_000;

function entryKey(entry: Entry): string {
  return `${entry.author}/${entry.permlink}`;
}

async function fetchForYou(cursor?: { author?: string; permlink?: string }): Promise<ForYouResponse> {
  const params = new URLSearchParams({ limit: String(FOR_YOU_LIMIT) });
  if (cursor?.author && cursor?.permlink) {
    params.set('startAuthor', cursor.author);
    params.set('startPermlink', cursor.permlink);
  }
  const res = await fetch(`/api/feed/for-you?${params.toString()}`);
  if (!res.ok) throw new Error(`for-you ${res.status}`);
  return (await res.json()) as ForYouResponse;
}

function ForYouFeed() {
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
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<ForYouResponse>({
      // ★ NOT keyed on `enabled` (2026-08-08). `enabled` is `loggedIn`, which is
      // false before hydration and true after — so the key changed mid-load and
      // react-query threw away the page it had just fetched and ran the whole
      // recsys ranking pipeline a SECOND time, on every signed-in pageview.
      // Measured: two identical `?limit=30` requests ~800ms apart, byte-identical
      // responses. Signed-out never showed it, because `loggedIn` is false at both
      // moments — which is what gave the mechanism away.
      //
      // The server identifies the viewer from the session cookie, so the response
      // is already per-user; the key does not need to encode login state.
      queryKey: FOR_YOU_KEY,
      queryFn: async ({ pageParam }) => fetchForYou(pageParam as { author?: string; permlink?: string }),
      getNextPageParam: (lastPage) => {
        // No cursor, or a page that came back empty, means Hive has nothing
        // further — stop asking rather than spinning forever at the bottom.
        if (!lastPage?.nextCursor) return undefined;
        if (!lastPage.entries || lastPage.entries.length === 0) return undefined;
        return lastPage.nextCursor;
      },
      // ★★★ THE FEED NEVER CHANGES UNDER A READER (2026-08-10) — MEASURED FIRST.
      //
      // This carried `staleTime: StaleTime.MEDIUM` (2 minutes) and nothing else,
      // which meant every react-query refetch trigger — window focus, reconnect,
      // a remount on navigating back home — was free to fire the moment the data
      // aged past two minutes, and each one REPLACED the rendered list wholesale.
      // Observed on this route in one sitting: 30 posts, then 30 DIFFERENT posts
      // ~195s later, then a 173-byte empty page that wiped the feed entirely.
      // Card keys are `author-permlink`, so a swap is not a re-render, it is a
      // full unmount and remount: the reader's scroll position, their expanded
      // NSFW reveals and the post they were halfway through all go at once.
      //
      // A ranked feed has no business refreshing itself. It is an ORDER computed
      // for this reader, not a ticker, and there is nothing time-critical about
      // position 14 changing. So every automatic trigger is off, and new posts
      // arrive through the silent poll below as an offer the reader accepts.
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      // The route is expensive; one retry, not react-query's default three.
      retry: 1
    });

  /**
   * ★ POSTS THE READER HAS NOT BEEN SHOWN, COUNTED — NEVER SWAPPED IN.
   *
   * A separate query on its own key, so nothing it returns can reach the rendered
   * list on its own. It only ever answers "how many new ones are there", which
   * becomes the button above the feed. `refetchIntervalInBackground` stays at its
   * default of false, so a tab left open in another window is not polling.
   */
  const { data: incoming } = useQuery<ForYouResponse>({
    queryKey: FOR_YOU_INCOMING_KEY,
    queryFn: () => fetchForYou(),
    refetchInterval: FEED_POLL_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: FEED_POLL_MS,
    retry: 0,
    // Nothing to compare against until the reader has a first page.
    enabled: (data?.pages?.length ?? 0) > 0
  });

  /** New posts the reader accepted, kept above the pages they were already reading. */
  const [accepted, setAccepted] = useState<Entry[]>([]);

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Hook must run unconditionally, above every early return (see lib/nsfw.ts).
  const nsfwPreference = useNsfwPreference();

  // ★ EVERY DERIVED LIST IS BUILT ABOVE THE GUARDS, because the two hooks below read
  // it and a hook may never run conditionally. `data` is undefined while the first
  // page loads, which the `?? []` here covers.
  const pages = data?.pages ?? [];
  const firstPage = pages[0];
  const ranked = firstPage?.source === 'recsys';
  // De-duplicate across pages: the ranked first page can legitimately contain a
  // post the chain pages reach again later, and a feed that repeats itself reads
  // as broken. Accepted posts go first — the reader asked for them, so they belong
  // at the top, and the dedupe keeps a later page from repeating one.
  const seen = new Set<string>();
  const rawEntries = [...accepted, ...pages.flatMap((page) => page?.entries ?? [])].filter((e) => {
    const key = entryKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // NSFW `hide` filtering happens at the LIST so entries.length means "posts you
  // will actually see" — otherwise a fully-hidden page leaves a zero-height list
  // and the scroll sentinel auto-fetches forever. See lib/nsfw.ts.
  const entries = filterVisiblePosts(rawEntries, nsfwPreference);

  // ★★★ AN EMPTY ANSWER NEVER PAINTS OVER A FULL PAGE (2026-08-10).
  //
  // The route can return `{entries: []}` with a 200 — it did, measured, 109 bytes
  // after two healthy 30-post responses — and anything that invalidates this query
  // (blocking someone, for instance) re-runs it. Whatever the reason, replacing a
  // page the reader is reading with "No posts yet." is never the right answer:
  // nothing about a feed becomes true because one request came back thin. Holding
  // the last list we actually rendered means the worst case is stale, not blank.
  //
  // Written during render on purpose. This is the standard previous-value ref and
  // it is idempotent: it only ever stores what this very render is about to show.
  const lastRendered = useRef<Entry[]>([]);
  if (entries.length > 0) lastRendered.current = entries;
  const shown = entries.length > 0 ? entries : lastRendered.current;

  // ★ ABOVE THE GUARDS. `useRankMarks` is a hook and must run in the same order on
  // every render, so it reads the list computed above rather than being derived
  // after an early return.
  const marks = useRankMarks(shown.map((e) => e.author));

  // Posts the silent poll found that are not on the reader's page yet. Filtered the
  // same way the list is, so the button can never offer posts that would render as
  // nothing.
  const shownKeys = new Set(shown.map(entryKey));
  const offered = filterVisiblePosts(
    (incoming?.entries ?? []).filter((e) => !shownKeys.has(entryKey(e))),
    nsfwPreference
  );

  const acceptNew = () => {
    // Capped so a tab left open all day cannot grow this without bound.
    setAccepted((prev) => [...offered, ...prev].slice(0, FOR_YOU_LIMIT * 4));
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (isLoading) return <PostListSkeleton count={5} />;
  // ★ `isError` IS NO LONGER PART OF THIS GUARD. It is true for a failed REFETCH as
  // well as a failed first load, so an error on the poll-driven path used to throw
  // away a perfectly good page. Only "we have nothing at all to show" is an error
  // state; with data in hand, a failure is something to ride out silently.
  if (!data && shown.length === 0) return <NoDataError />;

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
      {/* ★ THE LITE STRIP IS GONE FROM HERE FOR GOOD, NOT JUST FOR SIGNED-OUT
          VISITORS (2026-08-08, owner report: "For You shows test posts").
          It used to render for a SIGNED-IN reader too, whenever the ranker
          degraded (`!ranked`) — which recsys's own FAIL_CLOSED design means
          WILL happen (cold start, stale trust snapshot). `/api/lite/posts`
          behind it takes no session and no scoping at all: it is every
          `feed_visibility='visible'` row in `lumen_post`, newest first,
          author unfiltered. Called live against this box it returned QA
          scratch content verbatim — "QA reproduction comment — logout hammer
          test", "QA ranked-state check 1786143290815.", "Quick toast
          verification post." — which is exactly the "mock posts" the owner
          saw, served to a genuinely signed-in reader as a stand-in for their
          personalised feed. The honest fallback for a degraded rank is the
          real chain feed already below (trending/chain-page, live-verified as
          genuine Hive content) plus the `degradedMessage` banner — never an
          unscoped dump of anyone's unmoderated drafts. Fixing the leak at its
          source (`/api/lite/posts` has no filter for this) is a different
          file than the two this fix owns; standing the strip down here closes
          the reachable path without touching ranking behaviour. */}

      {/* ★ NEVER ABOVE AN EMPTY LIST (2026-08-10). This banner rendered on
          `!ranked` alone, so "Personalised ranking is warming up. Showing popular
          posts meanwhile." sat directly on top of "No posts yet." — one line
          promising posts and the next saying there are none. When there is
          nothing to show, the empty state is the only honest message on screen. */}
      {degradedMessage && shown.length > 0 ? (
        <p className="mb-4 rounded-[9px] bg-[#fdf6e7] px-3 py-2 font-sans text-[12.5px] text-[#9a7b2e]">
          {degradedMessage}
        </p>
      ) : null}

      {/* The offer, never the swap: the poll found these, the reader decides. */}
      {offered.length > 0 ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={acceptNew}
            data-testid="for-you-new-posts"
            className="rounded-full bg-[#c0392b] px-4 py-2 font-sans text-[13.5px] font-semibold text-white shadow-[0_1px_3px_rgba(20,18,10,0.12)] transition-colors hover:bg-[#a5301f]"
          >
            {offered.length === 1 ? LABELS.newPost : LABELS.newPosts(offered.length)}
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="py-12 text-center font-sans text-sm text-muted-foreground">{LABELS.empty}</p>
      ) : (
        shown.map((entry) => (
          <MediumPostCard
            key={`${entry.author}-${entry.permlink}`}
            post={entry}
            mark={marks.get(entry.author?.toLowerCase() ?? '')}
          />
        ))
      )}

      {/* The sentinel: scrolling it into view fetches the next page. */}
      {shown.length > 0 && hasNextPage ? (
        <div ref={ref} className="py-8 text-center font-sans text-[13px] text-muted-foreground">
          {isFetchingNextPage ? 'Loading more…' : ''}
        </div>
      ) : null}
      {shown.length > 0 && !hasNextPage ? (
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
  const { data, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, isError, isLoading } =
    useInfiniteQuery({
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

  // Hook must run unconditionally, above every early return (see lib/nsfw.ts).
  const nsfwPreference = useNsfwPreference();

  // ★ EFFECT (A) ON THE FOLLOWING TAB. The Hive branch of this query goes straight
  // from the browser to a chain node, so the reader's own block list can only be
  // applied here — no Lumen server sees that response. (The lite branch reads
  // `/api/lite/feed/following`, a Lumen route; one query key serves both, so the
  // filter lives at the shared end.) Reader-side only: the owner-side half of
  // blocking is never enforced in a browser, for the reason spelled out in
  // `lib/lite/client/use-lumen-block.ts`.
  const blockList = useLumenBlockList(true);

  // ★ ABOVE THE EARLY RETURNS. `useRankMarks` is a hook, so it must run on every render
  // in the same order — calling it after `if (isError) return` breaks that the moment the
  // query flips state. Derived from the raw pages rather than the NSFW-filtered list
  // below: hiding a post is a display decision and must not change hook behaviour.
  const marks = useRankMarks((data?.pages.flat() ?? []).map((e) => e.author));

  if (isError) {
    return <NoDataError />;
  }

  if (isLoading || (isFetching && !data?.pages?.[0]?.length)) {
    return <PostListSkeleton count={5} />;
  }

  // Same NSFW list-level filter as the ranked feed above (see lib/nsfw.ts).
  const entries = filterVisiblePosts(
    (data?.pages.flat() ?? []).filter((entry) => !isBlockedEntry(entry, blockList)),
    nsfwPreference
  );

  if (entries.length === 0) {
    return <p className="py-12 text-center font-sans text-sm text-muted-foreground">{LABELS.empty}</p>;
  }

  return (
    <div>
      {entries.map((entry) => (
        <MediumPostCard
          key={`${entry.author}-${entry.permlink}`}
          post={entry}
          mark={marks.get(entry.author?.toLowerCase() ?? '')}
        />
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
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  // NOTE: the SSR observer resolution that used to live here went with the
  // trending For You feed. The ranked route resolves the viewer from the SESSION
  // server-side (a client-supplied viewer would let anyone request anyone else's
  // personalised feed), and the Following tab passes `user.username` directly.

  // ★ THE PREDICTIONS TAB IS GONE UNTIL THE MARKET SHIPS (owner ruling,
  // 2026-08-11, item F8/P3). No REACT_APP_VSC_MARKET_* contract is provisioned
  // on this build, so this tab existed only to open a screen whose whole
  // content is "not available yet" — a permanent top-level tab announcing a
  // feature that does not exist. Gated on the SAME provisioning check
  // `useMarket()`/`MarketTab` already use (`getMarketDataSource() !== null`,
  // see lib/market-config.ts), not a new flag, so the tab reappears on its own
  // the day the contract is live. `MarketTab` itself is untouched — nothing was
  // deleted, only its entry point is conditional. A stale `?tab=predictions`
  // URL (bookmarked, or from before this change) resolves — active-tab state
  // included, via `toTabKey` — to the default tab rather than opening a dead
  // screen with no tab looking active.
  //
  // Computed above the `activeTab` state so both the initializer and the
  // sync effect below can fold it into `toTabKey` instead of resolving a tab
  // key that `marketAvailable` immediately has to override again at render.
  const marketAvailable = getMarketDataSource() !== null;

  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    toTabKey(searchParams?.get(TAB_PARAM) ?? null, marketAvailable)
  );

  // Keep the tab in sync with ?tab= so the right-rail widget's "View market"
  // link and browser back/forward switch tabs without remounting.
  useEffect(() => {
    setActiveTab(toTabKey(searchParams?.get(TAB_PARAM) ?? null, marketAvailable));
  }, [searchParams, marketAvailable]);

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
      {/* Cold-start onboarding, self-gating. It asks the server whether this
          reader is eligible (a lite account, or a Hive account inside its first
          week), unasked, and has written nothing yet, so mounting it here costs a
          logged-out visitor nothing and an established account nothing. There is no
          manual door any more: see the ruling further down this file. */}
      <InterestPicker />
      <div
        role="tablist"
        /* ★ WRAP, DON'T HIDE (2026-08-08). At 390px the three labels are wider
           than the viewport. A previous pass contained that with
           `overflow-x-auto` plus `[scrollbar-width:none]` and a hidden WebKit
           scrollbar — which meant "Prediction Market" rendered as "Prediction
           Mar…" with NOTHING on screen indicating there was more to reach: the
           one affordance that would have said "this scrolls" had been styled
           away, and the tab was the third of three, so nobody arriving on the
           default tab had any reason to swipe.

           Three tabs are few enough to simply fit on two lines, so they do.
           `w-fit` + `max-w-full` still hug the content at every larger width,
           where all three sit on one row exactly as before (820px: 674px of
           tabs in 820px of viewport — no wrap, no visual change). */
        className="mb-5 inline-flex w-fit max-w-full flex-wrap gap-1.5 rounded-[14px] border border-[#ebedf0] bg-[#f4f5f7] p-[5px]"
      >
        <TabButton isActive={activeTab === 'for-you'} onClick={() => selectTab('for-you')}>
          {LABELS.forYou}
        </TabButton>
        <TabButton isActive={activeTab === 'feed'} onClick={() => selectTab('feed')}>
          {LABELS.feed}
        </TabButton>
        {marketAvailable ? (
          <TabButton isActive={activeTab === 'predictions'} onClick={() => selectTab('predictions')}>
            {LABELS.predictions}
          </TabButton>
        ) : null}
      </div>

      {/* ★ THE SECOND DOOR TO THE INTEREST PICKER (2026-08-08).
          The picker itself introduces itself exactly once, to a reader who has
          written nothing. That is right for onboarding and useless for everyone
          else: without this, anyone who already posts here — every Hive account
          with a history, and every lite reader past their first evening — had NO
          WAY to tell Lumen what they are into, and no way to change their mind
          later. Sits beside the tabs rather than in settings because it belongs
          next to the thing it changes. */}
      {/* ★★★ "Tune your feed" IS GONE (owner ruling 2026-08-10).
          The reasoning above is sound onboarding theory and wrong for this product.
          The interests picker is a COLD-START SEED, offered once to an account that
          has no history for the ranker to read: a lite account on its first visit,
          or a Hive account inside its first week. It is not a settings panel and it
          is not a feed control, and leaving it one click from every For You tab made
          it exactly that.
          What it cost: the owner clicked it on his own fourteen-year account, picked
          five interests, and the feed re-tuned around them, resurfacing container
          posts. A permanently reachable re-tune button also competes with the thing
          that should own this job, which is the feed learning from what the reader
          actually does over time.
          The picker keeps its `openSignal` prop, so a deliberate "edit interests"
          entry point in settings can be wired later. Nothing renders one today. */}

      {activeTab === 'predictions' && marketAvailable ? (
        <MarketTab />
      ) : activeTab === 'feed' ? (
        loggedIn ? (
          <EntryFeed sort={FEED_SORT} observer={user.username} lite={user.account_tier === 'lite'} />
        ) : (
          /* v8: this was a dead end. One grey sentence, a stray capital F mid-line,
             and nothing to click, on the one tab a signed-out reader is most likely
             to try. It now says what the tab is for and offers the door. */
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="font-sans text-sm text-[#6b7280]">{LABELS.loginPrompt}</p>
            <DialogLogin>
              <button
                type="button"
                className="rounded-[13px] bg-[#c0392b] px-5 py-2.5 font-sans text-[14px] font-semibold text-white hover:bg-[#a5301f]"
              >
                {LABELS.loginCta}
              </button>
            </DialogLogin>
          </div>
        )
      ) : (
        <ForYouFeed />
      )}
    </div>
  );
}
