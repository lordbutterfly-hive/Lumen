'use client';

import { getMarketDataSource } from '@/blog/features/prediction-market/lib/market-data-source';
import MarketWidget from '@/blog/features/prediction-market/market-widget';
import Topics from './right-rail/topics';

const CARD_CLASS =
/* ★ WARM CARD SHADOW (illumination SPEC.md §3, owner 2026-08-21: "do the
   illumination gap, composer widgets skeletons and login").

   §3: "the card's shadow stops being grey". `70 46 30` is --ink-1 warmed and is
   a SHADOW colour only — it appears nowhere as a surface. The tight first layer
   uses the same `26 22 18` the elevation ladder already hand-writes.

   ★ rgba() WITH COMMAS, NOT rgb()/alpha. A `/` inside a Tailwind arbitrary value
   is the OPACITY shorthand, so `shadow-[...rgb(70_46_30/0.13)]` never compiles
   and no rule is emitted — measured on the feed's tab bar, which shipped with
   `box-shadow: none` until it was caught. */
  'rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(26,22,18,0.035),0_3px_12px_-6px_rgba(70,46,30,0.13)]';

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
      {/* ★ THE STREAK CARD IS GONE (owner, 2026-08-23: "we have it already on left side,
          we dont need it there"). It was not just redundant, it CONTRADICTED the sidebar:
          the same viewport showed "Ember - rank 2 of 9" on the left and "STREAK 0 days -
          post or comment today and it goes to 1" here, ~200px apart, implying they measure
          the same thing. Rank is the durable signal, it is on every page, and it survives
          a missed day, so the weaker of the two was cut. NOT relocated - see the component
          file. If daily-activity feedback is wanted later it belongs on the profile rank
          card, where the rank explanation already lives. */}
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
