import MarketWidget from '@/blog/features/prediction-market/market-widget';
import Communities from './right-rail/communities';
import Topics from './right-rail/topics';

const CARD_CLASS =
  'rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

export default function RightRail({ subscriptions }: { subscriptions?: string[][] }) {
  return (
    <aside className="flex w-full flex-col gap-5 font-sans text-foreground" data-testid="right-rail">
      <div className={CARD_CLASS}>
        <MarketWidget />
      </div>
      <div className={CARD_CLASS}>
        <Communities subscriptions={subscriptions} />
      </div>
      <div className={CARD_CLASS}>
        <Topics />
      </div>
    </aside>
  );
}
