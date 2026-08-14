import SuggestionsList from '@/blog/features/suggestions-posts/list';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles } from 'lucide-react';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';

/**
 * How many suggestions the RAIL shows. The full set still renders below the
 * article at narrow widths (`content.tsx`, the `xl:hidden` block), so this is a
 * cap on the rail, not on the data.
 *
 * ★ WHY THERE IS A CAP AT ALL (audit §6.3.4). The panel used to render every
 * suggestion Hivesense returned — measured `scrollHeight 1976` inside a 687px
 * box — which is the reason it needed an inner scroller in the first place. The
 * scroller was the symptom; the length was the cause. Five is what fits the
 * pinned column beside the existing rail cards without anything landing below
 * the fold: the column pins at `top-24` (96px), so at the audit's 855px viewport
 * it has 759px of reachable height, of which `TodayCard` + `Topics` already
 * occupy 441px.
 */
const RAIL_LIMIT = 5;

const AnimatedList = ({ suggestions }: { suggestions: Entry[] }) => {
  const { user } = useUserClient();
  const [showSuggestions, storeShowSuggestions] = useStorageWithTTL<boolean>(
    `showSuggestions${user.username ? `-${user.username}` : ''}`,
    true,
    StorageTTL.PERMANENT
  );

  /**
   * ★★★ NO STICKY, NO SCROLLER, NO MAX-HEIGHT IN HERE (2026-08-13, audit §6.3).
   *
   * What this element used to be:
   *   `bg-background-secondary md:sticky md:top-24 md:flex md:max-h-[calc(100vh-96px)] md:flex-col`
   * wrapping `<div class="min-h-0 overflow-y-auto">`.
   *
   * All three are gone, and none of them may come back:
   *   · `md:sticky md:top-24` was a SECOND sticky at the SAME offset as the
   *     column that already contains it. Two stickies pinned to the same line
   *     cannot move relative to each other, so it bought no behaviour — it only
   *     established a second scroll context.
   *   · `md:max-h-[calc(100vh-96px)]` (measured: 759px) is what forced the
   *     overflow, because the content was 1976px tall.
   *   · `overflow-y-auto` + the browser default `overscroll-behavior: auto`
   *     chained the wheel to the document the instant the inner box bottomed
   *     out. That chaining IS the "scrolling that part and scrolling the page"
   *     report — the page lurched the moment the panel ran out.
   *
   * Sticky is now applied exactly ONCE, on the right column wrapper in
   * `features/layouts/page-shell.tsx`. The page is the only scroller.
   *
   * The card chrome is the house rail card (white / #ebebeb hairline / 18px /
   * one-pixel lift), the same string `right-rail.tsx` and
   * `account-settings/lib/card.ts` use — the panel's new neighbours are cards,
   * and a bare block between two of them reads as a rendering failure.
   */
  return (
    <div className="font-sans">
      <AnimatePresence mode="wait" initial={false}>
        {showSuggestions ? (
          <motion.div
            key="expanded"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="rounded-[18px] border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-serif text-[18px] font-semibold leading-[28px] text-ink-2">
                You Might Also Like
              </h2>
              <button
                type="button"
                onClick={() => storeShowSuggestions(false)}
                aria-label="Hide suggestions"
                className="-mr-1.5 -mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-ink-14 transition-colors hover:bg-surface-21 hover:text-ink-7"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <SuggestionsList suggestions={suggestions} variant="rail" limit={RAIL_LIMIT} />
          </motion.div>
        ) : (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <button
              type="button"
              onClick={() => storeShowSuggestions(true)}
              className="flex items-center gap-2 rounded-full border border-line-9 bg-surface-1 px-3 py-1.5 text-[13px] leading-[20px] text-ink-10 transition-all hover:border-line-brand-10 hover:text-ink-brand-6"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Suggestions
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default AnimatedList;
