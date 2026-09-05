'use client';

import { KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserAvatarImg } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { useSearch } from '@ui/hooks/use-search';
import { useNavigationProgress } from '@ui/components/navigation-progress';
import { useTranslation } from '@/blog/i18n/client';
import { intendsPeople } from '@/blog/lib/search/query';
import { useSearchSuggestions } from './use-search-suggestions';
import { buildSuggestionRows, defaultRow, stepActiveIndex, type SuggestionRow } from './lib/suggestion-rows';
import { clearRecentSearches, readRecentSearches, rememberSearch } from './lib/recent-searches';

/**
 * ★★★ THE ONLY SEARCH FIELD IN LUMEN (owner ruling, 2026-08-10), NOW A REAL
 * COMBOBOX (2026-09-05).
 *
 * History, kept because the shape of this component is the lesson: the
 * previous `mode-switch-input.tsx` had a scope dropdown with `role="combobox"`
 * but no text content, no accessible name, `aria-expanded` stuck at "false" and
 * `aria-controls` naming an element that never existed. It was removed, and the
 * field became a plain input whose only behaviour was Enter. The owner's
 * report on 2026-09-05 was that "search does not work at all": typing showed
 * nothing, a username searched posts about the username, and nothing on
 * screen said what Enter would do.
 *
 * So this is the ARIA combobox pattern for real: the input carries
 * `role="combobox"`, `aria-expanded` follows the list, `aria-controls` names a
 * listbox that exists whenever it is true, `aria-activedescendant` names the
 * highlighted option, and every option has an id (from `useId()`, so the
 * desktop instance in the header grid and the mobile instance in the row
 * below it never share one). Arrow keys move, Enter performs, Escape closes.
 *
 * The rows come from `lib/suggestion-rows.ts` (pure): two ACTION rows first,
 * "Search posts for..." and "Search people for...", so the reader can see what
 * Enter does before pressing it; then accounts (Hive and Lumen lite) and
 * topics from `/api/search/suggest`; recent searches when the field is empty.
 *
 * Lives in the blog app rather than in `@hive/ui` because it has user-facing
 * copy, and `@hive/ui` has no i18n.
 */
export function SearchInput({ className }: { className?: string }) {
  const { t } = useTranslation('common_blog');
  const { inputValue, setInputValue, handleSearch } = useSearch();
  const router = useRouter();
  const { startNavigation } = useNavigationProgress();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recent, setRecent] = useState<string[]>([]);

  const { suggestions } = useSearchSuggestions(inputValue, open);
  const rows = useMemo(
    () => buildSuggestionRows({ text: inputValue, suggestions, recent }),
    [inputValue, suggestions, recent]
  );
  // A new keystroke discards the highlight: the row it pointed at may be gone.
  useEffect(() => {
    setActiveIndex(-1);
  }, [inputValue]);
  const active = activeIndex >= 0 && activeIndex < rows.length ? activeIndex : -1;
  const showList = open && rows.length > 0;

  const optionId = (row: SuggestionRow) => `${listId}-${row.id.replace(/[^a-z0-9_-]/gi, '_')}`;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  const activate = useCallback(
    (row: SuggestionRow) => {
      close();
      inputRef.current?.blur();
      switch (row.kind) {
        case 'posts':
        case 'recent':
          rememberSearch(row.query);
          handleSearch(row.query, undefined, 'posts');
          return;
        case 'people':
          rememberSearch(row.query);
          handleSearch(row.query, undefined, 'people');
          return;
        case 'account':
        case 'tag':
          startNavigation();
          router.push(row.href);
          return;
      }
    },
    [close, handleSearch, router, startNavigation]
  );

  /** Enter with nothing highlighted, or the magnifier button. */
  const submit = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    const row = defaultRow(rows);
    if (row) {
      activate(row);
      return;
    }
    rememberSearch(text);
    handleSearch(text, undefined, intendsPeople(text) ? 'people' : 'posts');
  }, [inputValue, rows, activate, handleSearch]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          if (!open) setOpen(true);
          setActiveIndex((index) => stepActiveIndex(index, 1, rows.length));
          return;
        case 'ArrowUp':
          event.preventDefault();
          setActiveIndex((index) => stepActiveIndex(index, -1, rows.length));
          return;
        case 'Enter':
          event.preventDefault();
          if (showList && active >= 0) activate(rows[active]);
          else submit();
          return;
        case 'Escape':
          // A `type="search"` input clears itself on Escape in Chromium; the
          // reader pressed it to dismiss the list, not to lose the text.
          if (open) {
            event.preventDefault();
            close();
          }
          return;
        case 'Tab':
          close();
          return;
      }
    },
    [open, rows, active, showList, activate, submit, close]
  );

  const onFocus = useCallback(() => {
    setRecent(readRecentSearches());
    setOpen(true);
  }, []);

  const onClearRecent = useCallback(() => {
    clearRecentSearches();
    setRecent([]);
  }, []);

  // `defaultValue` copy for the same reason every label on the search page
  // carries one: this app's SSR resolves no translations (measured 2026-08-10,
  // see the note that used to live here), so first paint shows words, not keys.
  const placeholder = t('search_page.input_placeholder', { defaultValue: 'Search posts and people' });

  return (
    <div className={cn('relative w-full', className)}>
      <div className="relative flex w-full items-center rounded-full border border-line-9 bg-surface-1 ring-offset-background focus-within:border-line-brand-10">
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && active >= 0 ? optionId(rows[active]) : undefined}
          autoComplete="off"
          placeholder={placeholder}
          aria-label={placeholder}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={onFocus}
          onBlur={close}
          onKeyDown={onKeyDown}
          className="z-10 block h-8 w-full bg-transparent p-2 pl-4 font-sans text-sm text-ink-2 ring-offset-background placeholder:text-ink-10 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          data-testid="header-search-input"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
          className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-10 transition-colors hover:bg-surface-21 hover:text-ink-2"
          aria-label={placeholder}
        >
          <Icons.search className="h-4 w-4" />
        </button>
      </div>

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('search_page.suggest_listbox_label', { defaultValue: 'Search suggestions' })}
          data-testid="header-search-suggestions"
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[70vh] overflow-y-auto rounded-panel border border-line-9 bg-surface-1 py-1 font-sans text-sm text-ink-2 shadow-lg"
        >
          {rows.map((row, index) => {
            const heading = headingFor(rows, index);
            return (
              <SuggestionOption
                key={row.id}
                row={row}
                id={optionId(row)}
                selected={index === active}
                heading={
                  heading
                    ? {
                        label: t(`search_page.${heading}`, { defaultValue: HEADING_FALLBACK[heading] }),
                        onClear: heading === 'suggest_recent_heading' ? onClearRecent : undefined,
                        clearLabel: t('search_page.suggest_clear_recent', { defaultValue: 'Clear' })
                      }
                    : undefined
                }
                label={rowLabel(row, t)}
                liteBadge={t('search_page.suggest_lite_badge', { defaultValue: 'Lumen' })}
                onActivate={() => activate(row)}
                onHover={() => setActiveIndex(index)}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

type HeadingKey = 'suggest_people_heading' | 'suggest_topics_heading' | 'suggest_recent_heading';

const HEADING_FALLBACK: Record<HeadingKey, string> = {
  suggest_people_heading: 'People',
  suggest_topics_heading: 'Topics',
  suggest_recent_heading: 'Recent searches'
};

/** A group heading before the FIRST row of each suggestion kind (the two action rows have none). */
function headingFor(rows: readonly SuggestionRow[], index: number): HeadingKey | null {
  const row = rows[index];
  const previous = index > 0 ? rows[index - 1] : null;
  if (previous && previous.kind === row.kind) return null;
  if (row.kind === 'account') return 'suggest_people_heading';
  if (row.kind === 'tag') return 'suggest_topics_heading';
  if (row.kind === 'recent') return 'suggest_recent_heading';
  return null;
}

function rowLabel(row: SuggestionRow, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (row.kind) {
    case 'posts':
      return t('search_page.suggest_posts_action', { query: row.query, defaultValue: 'Search posts for “{{query}}”' });
    case 'people':
      return t('search_page.suggest_people_action', {
        query: row.query,
        defaultValue: 'Search people for “{{query}}”'
      });
    case 'account':
      return row.displayName ?? row.name;
    case 'tag':
      return row.tag;
    case 'recent':
      return row.query;
  }
}

function SuggestionOption({
  row,
  id,
  selected,
  heading,
  label,
  liteBadge,
  onActivate,
  onHover
}: {
  row: SuggestionRow;
  id: string;
  selected: boolean;
  heading?: { label: string; onClear?: () => void; clearLabel: string };
  label: string;
  liteBadge: string;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <>
      {heading ? (
        <li role="presentation" className="flex items-center justify-between px-3 pb-1 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-14">{heading.label}</span>
          {heading.onClear ? (
            <button
              type="button"
              tabIndex={-1}
              // `mousedown` would blur the input and close the list before `click` lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={heading.onClear}
              className="text-[11px] font-medium text-ink-10 hover:text-ink-2 hover:underline"
            >
              {heading.clearLabel}
            </button>
          ) : null}
        </li>
      ) : null}
      <li
        id={id}
        role="option"
        aria-selected={selected}
        data-testid="header-search-option"
        data-kind={row.kind}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onActivate}
        onMouseMove={onHover}
        className={cn(
          'flex cursor-pointer items-center gap-3 px-3 py-2',
          selected ? 'bg-surface-21' : 'hover:bg-surface-21'
        )}
      >
        <RowIcon row={row} />
        <span className="min-w-0 flex-1 truncate">
          {label}
          {row.kind === 'account' && row.displayName ? <span className="ml-2 text-ink-10">@{row.name}</span> : null}
        </span>
        {row.kind === 'account' && row.accountKind === 'lite' ? (
          <span className="shrink-0 rounded-full bg-surface-21 px-1.5 py-px text-[11px] font-medium text-ink-10">
            {liteBadge}
          </span>
        ) : null}
      </li>
    </>
  );
}

function RowIcon({ row }: { row: SuggestionRow }) {
  switch (row.kind) {
    case 'posts':
      return <Icons.search className="h-4 w-4 shrink-0 text-ink-10" aria-hidden />;
    case 'people':
      return <Icons.user className="h-4 w-4 shrink-0 text-ink-10" aria-hidden />;
    case 'recent':
      return <Icons.clock className="h-4 w-4 shrink-0 text-ink-10" aria-hidden />;
    case 'tag':
      return (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-21 text-[12px] font-semibold text-ink-10">
          #
        </span>
      );
    case 'account':
      return <UserAvatarImg username={row.name} pixelSize={24} className="shrink-0" />;
  }
}

export default SearchInput;
