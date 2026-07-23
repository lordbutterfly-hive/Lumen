'use client';

import { useQuery } from '@tanstack/react-query';
import { StaleTime } from '@/blog/lib/react-query';
import { getUserProposalVoteIds } from '../lib/proposals-api';

/**
 * Which proposal ids the logged-in user currently has an open (approve=true)
 * vote on. Drives the Support/Un-support toggle's initial state so it reflects
 * real on-chain state instead of defaulting everything to "not supported".
 */
export function useUserProposalVotes(username: string, initialVoteIds: number[] | null) {
  const query = useQuery({
    queryKey: ['proposalVotes', username],
    queryFn: () => getUserProposalVoteIds(username),
    initialData: initialVoteIds ? new Set(initialVoteIds) : undefined,
    enabled: !!username,
    staleTime: StaleTime.SHORT
  });

  return {
    votedIds: query.data ?? new Set<number>(),
    isLoading: query.isLoading,
    /** The own-votes fetch failed — every proposal would otherwise falsely render as "not supported". */
    isError: query.isError,
    /** Real vote data is present (from SSR or a resolved fetch); false means "voted?" is unknown. */
    hasData: query.data !== undefined
  };
}
