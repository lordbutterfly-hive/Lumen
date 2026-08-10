'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { useTranslation } from '@/blog/i18n/client';
import WitnessTableRow from './witness-table-row';
import {
  GENERAL_GRID_TEMPLATE,
  GENERAL_MIN_WIDTH_CLASS,
  PARAMS_GRID_TEMPLATE,
  PARAMS_MIN_WIDTH_CLASS,
  STICKY_IDENTITY_HEADER_CLASS,
  STICKY_RANK_CLASS
} from './lib/table-grid';
import { WitnessRow, WitnessViewMode } from './lib/types';

interface WitnessesTableProps {
  rows: WitnessRow[];
  viewMode: WitnessViewMode;
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
  'grid items-center gap-3 px-3.5 py-3 font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-[#9ca3af]';

export default function WitnessesTable({
  rows,
  viewMode,
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

  // Any change to the row SET (a filter toggle, a search, a tab switch) starts the
  // window again. Without this, filtering down to 12 rows would leave the previous
  // scroll-extended count in place and the next filter would paint everything.
  const rowsKey = `${viewMode}:${rows.length}:${rows[0]?.id ?? ''}`;
  useEffect(() => {
    setVisibleCount(FIRST_PAGE);
  }, [rowsKey]);

  useEffect(() => {
    if (moreInView) setVisibleCount((n) => (n >= rows.length ? n : n + PAGE_STEP));
  }, [moreInView, rows.length]);

  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const gridTemplate = viewMode === 'general' ? GENERAL_GRID_TEMPLATE : PARAMS_GRID_TEMPLATE;
  const minWidthClass = viewMode === 'general' ? GENERAL_MIN_WIDTH_CLASS : PARAMS_MIN_WIDTH_CLASS;
  // Below lg the table scrolls inside itself, and a touch device shows no
  // scrollbar until you are already scrolling — so nothing on the page said the
  // remaining columns existed. One line, only where it is true, only when there
  // is actually a table to scroll.
  const showScrollHint = !isLoading && !isError && rows.length > 0;

  return (
    <>
      {showScrollHint ? (
        <p
          className="mb-1 px-3.5 font-sans text-[11.5px] text-[#9ca3af] lg:hidden"
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
          is contained and the identifying columns can pin to its left edge. */}
      <div className="overflow-x-auto lg:overflow-visible" data-testid="witnesses-table">
        <div className={minWidthClass}>
          <div className={HEADER_CLASS} style={{ gridTemplateColumns: gridTemplate }} role="row">
            <span className={STICKY_RANK_CLASS}>{t('witnesses.columns.rank')}</span>
            <span className={STICKY_IDENTITY_HEADER_CLASS}>{t('witnesses.columns.witness')}</span>
            {viewMode === 'general' ? (
              <>
                <span className="text-right">{t('witnesses.columns.votes')}</span>
                <span className="text-right">{t('witnesses.columns.last_block')}</span>
                <span className="text-right">{t('witnesses.columns.miss')}</span>
                <span className="text-right">{t('witnesses.columns.price')}</span>
                <span className="text-right">{t('witnesses.columns.apr')}</span>
              </>
            ) : (
              <>
                <span className="text-right">{t('witnesses.columns.creation_fee')}</span>
                <span className="text-right">{t('witnesses.columns.max_block_size')}</span>
                <span className="text-right">{t('witnesses.columns.subsidy_budget')}</span>
                <span className="text-right">{t('witnesses.columns.price')}</span>
                <span className="text-right">{t('witnesses.columns.hbd_apr')}</span>
              </>
            )}
            <span className="text-center">{t('witnesses.columns.vote')}</span>
          </div>

          <div className="flex flex-col">
            {isLoading ? (
              <div
                className="px-3.5 py-6"
                data-testid="witnesses-loading"
              >
                {/* X-4: one loading language. The home feed uses skeleton blocks, this
                    page used a bare centred word, and the stats bar used em-dashes.
                    All three are skeletons now. */}
                <div className="flex flex-col gap-2" aria-label={t('global.loading')} role="status">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-[52px] animate-pulse rounded-[10px] bg-[#f1f3f5]" />
                  ))}
                </div>
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
                <p className="font-sans text-[13px] text-[#6b7280]">{t('witnesses.error.description')}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2 font-sans text-[13px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]"
                >
                  {t('witnesses.error.retry')}
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div
                className="px-3.5 py-10 text-center font-sans text-sm text-[#9ca3af]"
                data-testid="witnesses-empty"
              >
                {t('witnesses.no_results')}
              </div>
            ) : (
              visibleRows.map((row) => (
                <WitnessTableRow
                  key={row.id}
                  row={row}
                  viewMode={viewMode}
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
              <div ref={moreRef} className="py-6 text-center font-sans text-[12.5px] text-[#9ca3af]" data-testid="witnesses-more">
                {t('witnesses.showing_count', { shown: visibleRows.length, total: rows.length })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
