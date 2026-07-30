'use client';

import { useQuery } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getSubscriptions } from '@transaction/lib/bridge-api';
import { StaleTime } from '@/blog/lib/react-query';
import MarketWidget from '@/blog/features/prediction-market/market-widget';
import Communities from './right-rail/communities';
import Topics from './right-rail/topics';

const CARD_CLASS =
  'rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

export default function RightRail() {
  const { user, isHydrated } = useUserClient();
  const isLoggedIn = isHydrated && !!user.isLoggedIn;
  const observer = isLoggedIn ? user.username : null;

  // Hasn't hydrated yet, or hydrated logged-in and the fetch hasn't resolved:
  // both read as "loading," never as a false "zero communities."
  const { data: subscriptions, isLoading: isFetching } = useQuery({
    queryKey: ['subscriptions', observer],
    queryFn: () => getSubscriptions(observer as string),
    enabled: !!observer,
    staleTime: StaleTime.LONG
  });
  const isLoading = !isHydrated || (isLoggedIn && isFetching);

  return (
    <aside className="flex w-full flex-col gap-5 font-sans text-foreground" data-testid="right-rail">
      <div className={CARD_CLASS}>
        <MarketWidget />
      </div>
      <div className={CARD_CLASS}>
        <Communities subscriptions={subscriptions} isLoggedIn={isLoggedIn} isLoading={isLoading} />
      </div>
      <div className={CARD_CLASS}>
        <Topics />
      </div>
    </aside>
  );
}
