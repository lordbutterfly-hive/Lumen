import { UseWitnessFiltersResult } from './hooks/use-witness-filters';
import WitnessesFiltersCard from './witnesses-filters-card';
import WitnessesProxyCard from './witnesses-proxy-card';

interface WitnessesRightRailProps {
  filtersState: UseWitnessFiltersResult;
  isLoggedIn: boolean;
  hasProxy: boolean;
  proxyAccount: string;
}

const CARD_CLASS = 'rounded-panel border border-line-9 bg-surface-1 p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)]';

/**
 * Page-specific right rail for /witnesses: Filters + Set-a-proxy, per the
 * design handoff. The app's shared `<RightRail>` (features/layouts/right-rail.tsx)
 * renders the Home page's prediction-market/communities/topics widgets and
 * isn't reused here — every page in the handoff has its own right-rail
 * content, only the card styling (`CARD_CLASS`, mirrored from the shared
 * component) and the sticky/locked column position are shared.
 */
export default function WitnessesRightRail({ filtersState, isLoggedIn, hasProxy, proxyAccount }: WitnessesRightRailProps) {
  return (
    <aside className="flex w-full flex-col gap-5 font-sans text-foreground" data-testid="witnesses-right-rail">
      <div className={CARD_CLASS}>
        <WitnessesFiltersCard {...filtersState} />
      </div>
      <div className={CARD_CLASS}>
        <WitnessesProxyCard isLoggedIn={isLoggedIn} hasProxy={hasProxy} proxyAccount={proxyAccount} />
      </div>
    </aside>
  );
}
