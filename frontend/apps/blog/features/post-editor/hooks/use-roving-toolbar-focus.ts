'use client';

import { KeyboardEvent, useRef, useState } from 'react';

/**
 * Roving-tabindex focus for a single-row toolbar — the WAI-ARIA APG
 * "toolbar" pattern (https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/):
 * exactly ONE item is a Tab stop at a time (`activeIndex`, default the
 * first), and the arrow keys move that stop AND real focus together.
 * Tab itself is never intercepted here — the browser's own Tab handling
 * enters/leaves the toolbar at whichever single button is currently
 * tabbable, the same as any other control.
 *
 * ★ Added 2026-08-13 (QA V3-a11y item 1) for `EditorToolbar.tsx`, whose
 * ~16 buttons previously carried a hardcoded `tabIndex={-1}` each with no
 * other way to move focus between them — measured live: 50 Tab presses
 * from the title field never once reached Bold. Kept generic (index count
 * in, per-item props out) so any other toolbar-shaped row can reuse it
 * rather than re-deriving the same key handling.
 *
 * Left/Right AND Up/Down both move next/previous — this toolbar's
 * container is `flex-wrap`, so buttons can land on a second visual row at
 * narrow widths, but the underlying sequence is still one flat list, not
 * a 2-D grid; there is no meaningful "row above" to route Up/Down to.
 * Home/End jump to the first/last item. Movement wraps (End + Right goes
 * to the first item) — the common choice for this pattern.
 */
export function useRovingToolbarFocus(itemCount: number) {
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Render-time clamp, not a second render: guards a stale index if the
  // button set shrinks (e.g. `isBlockedUser` flips mid-session and removes
  // the Image / Insert-images buttons) after a later button was active.
  const safeActiveIndex = itemCount === 0 ? 0 : Math.min(activeIndex, itemCount - 1);

  const moveFocus = (nextIndex: number) => {
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  const getItemProps = (index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      itemRefs.current[index] = el;
    },
    tabIndex: index === safeActiveIndex ? 0 : -1,
    onFocus: () => setActiveIndex(index),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      let nextIndex: number | null = null;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (index + 1) % itemCount;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (index - 1 + itemCount) % itemCount;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = itemCount - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      moveFocus(nextIndex);
    }
  });

  return { getItemProps };
}
