'use client';

import { useTranslation } from '@/blog/i18n/client';
import { getMarketStatsUrl } from '@/blog/features/wallet/lib/wallet-endpoint';
import PriceCardHive from '@/blog/features/wallet/components/price-card-hive';
import PriceCardHbd from '@/blog/features/wallet/components/price-card-hbd';

/**
 * Read-only copy of features/wallet/components/wallet-right-rail.tsx for the
 * public wallet page. Removed: the account specific balance fetch and
 * AdvancedToolsCard entirely, covering power up, power down, delegate, claim
 * account tokens and convert. Every one of those signs a transaction for the
 * signed in account, which has no meaning on someone else's wallet page and
 * has no session to read here in any case (D5). What remains is public
 * market data: the two price cards and the market stats link, shown
 * regardless of any account.
 */
export default function PublicWalletRightRail() {
  const { t } = useTranslation('common_blog');
  const marketStatsUrl = getMarketStatsUrl();

  return (
    <aside className="flex w-full flex-col gap-4 font-ui" data-testid="public-wallet-right-rail">
      <PriceCardHive />
      <PriceCardHbd />
      {marketStatsUrl !== '#' ? (
        <a
          href={marketStatsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-caption font-medium text-ink-brand-6 hover:text-ink-brand-4"
          data-testid="public-wallet-view-more-market-stats"
        >
          {t('wallet.market.view_more')}
        </a>
      ) : null}
    </aside>
  );
}
