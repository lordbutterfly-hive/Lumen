'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getLogger } from '@ui/lib/logging';
import { useTranslation } from '@/blog/i18n/client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { KeyType } from '@smart-signer/types/common';

const logger = getLogger('app');

/**
 * Broadcasts a real `account_witness_proxy_operation`, signed through the
 * shared smart-signer session. Passing an empty string clears an existing
 * proxy (matches Hive's own semantics for this operation).
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
export function useSetProxyMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const { t } = useTranslation('common_blog');

  return useMutation({
    mutationFn: async (proxy: string) => {
      // A keyless Lumen account has no Hive account and no keys, and a
      // governance vote is counted by Hive consensus — there is no Lumen-local
      // equivalent to fall back to. See lib/lite/client/require-full-account.ts.
      refuseIfLite(user.account_tier, t('witnesses.lite_cannot_vote'));
      const broadcastResult = await transactionService.witnessProxy(proxy, {
        observe: true,
        requiredKeyType: KeyType.active
      });
      logger.info('Set witness proxy broadcast done: %o', { proxy, broadcastResult });
      return { proxy, broadcastResult };
    },
    onSuccess: ({ proxy }) => {
      queryClient.invalidateQueries({ queryKey: ['witnesses-page', 'own-account', user.username] });
      queryClient.invalidateQueries({ queryKey: ['witnesses-page', 'own-votes', user.username] });
      toast({
        variant: 'success',
        description: proxy ? t('witnesses.toast.proxy_set', { proxy }) : t('witnesses.toast.proxy_cleared')
      });
    },
    onError: (error, proxy) => {
      handleError(error, { method: 'setProxy', params: { proxy } });
    }
  });
}
