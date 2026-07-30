'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IProposal } from '@hive/common-hiveio-packages/wax';
import { NaiAsset } from '@hiveio/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { getHivePerMVestsLive, getProposalsList, getTreasuryHbdBalance } from '../lib/proposals-api';
import {
  assetToNumber,
  buildProposalViewModel,
  computeDhfStats,
  computeFundingState,
  votesToHp
} from '../lib/proposals-format';
import { DhfStats, ProposalViewModel } from '../lib/proposals-types';

export interface UseProposalsDataResult {
  proposals: ProposalViewModel[];
  /** undefined until all three underlying reads resolve — render a skeleton, never a false "0.000 HBD". */
  stats: DhfStats | undefined;
  returnProposalVoteValueHp: number | undefined;
  isLoading: boolean;
  isError: boolean;
  /** All three underlying reads resolved with real data — safe to render the stats bar / list. */
  hasData: boolean;
  /** Re-runs the treasury / list / hivePerMVests reads — wired to the error/retry affordance. */
  refetch: () => void;
}

interface Props {
  initialProposals: IProposal[] | null;
  initialTreasuryHbdBalance: NaiAsset | null;
  initialHivePerMVests: number | null;
}

/**
 * Single source of truth for the whole page's chain data: the vote-ranked proposal
 * window, the DHF treasury balance, and the HIVE/VESTS conversion factor. Combines
 * them into per-proposal view models (funded flag, HP vote value, paid/to-pay) and
 * the stats-bar numbers — computed once here so every child component just renders.
 */
export function useProposalsData({
  initialProposals,
  initialTreasuryHbdBalance,
  initialHivePerMVests
}: Props): UseProposalsDataResult {
  const proposalsQuery = useQuery({
    queryKey: ['proposalsList'],
    queryFn: () => getProposalsList(),
    initialData: initialProposals ?? undefined,
    staleTime: StaleTime.SHORT
  });

  const treasuryQuery = useQuery({
    queryKey: ['proposalsTreasuryBalance'],
    queryFn: () => getTreasuryHbdBalance(),
    initialData: initialTreasuryHbdBalance ?? undefined,
    staleTime: StaleTime.MEDIUM
  });

  const hivePerMVestsQuery = useQuery({
    queryKey: ['proposalsHivePerMVests'],
    queryFn: () => getHivePerMVestsLive(),
    initialData: initialHivePerMVests ?? undefined,
    staleTime: StaleTime.MEDIUM
  });

  const proposals = proposalsQuery.data;
  const treasury = treasuryQuery.data;
  const hivePerMVests = hivePerMVestsQuery.data;

  const result = useMemo(() => {
    if (!proposals || !treasury || hivePerMVests === undefined) {
      return { proposals: [] as ProposalViewModel[], stats: undefined, returnProposalVoteValueHp: undefined };
    }
    // maxDailyBudgetHbd must be known before we can tell which proposals are funded,
    // so compute the budget-independent half of the stats first.
    const maxDailyBudgetHbd = assetToNumber(treasury) / 100;
    const funding = computeFundingState(proposals, maxDailyBudgetHbd);
    const stats = computeDhfStats(proposals, treasury, funding);
    const viewModels = proposals.map((p) => buildProposalViewModel(p, funding.fundedIds, hivePerMVests));
    const returnProposalVoteValueHp = funding.returnProposal
      ? votesToHp(funding.returnProposal.total_votes, hivePerMVests)
      : undefined;
    return { proposals: viewModels, stats, returnProposalVoteValueHp };
  }, [proposals, treasury, hivePerMVests]);

  const refetch = () => {
    void proposalsQuery.refetch();
    void treasuryQuery.refetch();
    void hivePerMVestsQuery.refetch();
  };

  return {
    proposals: result.proposals,
    stats: result.stats,
    returnProposalVoteValueHp: result.returnProposalVoteValueHp,
    isLoading: proposalsQuery.isLoading || treasuryQuery.isLoading || hivePerMVestsQuery.isLoading,
    isError: proposalsQuery.isError || treasuryQuery.isError || hivePerMVestsQuery.isError,
    hasData: proposals !== undefined && treasury !== undefined && hivePerMVests !== undefined,
    refetch
  };
}
