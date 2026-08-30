'use client';

import { useQuery } from '@tanstack/react-query';
import { StaleTime } from '@/blog/lib/react-query';
import { fetchProposalVoters } from '@/blog/lib/chain-fetch';

/**
 * Every voter behind one proposal's HP total, sorted descending, capped
 * server-side (see app/api/proposal-votes/route.ts). `enabled` is passed in
 * rather than assumed true: the underlying read is expensive (every voter's
 * own account, chunked and fetched) and most proposal cards on the page are
 * never opened, so the dialog wires this to its own `open` state instead of
 * firing for every card on mount.
 *
 * ★ isLoading / isError / hasData is the SAME three-way split
 * use-user-proposal-votes.ts and use-proposals-data.ts already use elsewhere
 * in this feature: a failed read must never render as "no votes yet" (that is
 * a claim about the proposal, not about our connection to the chain), and a
 * read still in flight must never render as failed either. Kept as separate
 * flags to match those two hooks exactly rather than introducing a second
 * "collapse read" convention into this feature (see features/creator-tokens/
 * live/collapse-read.ts for the same rule expressed as a single function —
 * that one is scoped to the creator-tokens live reads it was built for).
 */
export function useProposalVoters(proposalId: number, enabled: boolean) {
  const query = useQuery({
    queryKey: ['proposalVoters', proposalId],
    queryFn: () => fetchProposalVoters(proposalId),
    enabled,
    staleTime: StaleTime.SHORT
  });

  return {
    voters: query.data?.voters ?? [],
    total: query.data?.total,
    isLoading: query.isLoading,
    /** The read failed — render an honest error, never "No votes yet". */
    isError: query.isError,
    /** Real data is present — distinguishes a genuinely empty roster from "haven't heard back yet". */
    hasData: query.data !== undefined,
    /** A retry is in flight — `isLoading` alone stays false for a refetch of an already-errored query (react-query v4 reserves it for the FIRST fetch), so the retry button needs its own pending signal. */
    isRetrying: query.isFetching,
    refetch: query.refetch
  };
}
