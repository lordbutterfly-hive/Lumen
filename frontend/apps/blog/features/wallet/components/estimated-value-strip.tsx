'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useHiveMarketPrices } from '../hooks/use-hive-market-prices';
import { formatUsd } from '../lib/format-amount';
import { WalletFigures } from '../lib/wallet-derived';

/**
 * USD value of every token this account holds (liquid + savings + net HP for
 * HIVE, liquid + savings for HBD), priced off the same CoinGecko feed as the
 * rail's price cards. Renders "—" instead of a number while prices are
 * loading/unavailable rather than guessing.
 */
export default function EstimatedValueStrip({ figures }: { figures: WalletFigures }) {
  const { t } = useTranslation('common_blog');
  const { data: prices, isLoading, isError } = useHiveMarketPrices();

  // ★ OWN stake only (2026-08-09). This used `netHp`, which adds HP delegated IN
  // — so an account holding 0.000 HP of its own showed 93% of its "Estimated
  // Account Value" as somebody else's stake, revocable at any moment.
  const totalHive = figures.liquidHive.plus(figures.savingsHive).plus(figures.movableHp);
  const totalHbd = figures.liquidHbd.plus(figures.savingsHbd);

  const hasPrices = !isLoading && !isError && !!prices;
  const valueUsd = hasPrices
    ? totalHive.toNumber() * prices.hiveUsd + totalHbd.toNumber() * 1
    : null;

  return (
    <div
      className="mb-[18px] flex items-center justify-between rounded-[18px] border border-[#ebebeb] bg-[#fbfbfa] px-6 py-[22px]"
      data-testid="wallet-estimated-value"
    >
      <div>
        <div className="text-[20px] font-semibold text-[#161511]">{t('wallet.estimated_value.title')}</div>
        <div className="mt-0.5 text-[13.5px] text-[#6b7280]">{t('wallet.estimated_value.description')}</div>
      </div>
      <span className="font-sans text-[30px] font-bold tabular-nums text-[#2f7d4f]">
        {valueUsd === null ? '—' : formatUsd(valueUsd)}
      </span>
    </div>
  );
}
