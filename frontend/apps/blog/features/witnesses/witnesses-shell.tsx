'use client';

import { useState } from 'react';
import LeftRail from '@/blog/features/layouts/left-rail';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useWitnessesData } from './hooks/use-witnesses-data';
import { useWitnessFilters } from './hooks/use-witness-filters';
import WitnessesHeader from './witnesses-header';
import WitnessesStatsBar from './witnesses-stats-bar';
import WitnessesTable from './witnesses-table';
import WitnessesRightRail from './witnesses-right-rail';
import { WitnessViewMode } from './lib/types';

/**
 * /witnesses page shell — mirrors HomeShell's fixed 3-column grid (200 /
 * 1fr / 312, gap 44, max-width 1720, symmetric 44px gutters, centered,
 * 1px vertical divider at the nav's right edge) so the page sits inside
 * the same shared frame as Home. Left rail is the real shared component;
 * the right rail is page-specific (see WitnessesRightRail).
 */
export default function WitnessesShell() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const data = useWitnessesData();
  const filtersState = useWitnessFilters(data.rows);
  const [viewMode, setViewMode] = useState<WitnessViewMode>('general');

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0" data-testid="witnesses-main">
        <WitnessesHeader viewMode={viewMode} onViewModeChange={setViewMode} />

        <WitnessesStatsBar
          hpAprPercent={data.hpAprPercent}
          hbdInterestRatePercent={data.hbdInterestRatePercent}
          witnessCount={data.witnessCount}
          votesLeft={data.votesLeft}
          isLoggedIn={user.isLoggedIn}
          hasProxy={data.hasProxy}
          proxyAccount={data.proxyAccount}
        />

        {data.ownDataError && (
          <div
            className="my-3 flex items-center justify-between gap-4 rounded-xl border border-[#f5c6c0] bg-[#fdf3f2] px-4 py-3"
            data-testid="witnesses-own-data-error"
          >
            <span className="font-sans text-[13px] text-[#c0392b]">
              {t('witnesses.own_data_error.message')}
            </span>
            <button
              type="button"
              onClick={data.refetch}
              className="shrink-0 font-sans text-[13px] font-semibold text-[#c0392b] underline hover:text-[#96271b]"
            >
              {t('witnesses.own_data_error.retry')}
            </button>
          </div>
        )}

        <WitnessesTable
          rows={filtersState.filteredRows}
          viewMode={viewMode}
          isLoading={data.isLoading}
          isError={data.isError}
          onRetry={data.refetch}
          isLoggedIn={user.isLoggedIn}
          hasProxy={data.hasProxy}
          ownVotesUnavailable={data.ownVotesUnavailable}
          hpAprPercent={data.hpAprPercent}
        />
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <WitnessesRightRail
          filtersState={filtersState}
          isLoggedIn={user.isLoggedIn}
          hasProxy={data.hasProxy}
          proxyAccount={data.proxyAccount}
        />
      </aside>
    </div>
  );
}
