'use client';

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import { Link, PostListSkeleton } from '@hive/ui';
import { getByText } from '@transaction/lib/hive-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import SearchSortSelect from './sort-select';
import { SearchSort } from '@ui/hooks/use-search';
import { useTranslation } from '@/blog/i18n/client';
import { useSSRObserver } from '@/blog/components/observer-provider';
import { chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import MediumPostCard from '@/blog/features/discovery-feed/medium-post-card';
// ONE batched request per list, never one per card — see use-rank-marks.ts.
import { useRankMarks } from '@/blog/features/retention/hooks/use-rank-marks';
import NoDataError from '@/blog/components/no-data-error';
import { PER_PAGE } from './lib/utils';

// Fallbacks for the same reason every label on this page carries one: SSR
// resolves no translations in this app (see search-input.tsx), and the result
// count is on screen from the first frame.
const COUNT_FALLBACK: Record<string, string> = {
  'search_page.result_count_one': '{{count}} result for “{{query}}”',
  'search_page.result_count_other': '{{count}} results for “{{query}}”',
  'search_page.result_count_partial_one': 'Showing {{count}} result for “{{query}}”',
  'search_page.result_count_partial_other': 'Showing {{count}} results for “{{query}}”'
};

/**
 * ★★★ SEARCH RESULTS ARE THE FEED CARD NOW (owner item R-2, 2026-08-10).
 *
 * This replaces `account-topic-result.tsx` + `ai-result.tsx`, which rendered
 * `PostList` -> `PostListItem` — a THIRD post card design that shared nothing
 * with the feed a reader had just come from: thumbnail on the LEFT (the feed
 * puts it right), a sans-serif `h3` title at 16px (the feed's is 26px), the
 * payout on the LEFT in black (the feed puts it right in green), a horizontal
 * rule above the metrics row that exists nowhere else in Lumen, and its own
 * icon set. Same post, two products, depending on how you found it.
 *
 * Rendering `MediumPostCard` — the feed's own component, with the feed's own
 * rank marks and the feed's own NSFW list filter — is what makes the byline
 * defects go away rather than being restyled:
 *
 *   * R-3, `bradleyarrow(77)`: the classic card printed the raw reputation in
 *     brackets, jammed against the name with no space and no label. The feed
 *     card has no such element; reputation reaches the byline only as a named
 *     league mark, from the same snapshot the profile uses.
 *   * R-4, "in #alive" next to "in LeoFinance" in ONE list: the classic card
 *     fell back to `#{category}` when a post had no community, so the same slot
 *     carried two different formats. The feed card shows a community when there
 *     is one and nothing when there is not, so the list is consistent with
 *     itself and with every other list in the product.
 */
const SearchResults = ({ query, sort }: { query: string; sort: SearchSort }) => {
  const { t } = useTranslation('common_blog');
  const ssrObserver = useSSRObserver();
  const { user, isHydrated } = useUserClient();
  const { ref, inView } = useInView();

  // Use the SSR observer (from cookie) before hydration so a logged-in reader's
  // first request is not sent as the default observer.
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isError } = useInfiniteQuery({
    queryKey: ['searchByText', query, sort, observer],
    queryFn: async ({ pageParam }: { pageParam?: { author: string; permlink: string } }) => {
      return await getByText({
        pattern: query,
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
    staleTime: StaleTime.MEDIUM
  });

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Both hooks must run on every render, above every early return below — a hook
  // after a conditional return corrupts hook order for the next render of this
  // list. See lib/nsfw.ts for the React #310 this exact pattern caused before.
  const nsfwPreference = useNsfwPreference();
  const rawEntries = (data?.pages ?? []).flatMap((page) => page ?? []);
  const marks = useRankMarks(rawEntries.map((entry) => entry.author));

  // Filter at the LIST, so the count below means "matches you will actually
  // see" and the scroll sentinel is not sitting in a zero-height list.
  const entries = filterVisiblePosts(rawEntries, nsfwPreference);
  const total = entries.length;

  // ★ THE COUNT (owner item R-7). The results list had no count, no
  // highlighting and no visible pagination, so "did this find anything, and how
  // much of it am I looking at" had no answer on screen. `hasNextPage` decides
  // between "Showing N" (more will load as you scroll) and a plain "N", because
  // an infinite list must not claim a total it has not seen.
  // Plural picked explicitly rather than via i18next's `count` suffix
  // resolution, so a locale that has not been given the plural forms still
  // renders a real string instead of the raw key.
  const countKey = hasNextPage
    ? total === 1
      ? 'search_page.result_count_partial_one'
      : 'search_page.result_count_partial_other'
    : total === 1
      ? 'search_page.result_count_one'
      : 'search_page.result_count_other';

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="font-sans text-[14px] text-[#6b7280]" data-testid="search-result-count">
        {isLoading
          ? t('search_page.searching_for', { query, defaultValue: 'Searching for “{{query}}”' })
          : t(countKey, { count: total, query, defaultValue: COUNT_FALLBACK[countKey] })}
      </p>
      <SearchSortSelect query={query} />
    </div>
  );

  /**
   * ★ A SEARCH THAT FAILED IS NOT A BROKEN NODE.
   *
   * The generic <NoDataError /> told the reader to "check if permlink is
   * correct or the node is running properly" — on a SEARCH page, where there is
   * no permlink and the node is fine. The real cause, measured against
   * api.hive.blog 2026-08-06: `sort=created` ("Newest") makes the search backend
   * scan far enough to hit its own statement timeout (PostgreSQL 57014) for any
   * common word. Say what happened, and offer the one thing that will work.
   *
   * Only surrender the surface when there is nothing to show — a failed
   * `fetchNextPage` must not erase results already on screen.
   */
  if (isError && total === 0) {
    if (sort === 'created') {
      return (
        <div className="flex flex-col gap-6">
          {header}
          <div className="mx-auto flex flex-col items-center gap-3 py-10 text-center">
            <p className="font-sans text-sm text-muted-foreground">{t('search_page.newest_too_broad')}</p>
            <Link
              href={`/search?q=${encodeURIComponent(query)}&s=relevance`}
              className="font-sans text-sm text-primary hover:underline"
            >
              {t('search_page.try_relevance')}
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-6">
        {header}
        <NoDataError />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* ★ SKELETONS, NOT A HELD EMPTY STATE (owner item R-5, 2026-08-10). The
          page used to keep "Type above to begin" on screen for the entire
          search — measured at 3.5s here and reported at ~20s on a broad term —
          so the one message on screen told the reader nothing had started yet.
          `PostListSkeleton` is what the home feed already shows while it
          loads. */}
      {isLoading ? (
        <PostListSkeleton count={5} />
      ) : total === 0 ? (
        <p className="py-10 text-center font-sans text-sm text-muted-foreground">
          {t('search_page.no_results_for', { query })}
        </p>
      ) : (
        <div data-testid="search-results-list">
          {entries.map((entry) => (
            <MediumPostCard
              key={`${entry.author}-${entry.permlink}`}
              post={entry}
              mark={marks.get(entry.author?.toLowerCase() ?? '')}
            />
          ))}
        </div>
      )}

      {/* The sentinel: scrolling it into view fetches the next page. */}
      {total > 0 && hasNextPage ? (
        <div ref={ref} className="py-6 text-center font-sans text-[13px] text-muted-foreground">
          {isFetchingNextPage ? t('search_page.loading_more', { defaultValue: 'Loading more…' }) : ''}
        </div>
      ) : null}
      {total > 0 && !hasNextPage ? (
        <p className="py-6 text-center font-sans text-[13px] text-muted-foreground">
          {t('search_page.end_of_results', { defaultValue: 'That’s every match.' })}
        </p>
      ) : null}
    </div>
  );
};

export default SearchResults;
