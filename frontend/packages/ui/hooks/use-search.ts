import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useNavigationProgress } from '@ui/components/navigation-progress';

import { buildSearchHref, type SearchScope, type SearchSort } from '@ui/lib/search-href';

/** `SearchSort` and `SearchScope` (what /search lists; posts needs no `t=`) live in `lib/search-href.ts`. */
export type { SearchScope, SearchSort };
export { buildSearchHref };

/**
 * ★★★ SEARCH IS ONE THING NOW: POSTS (owner ruling, 2026-08-10).
 *
 * This hook used to carry five MODES — `ai`, `classic`, `account`, `userTopic`,
 * `tag` — selected by a dropdown of five unlabelled icons and by four invisible
 * prefix characters (`@`, `#`, `/`, `%`) typed into the box. The dropdown was
 * removed on 2026-08-09 as unusable (no text content, no accessible name,
 * `aria-expanded` never left "false"), which left the modes reachable only by
 * prefixes nothing on screen ever mentioned. A mode you cannot see is not a
 * feature, it is a way for the box to silently search for something other than
 * what was typed — the exact failure that got `$` removed as a prefix.
 *
 * So: one field, one destination, `/search?q=…&s=…`. Account and tag lookups
 * were never searches at all, they were redirects to `/@name` and `/topics/tag`,
 * both of which are reachable by clicking any byline or topic in the product.
 *
 * `SearchSort` stays: a sort is a property of one result list, not a second
 * scope, and the search page still offers it.
 */
export function useSearch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { startNavigation } = useNavigationProgress();

  const query = searchParams?.get('q') ?? undefined;
  const sortQuery = searchParams?.get('s') ?? undefined;
  const scopeQuery: SearchScope = searchParams?.get('t') === 'people' ? 'people' : 'posts';

  const [inputValue, setInputValue] = useState(query ?? '');

  // Sync state with URL params (e.g. when navigating back, or when a search is
  // launched from one page and lands on another).
  useEffect(() => {
    setInputValue(query ?? '');
  }, [query]);

  /**
   * ★ SCOPE IS A SECOND, OPTIONAL PARAMETER (2026-09-05). Search has two
   * destinations again, posts and PEOPLE, but unlike the five removed modes
   * neither is chosen by an invisible prefix: the caller (a visible tab, or a
   * typeahead row the reader clicked) says which. Omitted, the scope the URL
   * already carries is kept, so changing the sort on the People tab does not
   * silently move the reader to Posts. `@name` typed into the field is the one
   * shortcut, and the header resolves it before calling this.
   */
  const handleSearch = (value: string, currentSort?: SearchSort, scope?: SearchScope) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    startNavigation();
    // `s=` from the URL is any string; only the two real sorts reach the href.
    const sort: SearchSort = currentSort ?? (sortQuery === 'created' ? 'created' : 'relevance');
    router.push(buildSearchHref(trimmed, sort, scope ?? scopeQuery));
  };

  return {
    inputValue,
    setInputValue,
    handleSearch,
    sortQuery,
    scopeQuery
  };
}
