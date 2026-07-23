'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useHiveMarketPrices } from '../hooks/use-hive-market-prices';
import Sparkline from './sparkline';

const CARD_CLASS = 'rounded-[18px] border border-[#ebebeb] bg-white p-5';

export default function PriceCardHive() {
  const { t } = useTranslation('common_blog');
  const { data, isLoading, isError } = useHiveMarketPrices();

  if (isLoading || isError || !data) {
    return (
      <div className={CARD_CLASS} data-testid="wallet-price-hive">
        <span className="font-sans text-[26px] font-bold tabular-nums text-[#161511]">—</span>
        <div className="mt-1.5 text-[12.5px] text-[#6b7280]">{t('wallet.market.unavailable')}</div>
      </div>
    );
  }

  const changePositive = data.hiveUsd24hChange >= 0;

  return (
    <div className={CARD_CLASS} data-testid="wallet-price-hive">
      <div className="flex items-center justify-between">
        <span className="font-sans text-[26px] font-bold tabular-nums text-[#161511]">
          ${data.hiveUsd.toFixed(4)}
        </span>
        <span
          className={`rounded-full px-2.5 py-[3px] text-[12px] font-bold ${
            changePositive ? 'bg-[#e9f5ee] text-[#2f7d4f]' : 'bg-[#fbe9e7] text-[#c0392b]'
          }`}
        >
          {changePositive ? '+' : ''}
          {data.hiveUsd24hChange.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 text-[12.5px] text-[#6b7280]">
        {t('wallet.market.hive_via', { btc: data.hiveBtc.toFixed(8) })}
      </div>
      <div className="mt-0.5 text-[12px] text-[#9ca3af]">{t('wallet.market.hive_source')}</div>
      <Sparkline values={data.hiveSparkline} />
    </div>
  );
}
