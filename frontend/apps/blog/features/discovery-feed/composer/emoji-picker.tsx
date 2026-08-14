'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { cn } from '@ui/lib/utils';
import { EMOJI_CATEGORIES, searchEmoji, type EmojiEntry } from './emoji-data';

/** One key, user preference, never expires — same class as `votesValues`. */
const RECENT_KEY = 'lumen-composer-recent-emoji';
const RECENT_MAX = 16;

function readRecent(): string[] {
  const stored = getStorageItem<string[]>(RECENT_KEY);
  return Array.isArray(stored) ? stored.slice(0, RECENT_MAX) : [];
}

export interface EmojiPickerLabels {
  searchLabel: string;
  searchPlaceholder: string;
  noResults: string;
  recent: string;
}

/**
 * A native-unicode emoji picker (audit §9.5).
 *
 * ★ Hand-rolled rather than a Radix `Popover` ON PURPOSE. Radix moves focus into
 * the popover when it opens and restores it on close; here the textarea must
 * KEEP focus the whole time, because the caret position is where the glyph gets
 * inserted and because the composer collapses the moment it blurs. Every
 * interactive element below therefore cancels its own mousedown.
 *
 * ★ Loaded through `next/dynamic({ ssr: false })` by the composer, so neither
 * this component nor `emoji-data.ts` is in the Home bundle until the button is
 * pressed.
 */
export default function EmojiPicker({
  onSelect,
  onClose,
  labels
}: {
  onSelect: (glyph: string) => void;
  onClose: () => void;
  labels: EmojiPickerLabels;
}) {
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0].id);
  const [recent, setRecent] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    // `mousedown` on the document closes on an outside click. The trigger button
    // cancels its own mousedown, so re-pressing it toggles rather than
    // close-then-reopen.
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onClose]);

  const results = useMemo(() => searchEmoji(query), [query]);
  const category = EMOJI_CATEGORIES.find((c) => c.id === categoryId) ?? EMOJI_CATEGORIES[0];
  const shown: EmojiEntry[] = query.trim() ? results : category.emoji;

  const pick = (glyph: string) => {
    const next = [glyph, ...recent.filter((g) => g !== glyph)].slice(0, RECENT_MAX);
    setRecent(next);
    setStorageItem(RECENT_KEY, next, StorageTTL.PERMANENT);
    onSelect(glyph);
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={labels.searchLabel}
      data-testid="short-form-composer-emoji-picker"
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[360px] rounded-[14px] border border-[#ebebeb] bg-white p-3 shadow-[0_8px_24px_rgba(20,18,10,0.10)]"
    >
      <input
        type="text"
        value={query}
        aria-label={labels.searchLabel}
        placeholder={labels.searchPlaceholder}
        onChange={(event) => setQuery(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="short-form-composer-emoji-search"
        className="mb-2 w-full rounded-[10px] border border-[#ebebeb] bg-white px-3 py-2 font-sans text-[14px] leading-[22px] text-[#333] outline-none placeholder:text-[#9ca3af] focus:border-[#d5d5d5]"
      />

      {!query.trim() && recent.length > 0 ? (
        <div className="mb-2">
          <div className="mb-1 px-1 font-sans text-[11px] font-semibold uppercase tracking-wide text-[#9ca3af]">
            {labels.recent}
          </div>
          <div className="grid grid-cols-8 gap-1">
            {recent.map((glyph) => (
              <button
                key={`recent-${glyph}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(glyph)}
                className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[20px] leading-none transition-colors hover:bg-[#f1f3f5]"
              >
                {glyph}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!query.trim() ? (
        <div className="mb-2 flex items-center gap-1 border-b border-[#f0f0f0] pb-2" role="tablist">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === categoryId}
              aria-label={c.label}
              title={c.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCategoryId(c.id)}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-[8px] text-[17px] leading-none transition-colors hover:bg-[#f1f3f5]',
                c.id === categoryId && 'bg-[#f1f3f5]'
              )}
            >
              {c.tabGlyph}
            </button>
          ))}
        </div>
      ) : null}

      <div className="max-h-[220px] overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-1 py-4 text-center font-sans text-[13px] text-[#6b7280]">{labels.noResults}</p>
        ) : (
          <div className="grid grid-cols-8 gap-1">
            {shown.map((entry) => (
              <button
                key={entry.glyph}
                type="button"
                aria-label={entry.name}
                title={entry.name}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(entry.glyph)}
                data-testid="short-form-composer-emoji-option"
                className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[20px] leading-none transition-colors hover:bg-[#f1f3f5]"
              >
                {entry.glyph}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
