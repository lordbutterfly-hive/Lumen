'use client';

import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import { cn } from '@ui/lib/utils';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useMarket } from './use-market';
import BucketBars from './bucket-bars';
import BetForm from './bet-form';
import PriceChart, { type ChartSeries } from './price-chart';
import MarketStatusChip from './market-status-chip';
import Countdown from './countdown';
import { buildOutcomeColorMap } from './outcome-colors';

// Maps the contract's void-reason codes to the matching translation key. Each
// branch below calls the translation function with a literal key string so the
// translation-usage checker can see it — no dynamically-built key names.
function voidReasonText(t: TFunction<'common_blog', undefined>, reason: string | undefined): string {
  switch (reason) {
    case 'underfunded':
      return t('prediction_market.void_reason.underfunded');
    case 'zero_winner':
      return t('prediction_market.void_reason.zero_winner');
    case 'window_lapsed':
      return t('prediction_market.void_reason.window_lapsed');
    case 'stale_feed':
      return t('prediction_market.void_reason.stale_feed');
    case 'tick_window_missed':
      return t('prediction_market.void_reason.tick_window_missed');
    default:
      return t('prediction_market.void_reason.default');
  }
}

const CHART_POINTS = 8; // width of the flat placeholder series

// The "Prediction Market" center tab — a Coinbase-style single-market view over
// the parimutuel pool data layer. Pool framing only: no contracts, no fixed
// odds, no open-interest / 24h-vol.
export default function MarketTab() {
  const { t } = useTranslation('common_blog');
  const {
    round,
    isUnavailable,
    isLoading,
    isError,
    refetch,
    myPosition,
    poolSeries,
    claim,
    isClaiming,
    reclaim,
    isReclaiming,
    isLite
  } = useMarket();

  const onReclaim = async () => {
    if (!round) return;
    try {
      await reclaim();
    } catch (error) {
      handleError(error, { method: 'predictionMarketReclaim', params: { roundId: round.roundId } });
    }
  };

  const onClaim = async () => {
    if (!round) return;
    try {
      await claim();
    } catch (error) {
      handleError(error, { method: 'predictionMarketClaim', params: { roundId: round.roundId } });
    }
  };

  const colors = useMemo(() => (round ? buildOutcomeColorMap(round.buckets) : {}), [round]);

  // Real history when the indexer has it, the flat placeholder when it does not.
  // `poolSeries` is null for an unconfigured or unreachable indexer AND for a
  // round with fewer than two blocks of bets — in every one of those cases we
  // have no evidence about how the odds moved, so the chart says so rather than
  // drawing a line. `isPlaceholder` is what makes it say so.
  const isPlaceholder = poolSeries === null;
  const series: ChartSeries[] = useMemo(() => {
    if (!round) return [];
    return round.buckets.map((bucket, i) => {
      const points = poolSeries?.[i];
      const hasHistory = Array.isArray(points) && points.length > 1;
      return {
        label: bucket.label,
        color: colors[bucket.id],
        points: hasHistory ? points : Array<number>(CHART_POINTS).fill(bucket.oddsPct),
        // The endpoint dot always shows the LIVE share from chain state, not the
        // indexed tail: the index lags the chain, and the dot sits next to the
        // live percentages in the bucket list. They must not disagree.
        end: bucket.oddsPct
      };
    });
  }, [round, colors, poolSeries]);

  // Honest, non-conflated failure states. Order matters: an unprovisioned market
  // is neither "loading" nor "no round"; a read error is not "no round open".
  if (isUnavailable) {
    return <p className="py-16 text-center font-sans text-sm text-[#6b7280]">{t('prediction_market.unavailable')}</p>;
  }
  if (isLoading) {
    return (
      <div className="py-16">
        <div className="mx-auto h-64 w-full max-w-3xl animate-pulse rounded-[20px] bg-[#f1f3f5]" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-16 text-center">
        <p className="font-sans text-sm text-[#6b7280]">{t('prediction_market.load_error')}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 rounded-[12px] border border-[#e2e4e7] bg-white px-4 py-2 font-sans text-sm font-semibold text-[#161511] transition-colors hover:border-[#161511]"
        >
          {t('prediction_market.retry')}
        </button>
      </div>
    );
  }
  if (!round) {
    return <p className="py-16 text-center font-sans text-sm text-[#6b7280]">{t('prediction_market.no_round')}</p>;
  }

  const isResolved = round.status === 'settled' || round.status === 'void';
  const hasPosition = Boolean(myPosition && myPosition.totalStaked > 0);
  const closesDate = new Date(round.closesAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="pt-6 font-sans text-[#161511]">
      <div className="overflow-hidden rounded-[20px] border border-[#ebebeb] bg-white shadow-[0_1px_3px_rgba(20,18,10,0.04)]">
        {/* Header */}
        <div className="border-b border-[#f0f0f0] px-7 pb-5 pt-[22px]">
          <div className="flex items-start justify-between gap-4">
            <h1 className="font-sans text-[30px] font-semibold leading-tight tracking-[-0.02em] text-[#161511]">
              {round.question}
            </h1>
            <MarketStatusChip status={round.status} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-[22px] gap-y-1 font-sans text-[13.5px] text-[#6b7280]">
            <span>
              <strong className="font-semibold text-[#2a2822]">{t('prediction_market.ref')}</strong> ${round.referencePrice.toFixed(3)}
            </span>
            <span>
              <strong className="font-semibold text-[#2a2822]">{t('prediction_market.pool')}</strong>{' '}
              <span className="tabular-nums">{round.totalPool.toFixed(0)}</span> {round.asset}
            </span>
            {/* Omitted entirely when unknown (no indexer, or it is unreachable).
                Rendering 0 there would assert that nobody has bet. */}
            {round.bettors !== null && (
              <span>
                <strong className="font-semibold tabular-nums text-[#2a2822]">{round.bettors}</strong>{' '}
                {t('prediction_market.bettors')}
              </span>
            )}
            {round.status === 'open' && (
              <span>
                <strong className="font-semibold text-[#2a2822]">{t('prediction_market.locks')}</strong>{' '}
                <Countdown closesAt={round.closesAt} className="tabular-nums" />
              </span>
            )}
          </div>
        </div>

        {/* Body: bet panel (left) + odds chart (right) */}
        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr]">
          <div className="p-[26px] md:border-r md:border-[#f0f0f0]">
            {round.status === 'open' ? (
              <BetForm round={round} />
            ) : round.status === 'locked' ? (
              <p className="font-sans text-sm text-[#6b7280]">{t('prediction_market.locked')}</p>
            ) : (
              <p className="font-sans text-sm text-[#161511]">
                {round.status === 'void'
                  ? t('prediction_market.round_voided', { reason: voidReasonText(t, round.voidReason) })
                  : t('prediction_market.settled_at', { price: round.settlementPrice ?? '', asset: round.asset })}
              </p>
            )}
          </div>

          <div className="p-[26px] md:px-7">
            {/* Legend */}
            <div className="mb-[18px] flex flex-wrap gap-x-[18px] gap-y-2">
              {round.buckets.map((bucket) => (
                <div key={bucket.id} className="flex items-center gap-2">
                  <span className="h-[9px] w-[9px] rounded-full" style={{ backgroundColor: colors[bucket.id] }} aria-hidden="true" />
                  <span className="font-sans text-[13.5px] font-medium text-[#3f4650]">{bucket.label}</span>
                  <span className="font-sans text-[13.5px] font-bold tabular-nums text-[#161511]">{bucket.oddsPct}¢</span>
                </div>
              ))}
            </div>

            <PriceChart series={series} placeholder={isPlaceholder} />

            {/* Pool odds ladder */}
            <div className="mt-[26px] border-t border-[#f0f0f0] pt-[22px]">
              <div className="mb-3.5 font-sans text-[12.5px] font-bold uppercase tracking-[0.05em] text-[#6b7280]">
                {t('prediction_market.pool_odds')}
              </div>
              <BucketBars buckets={round.buckets} size="full" />
            </div>
          </div>
        </div>

        {/* Pool-safe key stats (no open-interest / 24h-vol) */}
        <div className="grid grid-cols-2 border-t border-[#f0f0f0] sm:grid-cols-4">
          <KeyStat label={t('prediction_market.pool')} value={`${round.totalPool.toFixed(0)} ${round.asset}`} />
          {/* An em dash, not 0 — this stat holds a slot in the grid, so it says
              "unknown" rather than disappearing. String(null) would print "null". */}
          <KeyStat
            label={t('prediction_market.bettors')}
            value={round.bettors === null ? '—' : String(round.bettors)}
          />
          <KeyStat label={t('prediction_market.ref')} value={`$${round.referencePrice.toFixed(3)}`} />
          <KeyStat label={t('prediction_market.closes')} value={closesDate} last />
        </div>
      </div>

      {hasPosition && myPosition && (
        <div className="mt-5 rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
          <h3 className="mb-3 font-sans text-sm font-semibold text-[#161511]">{t('prediction_market.my_position')}</h3>
          <ul className="space-y-1 font-sans text-sm">
            {round.buckets
              .filter((bucket) => (myPosition.stakeByBucket[bucket.id] ?? 0) > 0)
              .map((bucket) => (
                <li key={bucket.id} className="flex justify-between">
                  <span className="text-[#6b7280]">{bucket.label}</span>
                  <span className="tabular-nums text-[#161511]">
                    {(myPosition.stakeByBucket[bucket.id] ?? 0).toFixed(3)} {round.asset}
                  </span>
                </li>
              ))}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-[#f0f0f0] pt-2 font-sans text-sm">
            <span className="text-[#6b7280]">{t('prediction_market.total_staked')}</span>
            <span className="font-semibold tabular-nums text-[#161511]">
              {myPosition.totalStaked.toFixed(3)} {round.asset}
            </span>
          </div>
          {isResolved &&
            (myPosition.claimed ? (
              <p className="mt-3 text-center font-sans text-sm text-[#6b7280]">{t('prediction_market.claimed')}</p>
            ) : myPosition.claimable ? (
              <button
                type="button"
                onClick={() => void onClaim()}
                disabled={isClaiming || isLite}
                title={isLite ? t('prediction_market.upgrade_to_claim') : undefined}
                className="mt-3 w-full rounded-[14px] bg-[#1a1a17] py-3 font-sans text-sm font-semibold text-white transition-colors hover:bg-black disabled:opacity-50"
              >
                {isLite ? t('prediction_market.upgrade_to_claim') : t('prediction_market.claim')}
              </button>
            ) : (
              // F-P9: a SETTLED round where this position won nothing has no payout —
              // the contract would reject a Claim. Show that instead of a live button
              // whose only outcome is a confusing on-chain failure.
              <p className="mt-3 text-center font-sans text-sm text-[#6b7280]">{t('prediction_market.no_payout')}</p>
            ))}
          {/* ★ THE FAIL-SAFE, previously unreachable from the app. A round stuck
              past its deadline never resolves on its own: `reclaim` lets any
              staker void it and take their own stake back, needing no oracle,
              keeper or owner. It existed on chain and had no button, so a bettor
              in a dead round had no in-app way to get their money. Shown only
              when the position itself says the deadline has passed. */}
          {!isResolved && myPosition.reclaimable && (
            <div className="mt-3 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] p-3">
              <p className="font-sans text-[13px] leading-[1.5] text-[#b45309]">
                {t('prediction_market.reclaim_explain')}
              </p>
              <button
                type="button"
                onClick={() => void onReclaim()}
                disabled={isReclaiming || isLite}
                title={isLite ? t('prediction_market.upgrade_to_reclaim') : undefined}
                className="mt-2.5 w-full rounded-[12px] bg-[#b45309] py-2.5 font-sans text-sm font-semibold text-white transition-colors hover:bg-[#92400e] disabled:opacity-50"
              >
                {isLite ? t('prediction_market.upgrade_to_reclaim') : t('prediction_market.reclaim')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeyStat({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={cn('px-6 py-[18px]', !last && 'border-r border-[#f0f0f0]')}>
      <div className="mb-1.5 font-sans text-[11.5px] font-bold uppercase tracking-[0.05em] text-[#6b7280]">{label}</div>
      <div className="font-sans text-[19px] font-bold tabular-nums text-[#161511]">{value}</div>
    </div>
  );
}
