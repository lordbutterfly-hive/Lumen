'use client';

import Big from 'big.js';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useWalletAccount } from '../hooks/use-wallet-account';
import { getMarketStatsUrl } from '../lib/wallet-endpoint';
import PriceCardHive from './price-card-hive';
import PriceCardHbd from './price-card-hbd';
import AdvancedToolsCard from './advanced-tools-card';

const ZERO = new Big(0);

/**
 * Right rail: market price cards + the Advanced power-user tools card.
 * Fetches its own wallet data (same query keys as the center column, so
 * react-query dedupes the network call) rather than taking it as props —
 * same decoupled-sibling pattern the home shell already uses for its rail.
 */
export default function WalletRightRail() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const { figures, pendingClaimedAccounts } = useWalletAccount(user.username);

  return (
    <aside className="flex w-full flex-col gap-5 font-sans" data-testid="wallet-right-rail">
      <PriceCardHive />
      <PriceCardHbd />
      <a
        href={getMarketStatsUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="text-center text-[13px] font-semibold text-[#c0392b] hover:text-[#96271b]"
        data-testid="wallet-view-more-market-stats"
      >
        {t('wallet.market.view_more')}
      </a>
      <AdvancedToolsCard
        username={user.username}
        netHp={figures?.netHp ?? ZERO}
        hbdBalance={figures?.liquidHbd ?? ZERO}
        pendingClaimedAccounts={pendingClaimedAccounts}
      />
    </aside>
  );
}
