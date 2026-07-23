'use client';

import { useTranslation } from '@/blog/i18n/client';
import { useHiveMarketPrices } from '../hooks/use-hive-market-prices';

const CARD_CLASS = 'rounded-[18px] border border-[#ebebeb] bg-white p-5';

/**
 * HBD's "real" price on the wallet page is $1.000 — the internal Hive market
 * peg, which is how the design describes this card ("HBD price in the
 * Internal Hive Market"). The CoinGecko spot price (which can drift from the
 * peg on thin external exchanges) is shown underneath as the secondary line,
 * same split the design specifies.
 */
export default function PriceCardHbd() {
  const { t } = useTranslation('common_blog');
  const { data, isLoading, isError } = useHiveMarketPrices();

  return (
    <div className={CARD_CLASS} data-testid="wallet-price-hbd">
      <div className="font-sans text-[24px] font-bold tabular-nums text-[#161511]">$1.000</div>
      <div className="mt-1.5 text-[12.5px] text-[#6b7280]">{t('wallet.market.hbd_price_label')}</div>
      <div className="mt-1.5 text-[12px] text-[#9ca3af]">
        {isLoading || isError || !data
          ? t('wallet.market.unavailable')
          : t('wallet.market.hbd_source', { price: data.hbdUsd.toFixed(3) })}
      </div>
    </div>
  );
}
