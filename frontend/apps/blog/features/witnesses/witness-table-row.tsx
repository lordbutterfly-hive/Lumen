import { Link } from '@hive/ui';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import WitnessIdentityCell from './witness-identity-cell';
import WitnessVoteToggle from './witness-vote-toggle';
import {
  GENERAL_GRID_TEMPLATE,
  STICKY_IDENTITY_CLASS,
  STICKY_RANK_CLASS
} from './lib/table-grid';
import { WitnessRow } from './lib/types';
import {
  formatBlockAge,
  formatHpVotes,
  formatInteger,
  formatNaiAsset,
  formatPriceFeed
} from './lib/witness-format';

interface WitnessTableRowProps {
  row: WitnessRow;
  isLoggedIn: boolean;
  hasProxy: boolean;
  /** The viewer's own votes failed to load — render the toggle indeterminate, not a confident "not voted". */
  ownVotesUnavailable: boolean;
  hpAprPercent: number | null;
}

const CELL_NUM_CLASS = 'text-right font-sans text-[12.5px] tabular-nums text-[#6b7280]';

/**
 * ★★★ THE APR COLUMN WAS THE SAME NUMBER 250 TIMES (2026-08-10, fuckery list W-1).
 *
 * It rendered `hpAprPercent`, the CHAIN-GLOBAL HP staking APR, which is handed to
 * every row identically. Measured on the live page: "5.10%" appeared 251 times, once
 * in the stats bar and once per row, with exactly one distinct value across 250
 * witnesses. A column that cannot vary carries no information, and it was duplicating
 * a figure the stats bar already showed two inches above it.
 *
 * Worse, it was painted in success-green `#2f7d4f`, so witnesses whose last block was
 * 263, 801 and 985 days ago advertised a healthy green APR (W-3). That is not a
 * cosmetic problem, it is the table asserting something false about a dead witness.
 *
 * What belongs here is each witness's OWN `props.hbd_interest_rate`: the HBD savings
 * rate that witness votes for. Verified against the chain, it genuinely varies (gtg
 * 1000, ocd-witness 1200, stoodkev 1000, in basis points), and the network applies the
 * MEDIAN of the top 20, which is where the stats bar's own figure comes from. So the
 * column and the stats bar stop being redundant and start being related.
 *
 * The green is gone. A published parameter is a fact, not an achievement, so it reads
 * in the same neutral numeric colour as every other cell.
 */
const STALE_BLOCK_AGE_SECONDS = 7 * 24 * 60 * 60;

function hbdAprPercent(row: WitnessRow): number | null {
  const raw = row.props?.hbd_interest_rate;
  return typeof raw === 'number' ? raw / 100 : null;
}

/**
 * A witness that has not produced a block in a week is not signing, and whatever rate
 * it last published is a historical artefact rather than a live vote. Say that instead
 * of printing a number that looks current (W-3).
 */
function renderHbdApr(row: WitnessRow, t: (key: string) => string): string {
  if (row.blockAgeSeconds !== null && row.blockAgeSeconds > STALE_BLOCK_AGE_SECONDS) {
    return t('witnesses.apr_stale');
  }
  const pct = hbdAprPercent(row);
  return pct === null ? t('witnesses.apr_stale') : `${pct.toFixed(2)}%`;
}

export default function WitnessTableRow({
  row,
  isLoggedIn,
  hasProxy,
  ownVotesUnavailable,
  hpAprPercent
}: WitnessTableRowProps) {
  const { t } = useTranslation('common_blog');
  const gridTemplate = GENERAL_GRID_TEMPLATE;

  return (
    <div
      // `group` so the two pinned cells, which need their own opaque background
      // to hide the columns scrolling underneath them, can still follow the
      // row's hover tint instead of staying flat while the rest of the row lifts.
      className="group grid items-center gap-3 border-t border-[#f1f3f5] px-3.5 py-3.5 hover:bg-[#faf9f6]"
      style={{ gridTemplateColumns: gridTemplate }}
      data-testid="witness-row"
      data-witness={row.owner}
    >
      <span className={STICKY_RANK_CLASS}>
        <span className="font-sans text-[16px] font-bold tabular-nums text-[#9ca3af]">{row.rank}</span>
      </span>

      <WitnessIdentityCell row={row} className={STICKY_IDENTITY_CLASS} />

        <>
          <span className={`${CELL_NUM_CLASS} font-bold text-[#161511]`} data-testid="witness-votes">
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
          {/* ★ W-7: under the stale filter this column showed $0.149, $0.197, $0.183
              and $0.370 against a live feed near $0.041, in the same weight and colour
              as current data. A 985-day-old feed that looks identical to today's is
              worse than no feed. Stale prices are muted and struck, so the number is
              still there to read but never reads as current. */}
          <span
            className={
              row.isStale
                ? 'text-right font-sans text-[12.5px] tabular-nums text-[#c4c4c4] line-through'
                : CELL_NUM_CLASS
            }
            title={row.isStale ? t('witnesses.stale_marker') : undefined}
          >
            {formatPriceFeed(row.priceFeedUsd)}
          </span>
          <TooltipContainer title={t('witnesses.apr_tooltip')}>
            <span className={CELL_NUM_CLASS}>{renderHbdApr(row, t)}</span>
          </TooltipContainer>
        </>
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
