'use client';

import { Icons } from '@ui/components/icons';
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
 *
 * ★★ DO NOT "FIX" THIS BY SWAPPING BACK TO `@ui/components/select` (F9,
 * 2026-08-11, buildmap P3 "/search: a raw unstyled native <select>...every
 * other dropdown in the app is custom"). `@ui/components/select` IS the Radix
 * one this file replaced two days ago, for the measured reason above — every
 * other dropdown in the app that uses it (`post-select-filter.tsx`,
 * `communities-select.tsx`, etc.) still has that blank-on-first-paint gap,
 * this is just the one place it was already fixed. Reverting would
 * reintroduce a real, documented bug to chase a purely cosmetic one.
 *
 * What was genuinely true in that report: a bare native `<select>` shows the
 * PLATFORM's own dropdown arrow no matter what border/radius classes you put
 * on the box, so next to the app's Radix triggers (which draw their own
 * `ChevronDown`) it read as unstyled at the one spot that can't be reached
 * with Tailwind alone. `appearance-none` plus the same `ChevronDown` icon the
 * Radix trigger uses closes that gap without touching the element itself —
 * still a real `<select>`, still correct on the first byte of HTML.
 */
function SearchSortSelect({ query }: { query: string }) {
  const { t } = useTranslation('common_blog');
  const { handleSearch, sortQuery } = useSearch();

  return (
    <div className="flex shrink-0 items-center gap-2">
      <label htmlFor="search-sort" className="font-sans text-[13px] leading-[20px] text-ink-10">
        {t('search_page.sort_by', { defaultValue: 'Sort by' })}
      </label>
      <div className="relative">
        <select
          id="search-sort"
          data-testid="search-sort-by-dropdown-list"
          value={(sortQuery as SearchSort) ?? 'relevance'}
          onChange={(event) => handleSearch(query, event.target.value as SearchSort)}
          className="h-9 appearance-none rounded-[14px] border border-line-9 bg-surface-1 py-0 pl-3 pr-8 font-sans text-[13px] leading-[20px] text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10/30"
        >
          <option value="relevance">{t('search_page.sort_relevance', { defaultValue: 'Relevance' })}</option>
          <option value="created">{t('search_page.sort_newest', { defaultValue: 'Newest' })}</option>
        </select>
        <Icons.chevronDown
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-14"
        />
      </div>
    </div>
  );
}

export default SearchSortSelect;
