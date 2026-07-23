'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getLogger } from '@ui/lib/logging';
import { useTranslation } from '@/blog/i18n/client';

const logger = getLogger('app');

interface WitnessVoteParams {
  witness: string;
  approve: boolean;
}

/**
 * Broadcasts a real `account_witness_vote_operation`, signed through the
 * app's smart-signer session (same signer already wired for follow/flag/
 * post ops via `transactionService`). Approving and un-approving both go
 * through this one operation with `approve: true|false`.
 */
export function useWitnessVoteMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const { t } = useTranslation('common_blog');

  return useMutation({
    mutationFn: async ({ witness, approve }: WitnessVoteParams) => {
      const broadcastResult = await transactionService.witnessVote(user.username, witness, approve, {
        observe: true
      });
      logger.info('Witness vote broadcast done: %o', { witness, approve, broadcastResult });
      return { witness, approve, broadcastResult };
    },
    onSuccess: ({ witness, approve }) => {
      queryClient.invalidateQueries({ queryKey: ['witnesses-page', 'own-votes', user.username] });
      queryClient.invalidateQueries({ queryKey: ['witnesses-page', 'witness-list'] });
      toast({
        variant: 'success',
        description: approve
          ? t('witnesses.toast.voted', { witness })
          : t('witnesses.toast.unvoted', { witness })
      });
    },
    onError: (error, variables) => {
      handleError(error, { method: 'witnessVote', params: variables });
    }
  });
}
