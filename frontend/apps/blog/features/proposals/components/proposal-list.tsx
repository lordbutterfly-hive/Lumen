'use client';

import { useTranslation } from '@/blog/i18n/client';
import { ProposalSort, ProposalTab, ProposalViewModel } from '../lib/proposals-types';
import ProposalCard from './proposal-card';
import { LumenLoader } from '@hive/ui';

function matchesTab(vm: ProposalViewModel, tab: ProposalTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'upcoming') return vm.proposal.status === 'inactive';
  return vm.proposal.status === tab;
}

function sortProposals(list: ProposalViewModel[], sort: ProposalSort): ProposalViewModel[] {
  const sorted = list.slice();
  switch (sort) {
    case 'newest':
      return sorted.sort((a, b) => (a.proposal.start_date < b.proposal.start_date ? 1 : -1));
    case 'daily_pay':
      return sorted.sort((a, b) => Number(b.proposal.daily_pay.amount) - Number(a.proposal.daily_pay.amount));
    case 'ending_soon':
      return sorted.sort((a, b) => (a.proposal.end_date > b.proposal.end_date ? 1 : -1));
    case 'votes':
    default:
      // Already fetched from the chain sorted by total_votes descending.
      return sorted.sort((a, b) => (BigInt(a.proposal.total_votes) < BigInt(b.proposal.total_votes) ? 1 : -1));
  }
}

interface Props {
  proposals: ProposalViewModel[];
  votedIds: ReadonlySet<number>;
  /** True when the viewer's own votes couldn't be loaded — support state is unknown, not "no". */
  votesUnavailable: boolean;
  tab: ProposalTab;
  sort: ProposalSort;
  isLoading: boolean;
}

export default function ProposalList({ proposals, votedIds, votesUnavailable, tab, sort, isLoading }: Props) {
  const { t } = useTranslation('common_blog');

  if (isLoading && proposals.length === 0) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="proposal-list-loading">
        <LumenLoader size="lg" label={t('global.loading_proposals')} />
      </div>
    );
  }

  const filtered = sortProposals(
    proposals.filter((vm) => matchesTab(vm, tab)),
    sort
  );

  if (filtered.length === 0) {
    return (
      <p className="py-12 text-center font-sans text-sm text-ink-10" data-testid="proposal-list-empty">
        {t('proposals.list.empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="proposal-list">
      {filtered.map((vm) => (
        <ProposalCard
          key={vm.id}
          vm={vm}
          isSupported={votedIds.has(vm.id)}
          votesUnavailable={votesUnavailable}
        />
      ))}
    </div>
  );
}
