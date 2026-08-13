'use client';

import PageShell from '@/blog/features/layouts/page-shell';
import SearchResults from '@/blog/features/search/search-results';
import { useTranslation } from '@/blog/i18n/client';
import { SearchSort } from '@ui/hooks/use-search';

interface SearchContentProps {
  query: string | undefined;
  sort: SearchSort;
}

const SearchContent = ({ query, sort }: SearchContentProps) => {
  const { t } = useTranslation('common_blog');
  return (
    // ★ THE LUMEN SHELL, NOT A BARE COLUMN (2026-08-08). Search rendered as a
    // centred max-w-4xl block with no left rail and none of the feed's framing,
    // so arriving here from the feed felt like leaving the product. Same three
    // columns, same gutters, same max width as home and topics — now via the
    // shared `PageShell` (F9, 2026-08-11) instead of this file's own copy of
    // the grid, so the frame can't drift out of sync with the other pages that
    // use it.
    <PageShell mainClassName="flex min-w-0 flex-col gap-6">
      {/* ★ A11Y ITEM 8/O5 -- one <h1> per page, carrying the query when there
          is one so a screen reader announces what was searched, not just
          that a search page exists. Visually hidden: the page has no visible
          title treatment (same ruling as the home feed, home-shell.tsx). */}
      <h1 className="sr-only">
        {query ? t('search_page.heading_for_query', { query }) : t('search_page.heading')}
      </h1>
      {/* ★ NO SECOND SEARCH BOX HERE (owner ruling, 2026-08-10). This page
          rendered its own `ModeSwitchInput` directly beneath the header's,
          so arriving at /search showed TWO identical empty "Search..." fields
          stacked on top of each other (live-verified: two
          `input[placeholder="Search..."]` in the DOM), with nothing to say
          which one the page listened to. The header field drives the route. */}
      {!query ? (
        <p className="py-10 text-center font-sans text-sm text-muted-foreground">
          {t('search_page.start_prompt', {
            defaultValue: 'Search Hive posts. Type in the field at the top and press Enter.'
          })}
        </p>
      ) : (
        <SearchResults query={query} sort={sort} />
      )}
    </PageShell>
  );
};

export default SearchContent;
