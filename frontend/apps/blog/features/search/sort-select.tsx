'use client';

import { SearchSort, useSearch } from '@ui/hooks/use-search';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★ A NATIVE <select>, NOT A RADIX ONE (2026-08-10, owner item R-6).
 *
 * This was a Radix `Select`, and a Radix trigger renders its value from the
 * matching `SelectItem`'s children — which only register once the client
 * mounts. Measured on the server-rendered HTML for /search: a 180px
 * `<button role="combobox">` containing no text node at all, filling in as
 * "Relevance" only after hydration. Same root cause as the `aria-controls`
 * it advertised, which named a listbox that does not exist until it is opened.
 *
 * A native select has no such gap: the selected option is in the first byte of
 * HTML, keyboard and screen-reader behaviour come from the platform, and the
 * `<label>` gives it a real accessible name, none of which the Radix version
 * had here.
 *
 * The sort is a URL parameter, so changing it re-runs the search the same way
 * the field does rather than mutating a second copy of the query held in
 * component state.
 *
 * ★ Every label carries a `defaultValue`: this app's SSR resolves no
 * translations (see the note in `search-input.tsx`), and a select whose first
 * painted option reads `search_page.sort_relevance` is no better than the empty
 * box this replaced.
 */
function SearchSortSelect({ query }: { query: string }) {
  const { t } = useTranslation('common_blog');
  const { handleSearch, sortQuery } = useSearch();

  return (
    <div className="flex shrink-0 items-center gap-2">
      <label htmlFor="search-sort" className="font-sans text-[13px] text-[#6b7280]">
        {t('search_page.sort_by', { defaultValue: 'Sort by' })}
      </label>
      <select
        id="search-sort"
        data-testid="search-sort-by-dropdown-list"
        value={(sortQuery as SearchSort) ?? 'relevance'}
        onChange={(event) => handleSearch(query, event.target.value as SearchSort)}
        className="h-9 rounded-[14px] border border-[#ebebeb] bg-white px-3 font-sans text-[13px] text-[#161511] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c0392b]/30"
      >
        <option value="relevance">{t('search_page.sort_relevance', { defaultValue: 'Relevance' })}</option>
        <option value="created">{t('search_page.sort_newest', { defaultValue: 'Newest' })}</option>
      </select>
    </div>
  );
}

export default SearchSortSelect;
