'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { getPostsRanked } from '@transaction/lib/bridge-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { DEFAULT_OBSERVER, SortTypes } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { PostListSkeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import NoDataError from '@/blog/components/no-data-error';
import { useSSRObserver } from '@/blog/components/observer-provider';
import MarketTab from '@/blog/features/prediction-market/market-tab';
import MediumPostCard from './medium-post-card';

// TODO: move to i18n
const LABELS = {
  forYou: 'For You',
  feed: 'Following',
  predictions: 'Prediction Market',
  loadingMore: 'Loading…',
  loadMore: 'Load more',
  nothingMore: "You're all caught up",
  empty: 'No posts yet.',
  loginPrompt: 'Log in to see your Feed'
};

type TabKey = 'for-you' | 'feed' | 'predictions';
const TAB_KEYS: readonly TabKey[] = ['for-you', 'feed', 'predictions'];
const TAB_PARAM = 'tab';

function toTabKey(raw: string | null): TabKey {
  return raw !== null && (TAB_KEYS as readonly string[]).includes(raw) ? (raw as TabKey) : 'for-you';
}

// PLACEHOLDER: "For You" stands in for real discovery ranking until that
// backend exists.
// TODO: replace with the real discovery-ranking backend
const FOR_YOU_SORT: SortTypes = 'trending';
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
  const ssrObserver = useSSRObserver();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  // Match SortedPagesPosts's hydration-safe observer resolution: use the
  // SSR-resolved observer until the client auth state is known, then switch.
  const observer = isHydrated ? (user.isLoggedIn ? user.username : DEFAULT_OBSERVER) : ssrObserver;

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
        <EntryFeed sort={FOR_YOU_SORT} tag="" observer={observer} />
      )}
    </div>
  );
}
