'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { cn } from '@ui/lib/utils';
import { EMOJI_CATEGORIES, searchEmoji, type EmojiEntry } from './emoji-data';

/** One key, user preference, never expires — same class as `votesValues`. */
const RECENT_KEY = 'lumen-composer-recent-emoji';
const RECENT_MAX = 16;

/** Gap kept between the picker and whatever it is clear of (button, header, viewport edge). */
const SAFE_GAP = 8;
/**
 * Fallback for the sticky site header's height, used only if it cannot be found live.
 * Mirrors the QA harness's own empirical figure for this exact bar
 * (`qa/harness/detectors/page-checks.mjs:286`, `app-header.tsx:219`'s `sticky top-0 z-40`).
 */
const HEADER_HEIGHT_FALLBACK = 90;

interface PickerGeometry {
  /** Open above the button (original layout) vs. below it. */
  openUpward: boolean;
  /** Pixel shift off the natural `left: 0` (flush with the button cluster), to stay on screen. */
  leftOffset: number;
  /** Set only when NEITHER side has room for the picker's natural height. */
  maxHeight: number | null;
  /**
   * Viewport coordinates for `fixedPosition` mode (quick-reply, review F3) —
   * same flip/clamp decision as above, expressed as `position:fixed` offsets.
   * `undefined` in the default (absolute) mode, so the quick-post path is
   * byte-identical to what it always rendered.
   */
  fixed?: { left: number; top: number | null; bottom: number | null };
}

const INITIAL_GEOMETRY: PickerGeometry = { openUpward: true, leftOffset: 0, maxHeight: null };

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
 *
 * ★★ POSITION IS COMPUTED, NOT FIXED (2026-08-28 clipping fix). This used to
 * open upward unconditionally (`bottom-[calc(100%+8px)]`, no other case), so
 * whenever the toolbar sat within one picker-height of the top of the page its
 * own top rows painted behind `app-header.tsx`'s `sticky top-0 z-40` bar — the
 * owner's screenshot. `useLayoutEffect` below measures the real space above vs.
 * below the button (excluding whatever the sticky header currently covers) and
 * flips to open below when there isn't room above; if NEITHER side fully fits
 * (a short viewport), it opens on whichever side has more room and caps its own
 * height to that, so it is always entirely on screen. Horizontally, the picker
 * stays flush with the button cluster unless its fixed 360px width would run
 * past the right edge of the viewport (the 390px-phone case), in which case it
 * shifts left just enough to stay on screen. Recomputed on resize and scroll so
 * a picker left open while the page moves stays correctly placed.
 */
export default function EmojiPicker({
  onSelect,
  onClose,
  labels,
  fixedPosition = false,
  testIdPrefix = 'short-form-composer'
}: {
  onSelect: (glyph: string) => void;
  onClose: () => void;
  labels: EmojiPickerLabels;
  /**
   * ★ OPT-IN `position:fixed` placement (2026-09-03, quick-reply review F3).
   * The feed drawer is a JS-measured, `overflow:hidden` box, so the default
   * `absolute` picker gets CLIPPED at the drawer's edge — and being absolutely
   * positioned it never resizes the drawer's observed content either, so
   * nothing remeasures. With this flag the picker stays in the SAME DOM
   * position (focus-within, the composer's blur containment and the
   * outside-click close below are all unchanged) but is positioned against the
   * VIEWPORT, which no `overflow:hidden` ancestor can clip. The same
   * flip/clamp geometry runs; only the output coordinates differ. CAVEAT: a
   * transformed/filtered ancestor would re-trap `fixed` — verified absent for
   * the drawer (post-card.module.css: the card hovers with shadow only).
   * Default `false` keeps the quick-post byte-identical.
   */
  fixedPosition?: boolean;
  /** Prefix for data-testids; default keeps the quick-post's existing ids. */
  testIdPrefix?: string;
}) {
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0].id);
  const [recent, setRecent] = useState<string[]>([]);
  const [geometry, setGeometry] = useState<PickerGeometry>(INITIAL_GEOMETRY);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * Zero-size in-place probe for `fixedPosition` mode: a `position:fixed` root
   * reports `offsetParent: null`, so the anchor (the footer's `relative`
   * container) is read off this absolutely-positioned sibling instead — it sits
   * in the exact slot the picker renders in, so its `offsetParent` is the same
   * element the absolute mode anchors to.
   */
  const probeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  // ★ `useLayoutEffect`, not `useEffect`: it must run and commit BEFORE the
  // browser paints, or the picker would flash at its old position for one frame
  // every time the search/category/recent content resizes it.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    const recompute = () => {
      // The nearest positioned ancestor IS the anchor the picker is positioned
      // against (the footer's `relative` container, which starts flush with the
      // button cluster) — no extra ref needs to be threaded down for this. In
      // `fixedPosition` mode the root's own offsetParent is null (fixed
      // elements have none), so the same ancestor is read off the in-place
      // probe instead.
      const anchor = (fixedPosition ? probeRef.current?.offsetParent : node.offsetParent) as HTMLElement | null;
      if (!anchor) return;

      const anchorRect = anchor.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      // `scrollHeight`, not `offsetHeight`: once a previous pass has capped
      // `maxHeight`, `offsetHeight` would only report the CLAMPED box, and a
      // later resize (viewport growing taller) could never re-expand it.
      const pickerHeight = node.scrollHeight;
      const pickerWidth = node.offsetWidth;

      const header = document.querySelector('header.sticky.top-0.z-40');
      const headerBottom = header ? header.getBoundingClientRect().bottom : HEADER_HEIGHT_FALLBACK;

      const spaceAbove = Math.max(0, anchorRect.top - headerBottom);
      const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom);
      const fitsAbove = spaceAbove >= pickerHeight + SAFE_GAP;
      const fitsBelow = spaceBelow >= pickerHeight + SAFE_GAP;

      const openUpward = fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow);
      const chosenSpace = openUpward ? spaceAbove : spaceBelow;
      const chosenFits = openUpward ? fitsAbove : fitsBelow;
      const maxHeight = chosenFits ? null : Math.max(160, chosenSpace - SAFE_GAP);

      // Horizontal: keep the picker's left edge flush with the button cluster
      // (the original `left: 0`) unless the fixed-width box would run past the
      // right edge of the viewport, in which case shift left just enough to
      // stay fully on screen (never past the left edge either).
      const naturalLeft = anchorRect.left;
      const maxLeft = viewportWidth - pickerWidth - SAFE_GAP;
      const clampedLeft = Math.min(naturalLeft, Math.max(SAFE_GAP, maxLeft));

      setGeometry({
        openUpward,
        leftOffset: clampedLeft - naturalLeft,
        maxHeight,
        // Same decision, viewport-fixed output: upward pins the picker's BOTTOM
        // 8px above the anchor's top (no height needed); downward pins its TOP
        // 8px below the anchor's bottom. The scroll/resize listeners below
        // recompute on every event, so the fixed box stays glued to the anchor.
        fixed: fixedPosition
          ? {
              left: clampedLeft,
              top: openUpward ? null : anchorRect.bottom + SAFE_GAP,
              bottom: openUpward ? viewportHeight - anchorRect.top + SAFE_GAP : null
            }
          : undefined
      });
    };

    recompute();
    window.addEventListener('resize', recompute);
    // `capture: true` so scrolling inside ANY ancestor scroll container is
    // observed (`scroll` does not bubble on its own, unlike most DOM events).
    window.addEventListener('scroll', recompute, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, { capture: true });
    };
    // Re-measure whenever the picker's own content can change its natural
    // height (query/category swap the grid, a first-ever pick adds the
    // "Recent" section) — the flip/clamp decision above depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categoryId, recent.length, fixedPosition]);

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
    <>
      {/* In-place anchor probe for `fixedPosition` mode — zero-size, no layout
          impact; see `probeRef`'s doc. Rendered only when needed. */}
      {fixedPosition ? (
        <span ref={probeRef} aria-hidden="true" style={{ position: 'absolute', width: 0, height: 0 }} />
      ) : null}
    <div
      ref={rootRef}
      role="dialog"
      aria-label={labels.searchLabel}
      data-testid={`${testIdPrefix}-emoji-picker`}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      style={
        geometry.fixed
          ? {
              position: 'fixed',
              left: geometry.fixed.left,
              top: geometry.fixed.top ?? undefined,
              bottom: geometry.fixed.bottom ?? undefined,
              maxHeight: geometry.maxHeight ?? undefined
            }
          : { left: geometry.leftOffset, maxHeight: geometry.maxHeight ?? undefined }
      }
      className={cn(
        'z-30 w-[360px] overflow-y-auto rounded-card border border-[#ebebeb] bg-white p-3 shadow-[0_8px_24px_rgba(20,18,10,0.10)]',
        // ★ 2026-08-28: was `bottom-[calc(100%+8px)]` unconditionally — see the
        // component doc comment above for why this is now computed. In
        // `fixedPosition` mode the inline style above carries the placement
        // instead (review F3).
        !geometry.fixed && 'absolute',
        !geometry.fixed && (geometry.openUpward ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]')
      )}
    >
      <input
        type="text"
        value={query}
        aria-label={labels.searchLabel}
        placeholder={labels.searchPlaceholder}
        onChange={(event) => setQuery(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        data-testid={`${testIdPrefix}-emoji-search`}
        className="mb-2 w-full rounded-control border border-[#ebebeb] bg-white px-3 py-2 font-sans text-[14px] leading-[22px] text-[#333] outline-none focus-visible:outline-none placeholder:text-ink-14 focus:border-[#d5d5d5]"
      />

      {!query.trim() && recent.length > 0 ? (
        <div className="mb-2">
          <div className="mb-1 px-1 font-sans text-label font-semibold uppercase tracking-wide text-ink-14">
            {labels.recent}
          </div>
          <div className="grid grid-cols-8 gap-1">
            {recent.map((glyph) => (
              <button
                key={`recent-${glyph}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(glyph)}
                className="flex h-9 w-9 items-center justify-center rounded-control text-[20px] leading-none transition-colors hover:bg-[#f1f3f5]"
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
                'flex h-8 w-8 items-center justify-center rounded-control text-[17px] leading-none transition-colors hover:bg-[#f1f3f5]',
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
          <p className="px-1 py-4 text-center font-sans text-caption text-[#6b7280]">{labels.noResults}</p>
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
                data-testid={`${testIdPrefix}-emoji-option`}
                className="flex h-9 w-9 items-center justify-center rounded-control text-[20px] leading-none transition-colors hover:bg-[#f1f3f5]"
              >
                {entry.glyph}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
