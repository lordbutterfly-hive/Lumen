'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useTranslation } from '@/blog/i18n/client';
import WitnessTableRow from './witness-table-row';
import {
  GENERAL_GRID_TEMPLATE,
  GENERAL_MIN_WIDTH_CLASS,
  STICKY_IDENTITY_HEADER_CLASS,
  STICKY_RANK_CLASS
} from './lib/table-grid';
import { WitnessRow } from './lib/types';
import { LumenLoader } from '@hive/ui';

interface WitnessesTableProps {
  rows: WitnessRow[];
  isLoading: boolean;
  /** True when the witness list failed to load — render an error state, NOT "no results". */
  isError: boolean;
  onRetry: () => void;
  isLoggedIn: boolean;
  hasProxy: boolean;
  /** The viewer's own votes failed to load — per-row "voted" state is unknown. */
  ownVotesUnavailable: boolean;
  hpAprPercent: number | null;
}

/**
 * ★★★ 250 ROWS IN ONE PAINT FROZE THE RENDERER (2026-08-10, fuckery list P0-5).
 *
 * Every witness rendered at once, each row a CSS grid with two sticky columns, an
 * avatar, a tooltip provider and a vote toggle. Measured: the page took 19s to serve
 * and the renderer stopped responding for 45s+, with navigation silently failing to
 * commit. The audit called for virtualisation.
 *
 * This renders INCREMENTALLY instead, and the distinction matters. True windowing
 * (absolute positioning inside a fixed-height scroller) is what react-window would
 * give us, and it would fight two things this table depends on: the sticky rank and
 * identity columns, which need normal flow to stick, and the horizontal scroll the
 * narrow layouts rely on. It would also mean a new dependency for one page.
 *
 * A first page of 60 rows cuts the initial DOM by ~76% and removes the freeze, and
 * the sentinel below extends it as the reader scrolls. Nobody scrolls 250 witnesses
 * without meaning to, and anyone who does gets them.
 */
const FIRST_PAGE = 60;
const PAGE_STEP = 60;

const HEADER_CLASS =
  'grid items-center gap-3 px-3.5 py-3 font-sans text-[12px] leading-[18px] font-bold uppercase tracking-[0.04em] text-ink-14';

export default function WitnessesTable({
  rows,
  isLoading,
  isError,
  onRetry,
  isLoggedIn,
  hasProxy,
  ownVotesUnavailable,
  hpAprPercent
}: WitnessesTableProps) {
  const { t } = useTranslation('common_blog');
  const [visibleCount, setVisibleCount] = useState(FIRST_PAGE);
  const { ref: moreRef, inView: moreInView } = useInView();

  // Any change to the row SET (a filter toggle or a search) starts the
  // window again. Without this, filtering down to 12 rows would leave the previous
  // scroll-extended count in place and the next filter would paint everything.
  const rowsKey = `${rows.length}:${rows[0]?.id ?? ''}`;
  useEffect(() => {
    setVisibleCount(FIRST_PAGE);
  }, [rowsKey]);

  /**
   * ★★★ STUCK AT 120/250 (2026-08-12). `IntersectionObserver` only calls back on a
   * threshold CROSSING, not on every frame the sentinel happens to still be inside
   * the viewport. Scrolling straight to the bottom crosses the threshold exactly
   * once (`moreInView` false -> true); this effect added one page (60 -> 120); and
   * if the sentinel was still on screen after that page rendered — no NEW crossing
   * — the observer never called back again, so this effect (keyed only on the
   * boolean) had nothing left to re-run on. Pagination stalled with more rows
   * available and the sentinel still visible. Scrolling away and back created a
   * fresh crossing, which is why that "unstuck" it — a level check disguised as an
   * edge-triggered fix.
   *
   * Adding `visibleCount` re-arms the check on every page load: each time it
   * changes, this effect re-runs and re-reads the LATEST `moreInView`, so a
   * sentinel that is still visible keeps advancing without waiting for a new scroll
   * event.
   *   - Can't runaway on a short list whose sentinel never leaves the viewport: the
   *     functional updater's `n >= rows.length` guard caps `visibleCount` at the
   *     full list, and once it stops changing React bails the state update
   *     (`Object.is` same value), so the effect has nothing left to re-run on — the
   *     list just finishes loading immediately instead of looping.
   *   - Can't fire mid-fetch or past the last page: there is no fetch here. `rows`
   *     arrives once from `useWitnessesData`'s single `useQuery` (see
   *     `hooks/use-witnesses-data.ts`) and this only slices it locally, so there is
   *     no in-flight request to race and no `hasNextPage` to overrun beyond the
   *     same `n >= rows.length` guard.
   *   - Can't double-fire meaningfully under React 18 StrictMode's dev-only mount
   *     double-invoke: `moreInView` is false on mount in the normal case (60 rows
   *     exceed the initial viewport), so both invocations are no-ops. Even in the
   *     edge case where the sentinel is already in view at mount, both invocations
   *     go through the same `n >= rows.length` guard on a local array slice — at
   *     most one extra page reveals a render early, in dev only, never a runaway.
   */
  useEffect(() => {
    if (moreInView) setVisibleCount((n) => (n >= rows.length ? n : n + PAGE_STEP));
  }, [moreInView, rows.length, visibleCount]);

  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const gridTemplate = GENERAL_GRID_TEMPLATE;
  const minWidthClass = GENERAL_MIN_WIDTH_CLASS;
  // Below lg the table scrolls inside itself, and a touch device shows no
  // scrollbar until you are already scrolling — so nothing on the page said the
  // remaining columns existed. One line, only where it is true, only when there
  // is actually a table to scroll.
  const showScrollHint = !isLoading && !isError && rows.length > 0;

  return (
    <>
      {showScrollHint ? (
        <p
          className="mb-1 px-3.5 font-sans text-[12px] text-ink-14 lg:hidden"
          data-testid="witnesses-scroll-hint"
        >
          {t('witnesses.scroll_hint')}
        </p>
      ) : null}
      {/* ★ THE WHOLE PAGE USED TO SCROLL SIDEWAYS (2026-08-08). Measured at
          390px: document.documentElement.scrollWidth = 642 against a 390
          viewport, because this table's fixed columns (632px before the witness
          column gets anything) overflowed every ancestor, all of which were
          overflow-visible. The PAGE scrolled, not the table — so the heading,
          the intro and the stats card slid away too, and the witness name went
          with them, leaving a Price and an APR belonging to nobody. Same at
          820px (906 against 820).

          The scroller lives here, one element outside the rows, so the overflow
          is contained and the identifying columns can pin to its left edge.

          ★ RELEASED AT `2xl`, NOT `lg` (2026-08-11 fix). This scroller and
          `GENERAL_MIN_WIDTH_CLASS` in `table-grid.tsx` are one mechanism split
          across two files and MUST release at the same breakpoint — that file's
          comment has the arithmetic for why `2xl` is the first point the shell
          (with its `xl` right rail) actually has room. Releasing this one earlier
          than the min-width floor removes the fallback scrollbar while the floor
          is still forcing an 820px-wide row, which is exactly the "whole page
          scrolled sideways" bug above, just triggered from the other side. */}
      <div className="overflow-x-auto 2xl:overflow-visible" data-testid="witnesses-table">
        <div className={minWidthClass}>
          <div className={HEADER_CLASS} style={{ gridTemplateColumns: gridTemplate }} role="row">
            <span className={STICKY_RANK_CLASS}>{t('witnesses.columns.rank')}</span>
            <span className={STICKY_IDENTITY_HEADER_CLASS}>{t('witnesses.columns.witness')}</span>
              <>
                <span className="text-right">{t('witnesses.columns.votes')}</span>
                <span className="text-right">{t('witnesses.columns.last_block')}</span>
                <span className="text-right">{t('witnesses.columns.miss')}</span>
                <span className="text-right">{t('witnesses.columns.price')}</span>
                <span className="text-right">{t('witnesses.columns.apr')}</span>
              </>
            <span className="text-center">{t('witnesses.columns.vote')}</span>
          </div>

          <div className="flex flex-col">
            {isLoading ? (
              <div
                className="px-3.5 py-6"
                data-testid="witnesses-loading"
              >
                {/* X-4: one loading language. The home feed used skeleton blocks, this
                    page a bare centred word, the stats bar em-dashes. All three now
                    speak the same language — which as of 2026-08-12 is `LumenLoader`
                    for a region of content and the warm sweep for a single value. */}
                <LumenLoader size="md" label={t('global.loading')} />
              </div>
            ) : isError ? (
              <div
                className="flex flex-col items-center gap-3 px-3.5 py-12 text-center"
                data-testid="witnesses-error"
                role="alert"
              >
                <p className="font-sans text-sm font-semibold text-destructive">
                  {t('global.something_went_wrong')}
                </p>
                <p className="font-sans text-[13px] leading-[20px] text-ink-10">{t('witnesses.error.description')}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-[10px] border border-line-11 bg-surface-1 px-4 py-2 font-sans text-[13px] leading-[20px] font-semibold text-ink-7 transition-colors hover:bg-surface-16"
                >
                  {t('witnesses.error.retry')}
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div
                className="px-3.5 py-10 text-center font-sans text-sm text-ink-14"
                data-testid="witnesses-empty"
              >
                {t('witnesses.no_results')}
              </div>
            ) : (
              visibleRows.map((row) => (
                <WitnessTableRow
                  key={row.id}
                  row={row}
                  isLoggedIn={isLoggedIn}
                  hasProxy={hasProxy}
                  ownVotesUnavailable={ownVotesUnavailable}
                  hpAprPercent={hpAprPercent}
                />
              ))
            )}
            {/* Scroll sentinel. Renders only while rows remain, so it cannot spin at
                the bottom of a fully-rendered table. */}
            {visibleRows.length < rows.length ? (
              <div ref={moreRef} className="py-6 text-center font-sans text-[13px] leading-[20px] text-ink-14" data-testid="witnesses-more">
                {t('witnesses.showing_count', { shown: visibleRows.length, total: rows.length })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
