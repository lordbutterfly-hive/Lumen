'use client';

import { Link, LumenLoader } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { useMarket } from './use-market';
import BucketBars from './bucket-bars';
import MarketStatusChip from './market-status-chip';
import Countdown from './countdown';

/**
 * Right-rail summary of the current market (read-only). Renders INSIDE the
 * right-rail's card wrapper (border/padding/shadow live there), so this is just
 * the card's inner content. "View market" switches the center feed to the
 * Prediction Market tab via ?tab=predictions. Decorative — fails silent
 * (returns null) rather than showing an error block.
 */
export default function MarketWidget() {
  const { t } = useTranslation('common_blog');
  const { round, isLoading, isError, isUnavailable } = useMarket();

  // Honest, non-conflated states. The market being unprovisioned is a real,
  // showable fact — say so rather than pulling from a fabricated mock round.
  if (isUnavailable) {
    return (
      <div className="font-sans text-[#161511]" data-testid="right-rail-prediction-market">
        <h3 className="mb-2.5 flex items-center gap-2 text-[14.5px] font-bold text-[#161511]">
          <Icons.marketChart className="h-[19px] w-[19px] text-[#c0392b]" />
          {t('prediction_market.heading')}
        </h3>
        <p className="font-sans text-[12.5px] text-[#6b7280]">{t('prediction_market.unavailable_widget')}</p>
      </div>
    );
  }
  // Transient read error and "no active round" are DISTINCT: this decorative
  // widget only advertises a live market, so it stays silent for both rather
  // than ever claiming "no market" on what is really a load error.
  if (isError) return null;
  if (!isLoading && !round) return null;

  return (
    <div className="font-sans text-[#161511]" data-testid="right-rail-prediction-market">
      <div className="mb-3.5 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[14.5px] font-bold text-[#161511]">
          <Icons.marketChart className="h-[19px] w-[19px] text-[#c0392b]" />
          {t('prediction_market.heading')}
        </h3>
        {round && <MarketStatusChip status={round.status} variant="bare" />}
      </div>

      {isLoading || !round ? (
        <LumenLoader size="sm" className="min-h-[112px]" label={t('global.loading')} />
      ) : (
        <>
          <Link
            href="/?tab=predictions"
            className="font-sans text-[17px] font-semibold leading-[1.3] text-[#161511] hover:underline"
          >
            {round.question}
          </Link>
          <div className="mb-3.5 mt-1.5 font-sans text-[12.5px] text-[#6b7280]">
            {t('prediction_market.ref')} ${round.referencePrice.toFixed(3)} · {t('prediction_market.locks_in')}{' '}
            <Countdown closesAt={round.closesAt} className="tabular-nums" />
          </div>

          <BucketBars buckets={round.buckets} size="compact" />

          <div className="mt-3.5 flex items-center justify-between border-t border-[#f0f0f0] pt-3.5 font-sans text-[12.5px] text-[#6b7280]">
            <span>
              <strong className="font-semibold tabular-nums text-[#2a2822]">{round.totalPool.toFixed(0)}</strong> {round.asset}{' '}
              {t('prediction_market.pool').toLowerCase()}
            </span>
            <Link
              href="/?tab=predictions"
              className="inline-flex items-center gap-0.5 font-sans text-[12.5px] font-semibold text-[#c0392b] hover:underline"
            >
              {t('prediction_market.view_market')}
              <Icons.chevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
