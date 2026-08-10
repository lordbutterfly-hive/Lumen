'use client';

import { useTranslation } from '@/blog/i18n/client';
import DialogLogin from '@/blog/components/dialog-login';

interface WitnessesStatsBarProps {
  hpAprPercent: number | null;
  hbdInterestRatePercent: number | null;
  witnessCount: number;
  /** Unfiltered total, so the bar can say "X of Y" when a filter is on. */
  totalWitnessCount: number;
  /** null while the viewer's own votes are loading or unavailable — rendered as '—', never a false 30. */
  votesLeft: number | null;
  isLoggedIn: boolean;
  hasProxy: boolean;
  proxyAccount: string;
}

/**
 * ★ A DASH IS NOT A LOADING STATE (2026-08-10, fuckery list W-6). Three of these
 * stats rendered a bare em-dash while their chain call was in flight, so every cold
 * load of this page showed "HP staking APR —" for a second or two. That breaks the
 * no-dashes rule in the one place it is guaranteed to be seen, and it reads as "this
 * value is unavailable" rather than "this value is coming". A short skeleton bar says
 * "loading" without asserting anything.
 */
function StatSkeleton() {
  return <span className="inline-block h-[13px] w-[46px] animate-pulse rounded bg-[#ececec] align-middle" aria-hidden="true" />;
}

const STAT_VALUE_CLASS = 'font-sans tabular-nums';

/**
 * Real, chain-derived stats: current HP staking APR and HBD savings rate
 * (`chain.calculateHpApr` / dynamic_global_properties.hbd_interest_rate —
 * both network-wide figures, not per-witness), how many witnesses are
 * being shown, and how many of the viewer's 30 witness votes remain.
 *
 * The design handoff's mock stats (block reward / total daily / avg
 * top-20) require Hive's inflation-schedule constants, which aren't
 * exposed through any API this app calls — showing them would mean
 * inventing a formula with no source to verify it against, so this bar
 * surfaces the real numbers the chain actually gives us instead.
 */
export default function WitnessesStatsBar({
  hpAprPercent,
  hbdInterestRatePercent,
  witnessCount,
  totalWitnessCount,
  votesLeft,
  isLoggedIn,
  hasProxy,
  proxyAccount
}: WitnessesStatsBarProps) {
  const { t } = useTranslation('common_blog');

  return (
    <div
      className="my-5 flex flex-wrap items-center gap-[26px] rounded-2xl border border-[#ebebeb] bg-[#fbfbfa] px-[22px] py-4 font-sans text-[13.5px] text-[#6b7280]"
      data-testid="witnesses-stats-bar"
    >
      <span>
        {t('witnesses.stats.hp_apr')}{' '}
        <strong className={`${STAT_VALUE_CLASS} text-[#2f7d4f]`}>
          {hpAprPercent !== null ? `${hpAprPercent.toFixed(2)}%` : <StatSkeleton />}
        </strong>
      </span>
      <span>
        {t('witnesses.stats.hbd_rate')}{' '}
        <strong className={`${STAT_VALUE_CLASS} text-[#161511]`}>
          {hbdInterestRatePercent !== null ? `${hbdInterestRatePercent.toFixed(2)}%` : <StatSkeleton />}
        </strong>
      </span>
      <span>
        {t('witnesses.stats.witness_count')}{' '}
        <strong className={`${STAT_VALUE_CLASS} text-[#161511]`}>
          {!totalWitnessCount ? (
            <StatSkeleton />
          ) : witnessCount === totalWitnessCount ? (
            witnessCount
          ) : (
            `${witnessCount} of ${totalWitnessCount}`
          )}
        </strong>
      </span>

      {!isLoggedIn ? (
        <DialogLogin>
          <button type="button" className="ml-auto font-semibold text-[#c0392b] hover:text-[#96271b]">
            {t('witnesses.stats.log_in_to_vote')}
          </button>
        </DialogLogin>
      ) : hasProxy ? (
        <span className="ml-auto font-semibold text-[#c0392b]" data-testid="witnesses-stats-proxy-active">
          {t('witnesses.stats.proxy_active', { proxy: proxyAccount })}
        </span>
      ) : votesLeft !== null ? (
        <span className="ml-auto font-semibold text-[#c0392b]" data-testid="witnesses-stats-votes-left">
          {t('witnesses.stats.votes_left', { count: votesLeft })}
        </span>
      ) : (
        <span
          className={`ml-auto font-semibold text-[#9ca3af] ${STAT_VALUE_CLASS}`}
          data-testid="witnesses-stats-votes-left-unavailable"
        >
          <StatSkeleton />
        </span>
      )}
    </div>
  );
}
