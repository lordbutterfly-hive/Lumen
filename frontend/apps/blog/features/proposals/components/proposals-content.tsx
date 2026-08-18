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
  // ★ DEFAULT WAS A WALL OF EXPIRED PROPOSALS (2026-08-17). Measured live: 94
  // expired vs 8 active. `status: 'all'` is still fetched (proposals-api.ts —
  // every tab needs the full window to filter client-side), but the reader
  // should land on what's actually fundable today, not the chain's full
  // history. "All" stays one click away in the toolbar; it isn't removed.
  const [tab, setTab] = useState<ProposalTab>('active');
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
  /**
   * ★★★ "UNAVAILABLE" IS A VERDICT, AND LOADING IS NOT ONE (2026-08-17).
   *
   * This included `votesLoading`, so every signed-in reader was told
   * "Vote status unavailable" for the whole of a perfectly healthy fetch — the
   * page asserting a failure it had no evidence for, on the ordinary path, every
   * single visit. Same defect as the delivery record reporting "0% completion
   * rate" for a creator nobody had asked anything of, and `/creators` announcing
   * that nobody had launched a token: an absence of data reported as a fact.
   *
   * Now it means only what the word says — we asked and it failed. A fetch still
   * in flight is `votesPending` and gets a pending affordance instead.
   */
  const votesUnavailable = identity.isLoggedIn && !hasVotesData && votesError;
  const votesPending = identity.isLoggedIn && !hasVotesData && !votesError && votesLoading;

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0" data-testid="proposals-main">
        <ProposalsMainHeader />
        {showError ? (
          <div
            className="my-5 flex flex-col items-center gap-3 rounded-2xl border border-line-brand-4 bg-surface-brand-1 px-6 py-12 text-center"
            data-testid="proposals-error"
            role="alert"
          >
            <p className="font-sans text-sm font-semibold text-destructive">{t('global.something_went_wrong')}</p>
            <p className="font-sans text-[13px] leading-[20px] text-ink-10">{t('proposals.error.description')}</p>
            <button
              type="button"
              onClick={refetch}
              className="rounded-control border border-line-11 bg-surface-1 px-4 py-2 font-sans text-[13px] leading-[20px] font-semibold text-ink-7 transition-colors hover:bg-surface-16"
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
            <div className="mb-1.5 font-sans text-xs font-bold uppercase tracking-[0.05em] text-ink-14">
              {t(`proposals.list.heading.${tab}`)}
            </div>
            <ProposalList
              proposals={proposals}
              votedIds={votedIds}
              votesUnavailable={votesUnavailable}
              votesPending={votesPending}
              tab={tab}
              sort={sort}
              isLoading={isLoading}
            />
          </>
        )}
      </main>

      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
        <ProposalsRightRail thresholdHp={returnProposalVoteValueHp} currentProxy={loggedUser?.proxy ?? ''} />
      </aside>
    </div>
  );
}
