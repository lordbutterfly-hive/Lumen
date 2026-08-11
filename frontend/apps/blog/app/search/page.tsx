import SearchContent from './content';
import { getObserverFromCookies } from '@/blog/lib/auth-utils';
import { parseSearchParams } from '@ui/lib/search-params';
import { ObserverProvider } from '@/blog/components/observer-provider';
import type { SearchSort } from '@ui/hooks/use-search';

interface SearchPageProps {
  searchParams: { [key: string]: string | string[] | undefined };
}

/**
 * ★★★ THE SERVER NO LONGER RUNS THE SEARCH (2026-08-10, owner item R-5).
 *
 * This page used to `await getByText(...)` before returning anything, and pass
 * the result down as react-query `initialData`. On a hard load that was fine —
 * `loading.tsx` covered the wait. On the path a reader actually takes it was
 * not: typing in the header field calls `router.push`, and a soft navigation
 * does not re-enter `loading.tsx` for a searchParams-only change, so the router
 * simply sat on the OLD page until the server finished.
 *
 * Measured on this box before the change (typed "hive engine" + Enter on
 * /search): from 840ms to 3552ms the page showed zero skeletons, the URL was
 * still `/search`, and the empty state "Type above to begin" was still the only
 * thing on screen. The owner's report of a ~20s wait is the same code path on a
 * broader term — and "type above to begin", held for 20 seconds after typing
 * above and beginning, reads as a failure, not as progress.
 *
 * Fetching from the client instead makes the navigation instant (there is
 * nothing left to await here) and gives the results component a real
 * `isLoading` to render skeletons from. Same one request to the same endpoint,
 * just issued where its pending state is visible.
 *
 * ★ A SORT IS ALWAYS IMPLIED, SO NEVER LET ITS ABSENCE CANCEL THE SEARCH.
 * A URL with a query but no `s=` — a hand-typed, bookmarked or shared search
 * URL — searched for nothing and rendered a blank page. Relevance is the
 * default the control itself shows, so this makes the URL agree with the UI.
 */
const SearchPage = async ({ searchParams }: SearchPageProps) => {
  const validatedParams = parseSearchParams(searchParams);
  const query = validatedParams.q;
  const sort: SearchSort = (validatedParams.s as SearchSort | undefined) ?? 'relevance';

  const observer = await getObserverFromCookies();

  return (
    <ObserverProvider value={observer}>
      <SearchContent query={query} sort={sort} />
    </ObserverProvider>
  );
};

export default SearchPage;
