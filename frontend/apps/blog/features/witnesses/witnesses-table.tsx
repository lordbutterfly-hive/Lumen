'use client';

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
              </>
            )}
            <span className="text-center">{t('witnesses.columns.vote')}</span>
          </div>

          <div className="flex flex-col">
            {isLoading ? (
              <div
                className="px-3.5 py-10 text-center font-sans text-sm text-[#9ca3af]"
                data-testid="witnesses-loading"
              >
                {t('global.loading')}
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
              rows.map((row) => (
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
          </div>
        </div>
      </div>
    </>
  );
}
