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
  // Same guard as wallet-content.tsx, and it is NOT redundant: this rail fetches
  // its own copy, so guarding only the centre column left the page still
  // crashing. `getAccountFull` on a name that does not exist on chain resolves to
  // a TRUTHY object with no balance fields (Hive returns an empty array,
  // `getAccounts([n])[0]` is undefined, and the spread `{...undefined}` yields
  // `{}`), so the hook's `if (!accountQuery.data) return null` guard passes and
  // `Big(undefined)` throws inside its useMemo. There is no error.tsx under
  // app/wallet, so that throw blanks the whole page — including the honest
  // "no wallet yet" panel that was added to explain the situation.
  const isLite = user.account_tier === 'lite';
  const { figures, pendingClaimedAccounts } = useWalletAccount(isLite ? '' : user.username);

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
      {/* Hidden for a lite account. Every tool in here (power up/down, delegate,
          claim account tokens) is a Hive key operation, and with the queries
          disabled above its figures would all be ZERO — a card reading
          "0.000 HP" is a claim about a balance, not an absence of one. */}
      {!isLite && (
        <AdvancedToolsCard
          username={user.username}
          netHp={figures?.netHp ?? ZERO}
          hbdBalance={figures?.liquidHbd ?? ZERO}
          pendingClaimedAccounts={pendingClaimedAccounts}
        />
      )}
    </aside>
  );
}
