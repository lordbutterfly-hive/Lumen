'use client';

import { getMarketDataSource } from '@/blog/features/prediction-market/lib/market-data-source';
import MarketWidget from '@/blog/features/prediction-market/market-widget';
import { TodayCard } from '@/blog/features/retention/components/today-card';
import Topics from './right-rail/topics';

const CARD_CLASS =
  'rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

// Communities widget removed from the right rail (owner request, 2026-08-06).
// `right-rail/communities.tsx` (subscriptions query + card) was deleted with
// it — nothing else in the tree imported that file.
export default function RightRail() {
  // ★ THE MARKET CARD IS GONE UNTIL THE MARKET SHIPS (owner ruling, 2026-08-11,
  // item F8/P3). No REACT_APP_VSC_MARKET_* contract is provisioned on this
  // build, so MarketWidget's own `isUnavailable` branch was rendering a
  // permanent bordered card on EVERY page whose entire content is "Prediction
  // Market — not available yet" — occupying real estate to announce a feature
  // that does not exist. Gated on the SAME provisioning check
  // `useMarket()`/`MarketTab` already use (`getMarketDataSource() !== null` —
  // real once REACT_APP_VSC_MARKET_CONTRACT_ID/NET_ID/GQL_URL are set, see
  // lib/market-config.ts), not a new flag, so the card reappears on its own the
  // day the contract is live — nothing here needs to be undone at ship time.
  // MarketWidget itself is untouched: its "not available" branch still exists
  // for any other place that might mount it, and no feature code was deleted.
  const marketAvailable = getMarketDataSource() !== null;
  return (
    <aside className="flex w-full flex-col gap-5 font-sans text-foreground" data-testid="right-rail">
      {/* Top of the rail, and it brings its own card chrome — it renders nothing at
          all for a signed-out reader or a server that predates the daily loop, and an
          empty bordered box would be worse than an absent one. */}
      <TodayCard />
      {marketAvailable ? (
        <div className={CARD_CLASS}>
          <MarketWidget />
        </div>
      ) : null}
      <div className={CARD_CLASS}>
        <Topics />
      </div>
    </aside>
  );
}
