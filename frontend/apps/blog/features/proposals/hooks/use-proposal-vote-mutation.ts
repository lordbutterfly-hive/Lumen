'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { KeyType } from '@smart-signer/types/common';

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
/**
 * ★★★ ACTIVE AUTHORITY (2026-08-16, reported live by the owner on `hbd-temp`).
 *
 * Hive requires ACTIVE authority for every GOVERNANCE operation
 * (`account_witness_vote`, `account_witness_proxy`, `update_proposal_votes`,
 * `create_proposal`), exactly as it does for the money operations in
 * `features/wallet/hooks/*`.
 *
 * Without `requiredKeyType` the signer resolves `requiredKeyType ?? this.keyType`
 * — the key type the SESSION logged in with, which is `posting` — and
 * `verifyAuthorityOrThrow` rejects the transaction before broadcast with "does not
 * have active authority". A 100%-failure bug, not a fund risk: NO governance
 * action could complete for any full Hive login.
 *
 * The identical bug was found and fixed across the wallet hooks on 2026-08-01.
 * That pass even borrowed `use-witness-vote-mutation.ts`'s `refuseIfLite` guard
 * while fixing it, and did not notice the same defect sitting in the file it was
 * copying from. Governance was never swept. All five call sites fixed together.
 */
export function useProposalVoteMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();

  return useMutation({
    mutationKey: ['proposalVote'],
    onMutate: async ({ voter, proposalId, approve }: VoteParams) => {
      // Refuse BEFORE the optimistic update, not just in mutationFn below — the
      // previous ordering let the heart/pill flip to "supported" for one render
      // even for a lite account that can never actually vote, only rolling back
      // after the mutationFn's refuseIfLite threw. See require-full-account.ts.
      refuseIfLite(user.account_tier, t('proposals.lite_cannot_vote'));
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
      // A keyless Lumen account has no Hive account and no keys, and a
      // governance vote is counted by Hive consensus — there is no Lumen-local
      // equivalent to fall back to. See lib/lite/client/require-full-account.ts.
      refuseIfLite(user.account_tier, t('proposals.lite_cannot_vote'));
      await transactionService.updateProposalVotes([String(proposalId)], approve, [], {
        observe: false,
        requiredKeyType: KeyType.active
      });
      return { voter, proposalId, approve };
    },
    onSuccess: ({ voter, approve }) => {
      toast({
        title: approve
          ? t('proposals.vote_toast.supported_title')
          : t('proposals.vote_toast.unsupported_title'),
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
