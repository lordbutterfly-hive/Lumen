'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { getAsset } from '@transaction/lib/utils';
import { getPost } from '@transaction/lib/hive';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

export interface CreateProposalParams {
  creator: string;
  receiver: string;
  permlink: string;
  subject: string;
  dailyPayHbd: string;
  startDate: string;
  endDate: string;
}

/**
 * Builds and broadcasts a real create_proposal_operation. There's no pre-built
 * transactionService.createProposal() helper (only vote/proxy proposal ops exist
 * today), so this calls the same generic processHiveAppOperation + pushOperation
 * every TransactionService method uses internally — see
 * packages/transaction/index.ts's upVote/follow/etc. for the identical pattern.
 * Per protocol, a proposal must reference a post the creator already authored,
 * so this verifies that post exists before broadcasting instead of trusting the form.
 */
export function useCreateProposalMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();

  return useMutation({
    mutationKey: ['createProposal'],
    mutationFn: async (params: CreateProposalParams) => {
      // A keyless Lumen account has no Hive account and no keys, and a
      // governance vote is counted by Hive consensus — there is no Lumen-local
      // equivalent to fall back to. See lib/lite/client/require-full-account.ts.
      refuseIfLite(user.account_tier, t('proposals.lite_cannot_vote'));
      const { creator, receiver, permlink, subject, dailyPayHbd, startDate, endDate } = params;

      const post = await getPost(creator, permlink);
      if (!post) {
        throw new Error(t('proposals.new_dialog.errors.post_not_found', { creator, permlink }));
      }

      const dailyPay = await getAsset(dailyPayHbd, 'HBD');

      const result = await transactionService.processHiveAppOperation((builder) => {
        builder.pushOperation({
          create_proposal_operation: {
            creator,
            receiver,
            start_date: `${startDate}T00:00:00`,
            end_date: `${endDate}T00:00:00`,
            daily_pay: dailyPay,
            subject,
            permlink,
            extensions: []
          }
        });
      });

      return result;
    },
    onSuccess: () => {
      toast({
        title: t('proposals.new_dialog.toast.title'),
        description: t('proposals.new_dialog.toast.description'),
        variant: 'success'
      });
      scheduleInvalidations(queryClient, [['proposalsList']]);
    },
    onError: (error: unknown, variables) => {
      handleError(error, { method: 'useCreateProposalMutation', params: variables });
    }
  });
}
