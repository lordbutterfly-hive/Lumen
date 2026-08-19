'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useHiveMarketPrices } from '../hooks/use-hive-market-prices';
import Sparkline from './sparkline';

const CARD_CLASS = 'rounded-panel border border-line-9 bg-surface-1 p-5';

export default function PriceCardHive() {
  const { t } = useTranslation('common_blog');
  const { data, isLoading, isError } = useHiveMarketPrices();

  if (isLoading || isError || !data) {
    return (
      <div className={CARD_CLASS} data-testid="wallet-price-hive">
        <span className="font-sans text-[26px] leading-[40px] font-bold tabular-nums text-ink-2">—</span>
        {/* ★ Loading is not a failure (2026-08-17). Both states show the same dash
            because we genuinely have no price either way — but only a real error
            is allowed to SAY the price is unavailable. */}
        <div className="mt-1.5 text-caption text-ink-10">
          {isLoading ? t('wallet.market.loading') : t('wallet.market.unavailable')}
        </div>
      </div>
    );
  }

  const changePositive = data.hiveUsd24hChange >= 0;

  return (
    <div className={CARD_CLASS} data-testid="wallet-price-hive">
      <div className="flex items-center justify-between">
        <span className="font-sans text-[26px] leading-[40px] font-bold tabular-nums text-ink-2">
          ${data.hiveUsd.toFixed(4)}
        </span>
        <span
          className={`rounded-full px-2.5 py-[3px] text-caption font-bold tabular-nums ${
 changePositive ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-brand-8 text-ink-brand-6'
 }`}
        >
          {changePositive ? '+' : ''}
          {data.hiveUsd24hChange.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 text-caption tabular-nums text-ink-10">
        {t('wallet.market.hive_via', { btc: data.hiveBtc.toFixed(8) })}
      </div>
      <div className="mt-0.5 text-caption text-ink-14">{t('wallet.market.hive_source')}</div>
      <Sparkline values={data.hiveSparkline} />
    </div>
  );
}
