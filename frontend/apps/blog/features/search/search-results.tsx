'use client';

import { useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, LumenLoader } from '@hive/ui';
import { fetchSearch } from '@/blog/lib/chain-fetch';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import SearchSortSelect from './sort-select';
import { SearchSort } from '@ui/hooks/use-search';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';
import { useTranslation } from '@/blog/i18n/client';
import { useSSRObserver } from '@/blog/components/observer-provider';
import { chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import MediumPostCard from '@/blog/features/discovery-feed/medium-post-card';
import {
  FEED_AUTO_PAGE_CAP,
  useInfiniteScrollSentinel
} from '@/blog/features/discovery-feed/hooks/use-infinite-scroll-sentinel';
// ONE batched request per list, never one per card — see use-rank-marks.ts.
import { useRankLuminosity, useRankMarks } from '@/blog/features/retention/hooks/use-rank-marks';
import NoDataError from '@/blog/components/no-data-error';
import { PER_PAGE } from './lib/utils';
import { useTokenPriceChips } from '@/blog/features/creator-tokens/live/use-token-price-chips';
import { rerankSearchPage } from '@/blog/lib/search/rerank';

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

  // Use the SSR observer (from cookie) before hydration so a logged-in reader's
  // first request is not sent as the default observer.
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;

  // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
  // `getByText` directly on every search — `/search` is public, so this
  // downloaded `wax.common.wasm` for any visitor who searched. See
  // `apps/blog/app/api/search/route.ts`.
  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage, isError } = useInfiniteQuery({
    queryKey: ['searchByText', query, sort, observer],
    queryFn: async ({ pageParam }: { pageParam?: { author: string; permlink: string } }) => {
      return await fetchSearch({
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
        // ★ A FAILED READ MUST SURFACE FAST (2026-08-13). This query never overrode
    // React Query's default `retry: 3`, so a genuine failure sat behind three
    // attempts and ~7s of backoff — measured at 5.4s / 9.1s on real failures —
    // before the reader was told anything, behind an unlabelled spinner the whole
    // time. One retry absorbs a transient blip; three only postpone bad news.
    /**
     * ★★★ A DETERMINISTIC TIMEOUT MUST NOT BE RETRIED (measured 2026-08-18).
     *
     * `retry: 1` is right for a transient blip and wrong for the one failure this
     * search actually has. Sorting by Newest on a broad term ("bitcoin") makes
     * Hivemind's own Postgres abort the query — `57014`, a statement timeout —
     * and it does so every single time. Measured 3 of 3 at 5.1-5.4s.
     *
     * Retrying that cannot succeed; it just runs the identical doomed query
     * again. End to end in the browser: first attempt 180ms -> 5,973ms (502),
     * retry 6,974ms -> 12,378ms. **12.4 seconds** before the reader is told
     * anything, and roughly half of it bought nothing. That is where the
     * reported "search takes ~8 seconds" comes from.
     *
     * Verified across nodes, so this is not something a different provider or a
     * failover would route around: of the six nodes in the server's own fallback
     * list, only two run the search plugin at all, and both time out on the same
     * query at ~5.1-5.4s. It is a backend limit, not a node choice.
     *
     * So: one retry for anything that might be transient, none for the failure
     * we have proven is not. Halves the worst case to ~5.8s.
     */
    retry: (failureCount, error) => {
      const message = error instanceof Error ? error.message : String(error ?? '');
      // Hivemind surfaces the abort as a 502 carrying the Postgres code; match on
      // either so a reworded upstream message still degrades to "retry once".
      // `search_timeout` is the route's own code for it (carried by `fetchJson` since 2026-09-05).
      if (/search_timeout|57014|statement timeout|canceling statement/i.test(message)) return false;
      return failureCount < 1;
    },
    staleTime: StaleTime.MEDIUM
  });

  // ★ USES THE SHARED SENTINEL (2026-08-23, second review). This surface had its own
  // `autoPagesRef` counter, and that counter was MONOTONIC — it only ever counted up, and
  // reset solely when the query or sort changed. Its comment claimed "past the cap the
  // reader pages by scrolling again"; scrolling refires the effect but the guard is a
  // counter, not a scroll test, so past five pages the sentinel rendered an empty div and
  // NOTHING could ever fetch again. `hasNextPage` stayed true, which also suppressed the
  // "That's every match" line, so the reader got no list, no control and no explanation.
  // The shared hook is the same bound with a way out: `atPageCap` says so, `loadMore()`
  // grants another window, `backToTop()` is offered alongside it. Every sibling feed
  // already uses it; search was the one surface that reimplemented it and got it wrong.
  const sentinel = useInfiniteScrollSentinel({
    hasNextPage,
    isFetching: isFetchingNextPage,
    isError,
    fetchNextPage,
    pagesLoaded: data?.pages?.length ?? 0,
    autoPageCap: FEED_AUTO_PAGE_CAP
  });

  // Both hooks must run on every render, above every early return below — a hook
  // after a conditional return corrupts hook order for the next render of this
  // list. See lib/nsfw.ts for the React #310 this exact pattern caused before.
  const nsfwPreference = useNsfwPreference();
  // ★ RE-RANKED PER PAGE FOR DISPLAY ONLY (2026-09-05). `getNextPageParam` above
  // reads the cursor from the RAW page, so this never touches pagination; see
  // `lib/search/rerank.ts` for the score and the measurement behind it. The
  // clock is fixed for the life of this list so an entry's score, and thus the
  // order, cannot drift between renders.
  const rankedAt = useRef(Date.now());
  const rawEntries = useMemo(
    () => (data?.pages ?? []).flatMap((page) => rerankSearchPage(page ?? [], rankedAt.current)),
    [data]
  );
  const marks = useRankMarks(rawEntries.map((entry) => entry.author));
  /* One market read for the whole page (3 state keys per creator, chunked at 33
     inside the data source). Threaded to the cards exactly like `useRankMarks`
     above/below it — a per-card fetch is the N+1 that cost this feed 30s a load. */
  const { prices } = useTokenPriceChips(rawEntries.map((entry) => entry.author));
  /* §2 rank luminosity for the avatar glow — shares `useRankMarks`' request. */
  const luminosity = useRankLuminosity(rawEntries.map((entry) => entry.author));

  // ★ THE READER'S OWN BLOCK LIST (2026-08-23). Every other list surface filters here —
  // the feed, the profile, post comments, the discussion — and search did not, so an
  // account you had blocked came back on the one surface where you go looking for people.
  //
  // `enabled` is gated on being signed in, deliberately. Passing `true` fires
  // `/api/lite/block/list` for anonymous visitors on a public page; with lite accounts
  // disabled that route answers 503, the hook throws, React Query retries, and the SHARED
  // `['lumenBlockList']` key degrades for every other consumer on the page.
  const blockList = useLumenBlockList(Boolean(user?.isLoggedIn));

  // Filter at the LIST, so the count below means "matches you will actually
  // see" and the scroll sentinel is not sitting in a zero-height list.
  const entries = filterVisiblePosts(rawEntries, nsfwPreference).filter(
    (entry) => !isBlockedEntry(entry, blockList)
  );
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
      <p className="font-sans text-[14px] leading-[22px] text-ink-10" data-testid="search-result-count">
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

      {/* ★ A LOADING STATE, NOT A HELD EMPTY STATE (owner item R-5, 2026-08-10).
          The page used to keep "Type above to begin" on screen for the entire
          search — measured at 3.5s here and reported at ~20s on a broad term —
          so the one message on screen told the reader nothing had started yet.
          `LumenLoader` is what the home feed shows while it loads (2026-08-12;
          it was `PostListSkeleton` until the ghost cards were retired). */}
      {isLoading ? (
        <LumenLoader size="lg" label={t('global.loading_search_results')} />
      ) : total === 0 ? (
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          {/* ★ Drawn empty state (2026-08-18) — a search that finds nothing was a
              single grey line, which reads more like a failure than a result. */}
          <EmptyStateIllustration name="no-results" size={128} />
          <p className="font-sans text-sm text-muted-foreground">{t('search_page.no_results_for', { query })}</p>
        </div>
      ) : (
        <div data-testid="search-results-list">
          {entries.map((entry) => (
            <MediumPostCard
            price={prices.get(entry.author)}
              luminosity={luminosity.get((entry.author ?? '').toLowerCase())}
              key={`${entry.author}-${entry.permlink}`}
              post={entry}
              mark={marks.get(entry.author?.toLowerCase() ?? '')}
            />
          ))}
        </div>
      )}

      {/* The sentinel: scrolling it into view fetches the next page.
          ★ KEYED ON `hasNextPage` ALONE, NOT ON `total > 0` (2026-08-23). With the block
          filter above, a page whose every result was authored by someone the reader
          blocked collapses `total` to 0 while the server still has more. Gating the
          sentinel on `total` then meant it never mounted, `inView` never fired, and the
          reader hit a confident dead end with more content one page away. This is the
          identical defect already found and fixed in `feed-tabs.tsx` — see its comment.
          Not a request loop: the effect above is guarded by `!isFetchingNextPage`. */}
      {hasNextPage ? (
        <div ref={sentinel.ref} className="py-6 text-center font-sans text-caption text-muted-foreground">
          {isFetchingNextPage ? (
            t('search_page.loading_more', { defaultValue: 'Loading more…' })
          ) : sentinel.atPageCap ? (
            /* No "back to top" alongside it: the siblings render that label as a hardcoded
               English string, and this project's rule is that user-facing text goes through
               `t()`. There is no key for it yet, so search offers the control that has one
               rather than adding a tenth untranslated string. */
            <button
              type="button"
              onClick={sentinel.loadMore}
              className="font-sans text-sm text-muted-foreground hover:text-foreground"
            >
              {t('cards.comment_card.load_more')}
            </button>
          ) : (
            ''
          )}
        </div>
      ) : null}
      {total > 0 && !hasNextPage ? (
        <p className="py-6 text-center font-sans text-caption text-muted-foreground">
          {t('search_page.end_of_results', { defaultValue: 'That’s every match.' })}
        </p>
      ) : null}
    </div>
  );
};

export default SearchResults;
