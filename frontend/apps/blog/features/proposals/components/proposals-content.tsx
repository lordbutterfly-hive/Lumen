'use client';

import { useState } from 'react';
import { IProposal } from '@hive/common-hiveio-packages/wax';
import { NaiAsset } from '@hiveio/wax';
import LeftRail from '@/blog/features/layouts/left-rail';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { useProposalsData } from '../hooks/use-proposals-data';
import { useUserProposalVotes } from '../hooks/use-user-proposal-votes';
import { ProposalSort, ProposalTab } from '../lib/proposals-types';
import ProposalsMainHeader from './proposals-main-header';
import DhfStatsBar from './dhf-stats-bar';
import ProposalsToolbar from './proposals-toolbar';
import ProposalList from './proposal-list';
import ProposalsRightRail from './proposals-right-rail';

interface Props {
  initialProposals: IProposal[] | null;
  initialTreasuryHbdBalance: NaiAsset | null;
  initialHivePerMVests: number | null;
  initialVotedProposalIds: number[] | null;
}

/**
 * Vote Proposals page shell — mirrors HomeShell's fixed 3-column grid
 * (200 / 1px divider / 1fr / 312, gap 44, sticky locked rails) but with
 * page-specific main content and right rail, per the design handoff (each
 * of the five screens shares the shell, not the right-rail content).
 */
export default function ProposalsContent({
  initialProposals,
  initialTreasuryHbdBalance,
  initialHivePerMVests,
  initialVotedProposalIds
}: Props) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // ★ Defense-in-depth (2026-08-11, class sweep): the underlying vote data is
  // already SSR-seeded via getObserver()/initialVotedProposalIds so this cannot
  // currently produce a visible flash, but `identity` is the correct source for
  // "is this reader logged in" everywhere in the app — using the raw, SSR-blind
  // `user.isLoggedIn` here is a latent footgun if that seeding logic ever changes.
  const identity = useSessionIdentity();
  const { loggedUser } = useLoggedUserContext();
  const [tab, setTab] = useState<ProposalTab>('all');
  const [sort, setSort] = useState<ProposalSort>('votes');

  const { proposals, stats, returnProposalVoteValueHp, isLoading, isError, hasData, refetch } = useProposalsData({
    initialProposals,
    initialTreasuryHbdBalance,
    initialHivePerMVests
  });
  const {
    votedIds,
    isError: votesError,
    isLoading: votesLoading,
    hasData: hasVotesData
  } = useUserProposalVotes(user.username, initialVotedProposalIds);

  // The page's chain reads failed AND we have no real data to fall back on: show an honest
  // error state instead of a zeroed stats bar + empty list that would read as real "no proposals".
  const showError = isError && !hasData;
  // Logged-in viewer whose own votes couldn't be loaded: the Support toggle's state is unknown,
  // so render it indeterminate rather than a confident (possibly wrong) "not supported".
  const votesUnavailable = identity.isLoggedIn && !hasVotesData && (votesError || votesLoading);

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0" data-testid="proposals-main">
        <ProposalsMainHeader />
        {showError ? (
          <div
            className="my-5 flex flex-col items-center gap-3 rounded-2xl border border-[#f5c6c0] bg-[#fdf3f2] px-6 py-12 text-center"
            data-testid="proposals-error"
            role="alert"
          >
            <p className="font-sans text-sm font-semibold text-destructive">{t('global.something_went_wrong')}</p>
            <p className="font-sans text-[13px] text-[#6b7280]">{t('proposals.error.description')}</p>
            <button
              type="button"
              onClick={refetch}
              className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2 font-sans text-[13px] font-semibold text-[#3f4650] transition-colors hover:bg-[#f6f7f8]"
            >
              {t('proposals.error.retry')}
            </button>
          </div>
        ) : (
          <>
            <DhfStatsBar stats={stats} />
            <ProposalsToolbar tab={tab} onTabChange={setTab} sort={sort} onSortChange={setSort} />
            {/* ★★★ THE HEADING SAID "FUNDED" NO MATTER WHAT WAS LISTED BELOW IT
                (2026-08-11, fuckery list item 20). This was a single static string
                ("Funded proposals") rendered above the list regardless of which tab
                was selected, so under All — which `matchesTab` deliberately shows
                every status for — the reader saw a "FUNDED PROPOSALS" banner sitting
                directly over proposals badged EXPIRED (e.g. #214, ended Apr 2023).
                Worse, even inside "Active" not every 'active'-status proposal IS
                funded: `computeFundingState` (proposals-format.ts) ranks them against
                the #0 Return Proposal and the treasury's daily budget, and
                `ProposalStatsColumn` already renders a distinct "below funding
                threshold" state for the ones that fall short — the OLD heading
                claimed all of them were funded regardless. The heading now keys on
                the same `tab` the list itself filters by, so it never asserts
                something about the tab's contents that isn't true for entries with a
                different status. */}
            <div className="mb-1.5 font-sans text-xs font-bold uppercase tracking-[0.05em] text-[#9ca3af]">
              {t(`proposals.list.heading.${tab}`)}
            </div>
            <ProposalList
              proposals={proposals}
              votedIds={votedIds}
              votesUnavailable={votesUnavailable}
              tab={tab}
              sort={sort}
              isLoading={isLoading}
            />
          </>
        )}
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <ProposalsRightRail thresholdHp={returnProposalVoteValueHp} currentProxy={loggedUser?.proxy ?? ''} />
      </aside>
    </div>
  );
}
