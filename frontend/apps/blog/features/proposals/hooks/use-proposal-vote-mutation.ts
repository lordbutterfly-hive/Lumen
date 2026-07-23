'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';

interface VoteParams {
  voter: string;
  proposalId: number;
  approve: boolean;
}

/**
 * Toggles a single proposal's Support / Un-support state via a real
 * update_proposal_votes_operation, signed through the app's existing
 * @hive/smart-signer infra (transactionService reads the active signer from
 * SignerProvider — see packages/smart-signer/components/signer-provider.tsx).
 * Optimistically flips the local voted-id set so the heart/pill respond instantly.
 */
export function useProposalVoteMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('common_blog');

  return useMutation({
    mutationKey: ['proposalVote'],
    onMutate: async ({ voter, proposalId, approve }: VoteParams) => {
      const queryKey = ['proposalVotes', voter];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Set<number>>(queryKey);
      const next = new Set(previous ?? []);
      if (approve) next.add(proposalId);
      else next.delete(proposalId);
      queryClient.setQueryData(queryKey, next);
      return { previous, queryKey };
    },
    mutationFn: async ({ voter, proposalId, approve }: VoteParams) => {
      await transactionService.updateProposalVotes([String(proposalId)], approve, [], { observe: false });
      return { voter, proposalId, approve };
    },
    onSuccess: ({ voter, approve }) => {
      toast({
        title: approve ? t('proposals.vote_toast.supported_title') : t('proposals.vote_toast.unsupported_title'),
        description: approve
          ? t('proposals.vote_toast.supported_description')
          : t('proposals.vote_toast.unsupported_description'),
        variant: 'success'
      });
      scheduleInvalidations(queryClient, [['proposalVotes', voter], ['proposalsList']]);
    },
    onError: (error: unknown, variables, context) => {
      if (context) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      handleError(error, { method: 'useProposalVoteMutation', params: variables });
    }
  });
}
