'use client';

import { KeyboardEvent, useCallback } from 'react';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { useSearch } from '@ui/hooks/use-search';
import { useTranslation } from '@/blog/i18n/client';

/**
 * ★★★ THE ONLY SEARCH FIELD IN LUMEN (owner ruling, 2026-08-10).
 *
 * Replaces `packages/ui/components/mode-switch-input.tsx`, which was a scope
 * dropdown + a text box + a conditional SECOND text box + a sort control, all
 * in the header. Three of those four are gone:
 *
 *   * the scope dropdown was dead on arrival — `role="combobox"` with no text
 *     content, no accessible name, `aria-expanded` stuck at "false" and
 *     `aria-controls` naming an element that never existed;
 *   * the second box only appeared in `userTopic` mode, which nothing on screen
 *     could select any more;
 *   * the sort control belongs on the results, not on the field, and now lives
 *     there (`sort-select.tsx`).
 *
 * Lives in the blog app rather than in `@hive/ui` because it has user-facing
 * copy, and `@hive/ui` has no i18n. The old component hardcoded English
 * placeholders for that reason.
 *
 * The placeholder says "Search posts" rather than "Search..." for the same
 * reason the dropdown had to go: with no scope selector left, the field itself
 * is the only thing that can say what it searches.
 */
export function SearchInput({ className }: { className?: string }) {
  const { t } = useTranslation('common_blog');
  const { inputValue, setInputValue, handleSearch } = useSearch();

  const onSearchClick = useCallback(() => {
    handleSearch(inputValue);
  }, [inputValue, handleSearch]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        onSearchClick();
      }
    },
    [onSearchClick]
  );

  // ★ `defaultValue`, BECAUSE SSR IN THIS APP RESOLVES NO TRANSLATIONS AT ALL
  // (measured 2026-08-10). `i18n/client.ts` loads each namespace through an
  // async `resourcesToBackend` import that the server render does not await, so
  // the server-rendered HTML for /search carries the literal strings
  // `search_page.start_prompt` and `search_page.input_placeholder` and only
  // becomes real copy after hydration — three warm requests in a row, same
  // result, and true of the page's pre-existing keys too. i18next falls back to
  // `defaultValue` when a key cannot be resolved, so the key stays the source
  // of truth for translators while first paint shows words instead of a key.
  const placeholder = t('search_page.input_placeholder', { defaultValue: 'Search posts' });

  return (
    <div className={cn('w-full', className)}>
      <div className="relative flex w-full items-center rounded-full border border-line-9 bg-surface-1 ring-offset-background focus-within:border-line-19">
        <input
          type="search"
          placeholder={placeholder}
          aria-label={placeholder}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="z-10 block h-8 w-full bg-transparent p-2 pl-4 font-sans text-sm text-ink-2 ring-offset-background placeholder:text-ink-10 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          onKeyDown={onKeyDown}
          data-testid="header-search-input"
        />
        <button
          type="button"
          onClick={onSearchClick}
          className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-10 transition-colors hover:bg-surface-21 hover:text-ink-2"
          aria-label={placeholder}
        >
          <Icons.search className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default SearchInput;
