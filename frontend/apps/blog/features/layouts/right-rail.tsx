'use client';

import MarketWidget from '@/blog/features/prediction-market/market-widget';
import { TodayCard } from '@/blog/features/retention/components/today-card';
import Topics from './right-rail/topics';

const CARD_CLASS =
  'rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

// Communities widget removed from the right rail (owner request, 2026-08-06).
// `right-rail/communities.tsx` (subscriptions query + card) was deleted with
// it — nothing else in the tree imported that file.
export default function RightRail() {
  return (
    <aside className="flex w-full flex-col gap-5 font-sans text-foreground" data-testid="right-rail">
      {/* Top of the rail, and it brings its own card chrome — it renders nothing at
          all for a signed-out reader or a server that predates the daily loop, and an
          empty bordered box would be worse than an absent one. */}
      <TodayCard />
      <div className={CARD_CLASS}>
        <MarketWidget />
      </div>
      <div className={CARD_CLASS}>
        <Topics />
      </div>
    </aside>
  );
}
