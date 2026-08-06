'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getPostsRanked } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { SortTypes } from '@/blog/lib/utils';
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
  source: 'recsys' | 'trending-fallback';
  degraded?: string;
  detail?: string;
  ranked?: number;
}

/**
 * The ranked feed. One page: recsys `/feed` scores a candidate set and returns
 * an ORDER, and that order is the product — it has no cursor to paginate, and
 * inventing one client-side would just re-sort a slice by recency and quietly
 * undo the ranking.
 */
function ForYouFeed({ enabled }: { enabled: boolean }) {
  const { data, isLoading, isError } = useQuery<ForYouResponse>({
    queryKey: ['forYouRanked', enabled],
    queryFn: async () => {
      const res = await fetch(`/api/feed/for-you?limit=${FOR_YOU_LIMIT}`);
      if (!res.ok) throw new Error(`for-you ${res.status}`);
      return (await res.json()) as ForYouResponse;
    },
    staleTime: StaleTime.MEDIUM
  });

  if (isLoading) return <PostListSkeleton count={5} />;
  if (isError || !data) return <NoDataError />;

  const ranked = data.source === 'recsys';
  const entries = data.entries ?? [];

  return (
    <div>
      {/* The lite strip is the ONLY place lite posts appear when the ranker is
          not serving. Once it is, lite posts arrive ranked inline and showing
          them twice is duplication, so the strip stands down. */}
      {!ranked ? <LiteFeedStrip /> : null}

      {!ranked && enabled ? (
        <p className="mb-4 rounded-[9px] bg-[#fdf6e7] px-3 py-2 font-sans text-[12.5px] text-[#9a7b2e]">
          {LABELS.degraded}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="py-12 text-center font-sans text-sm text-muted-foreground">{LABELS.empty}</p>
      ) : (
        entries.map((entry) => (
          <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
        ))
      )}
    </div>
  );
}

const FOR_YOU_LIMIT = 30;
// "created" + tag "my" is Hive's genuine "people I follow" feed, resolved
// server-side by bridge.get_ranked_posts against the observer's on-chain
// follow list, newest first (see /created/my for the existing usage).
const FEED_SORT: SortTypes = 'created';
const FEED_TAG = 'my';

/**
 * Same `useInfiniteQuery` + `getPostsRanked` shape as `SortedPagesPosts`
 * (apps/blog/features/tags-pages/list-of-posts.tsx), rendering
 * `MediumPostCard`s instead of the classic `PostList` item.
 */
function EntryFeed({ sort, tag, observer }: { sort: SortTypes; tag: string; observer: string }) {
  const { ref, inView } = useInView();
  const { data, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, isError, isLoading } = useInfiniteQuery({
    queryKey: ['discoveryFeedEntries', sort, tag, observer],
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
        className="mb-5 inline-flex w-fit gap-1.5 rounded-[14px] border border-[#ebedf0] bg-[#f4f5f7] p-[5px]"
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
          <EntryFeed sort={FEED_SORT} tag={FEED_TAG} observer={user.username} />
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
