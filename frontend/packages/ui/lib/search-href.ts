/**
 * The one place the /search URL is spelled, so the scope tabs, the typeahead
 * rows and the header field can never disagree about it. Dependency-free on
 * purpose: `apps/blog/features/search/lib/suggestion-rows.ts` (pure, unit
 * tested under plain ts-node) needs it without dragging `next/navigation` in
 * through `hooks/use-search.ts`, which re-exports it for hook callers.
 */
export type SearchScope = 'posts' | 'people';
export type SearchSort = 'created' | 'relevance';

export function buildSearchHref(query: string, sort: SearchSort = 'relevance', scope: SearchScope = 'posts'): string {
  const base = `/search?q=${encodeURIComponent(query)}&s=${sort}`;
  return scope === 'people' ? `${base}&t=people` : base;
}
