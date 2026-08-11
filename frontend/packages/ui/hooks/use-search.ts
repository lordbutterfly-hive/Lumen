import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useNavigationProgress } from '@ui/components/navigation-progress';

export type SearchSort = 'created' | 'relevance';

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

  const [inputValue, setInputValue] = useState(query ?? '');

  // Sync state with URL params (e.g. when navigating back, or when a search is
  // launched from one page and lands on another).
  useEffect(() => {
    setInputValue(query ?? '');
  }, [query]);

  const handleSearch = (value: string, currentSort?: SearchSort) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    startNavigation();
    router.push(
      `/search?q=${encodeURIComponent(trimmed)}&s=${currentSort ?? sortQuery ?? 'relevance'}`
    );
  };

  return {
    inputValue,
    setInputValue,
    handleSearch,
    sortQuery
  };
}
