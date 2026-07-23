import { Link } from '@hive/ui';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import WitnessIdentityCell from './witness-identity-cell';
import WitnessVoteToggle from './witness-vote-toggle';
import { GENERAL_GRID_TEMPLATE, PARAMS_GRID_TEMPLATE } from './lib/table-grid';
import { WitnessRow, WitnessViewMode } from './lib/types';
import { formatBlockAge, formatHpVotes, formatInteger, formatNaiAsset, formatPriceFeed } from './lib/witness-format';

interface WitnessTableRowProps {
  row: WitnessRow;
  viewMode: WitnessViewMode;
  isLoggedIn: boolean;
  hasProxy: boolean;
  /** The viewer's own votes failed to load — render the toggle indeterminate, not a confident "not voted". */
  ownVotesUnavailable: boolean;
  hpAprPercent: number | null;
}

const CELL_NUM_CLASS = 'text-right font-sans text-[12.5px] tabular-nums text-[#6b7280]';

export default function WitnessTableRow({
  row,
  viewMode,
  isLoggedIn,
  hasProxy,
  ownVotesUnavailable,
  hpAprPercent
}: WitnessTableRowProps) {
  const { t } = useTranslation('common_blog');
  const gridTemplate = viewMode === 'general' ? GENERAL_GRID_TEMPLATE : PARAMS_GRID_TEMPLATE;

  return (
    <div
      className="grid items-center gap-3 border-t border-[#f1f3f5] px-3.5 py-3.5 hover:bg-[#faf9f6]"
      style={{ gridTemplateColumns: gridTemplate }}
      data-testid="witness-row"
      data-witness={row.owner}
    >
      <span className="font-sans text-[16px] font-bold tabular-nums text-[#9ca3af]">{row.rank}</span>

      <WitnessIdentityCell row={row} />

      {viewMode === 'general' ? (
        <>
          <span className={`${CELL_NUM_CLASS} font-bold text-[#3182ce]`} data-testid="witness-votes">
            {formatHpVotes(row.hpVotes)}
          </span>
          <Link
            href={`https://hiveblocks.com/b/${row.last_confirmed_block_num}`}
            target="_blank"
            rel="noreferrer noopener"
            className={CELL_NUM_CLASS}
            data-testid="witness-last-block"
          >
            {formatBlockAge(row.blockAgeSeconds, t)}
          </Link>
          <span className={CELL_NUM_CLASS}>{formatInteger(row.total_missed)}</span>
          <span className={CELL_NUM_CLASS}>{formatPriceFeed(row.priceFeedUsd)}</span>
          <TooltipContainer title={t('witnesses.apr_tooltip')}>
            <span className="text-right font-sans text-[12.5px] font-semibold tabular-nums text-[#2f7d4f]">
              {hpAprPercent !== null ? `${hpAprPercent.toFixed(2)}%` : '—'}
            </span>
          </TooltipContainer>
        </>
      ) : (
        <>
          <span className={CELL_NUM_CLASS}>{formatNaiAsset(row.props?.account_creation_fee, 'HIVE')}</span>
          <span className={CELL_NUM_CLASS}>{formatInteger(row.props?.maximum_block_size)}</span>
          <span className={CELL_NUM_CLASS}>{formatInteger(row.props?.account_subsidy_budget)}</span>
          <span className={CELL_NUM_CLASS}>{formatPriceFeed(row.priceFeedUsd)}</span>
        </>
      )}

      <div className="flex justify-center">
        <WitnessVoteToggle
          witness={row.owner}
          isVoted={row.isVoted}
          isLoggedIn={isLoggedIn}
          hasProxy={hasProxy}
          votesUnavailable={ownVotesUnavailable}
        />
      </div>
    </div>
  );
}
