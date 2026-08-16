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

/**
 * Sets (or clears, with proxy = '') the account_witness_proxy_operation.
 * A single proxy setting delegates BOTH witness votes and proposal votes — see the
 * wax type doc on account_witness_proxy: "{proxy} will also vote for proposals in
 * the name of {account}." Reuses transactionService.witnessProxy, the same builder
 * a future Vote Witness page would use, so this isn't a proposals-only shortcut.
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
export function useProxyMutation(username: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();

  return useMutation({
    mutationKey: ['proposalsProxy'],
    mutationFn: async (proxy: string) => {
      // A keyless Lumen account has no Hive account and no keys, and a
      // governance vote is counted by Hive consensus — there is no Lumen-local
      // equivalent to fall back to. See lib/lite/client/require-full-account.ts.
      refuseIfLite(user.account_tier, t('proposals.lite_cannot_vote'));
      await transactionService.witnessProxy(proxy, {
        observe: true,
        requiredKeyType: KeyType.active
      });
      return proxy;
    },
    onSuccess: (proxy) => {
      toast({
        title: proxy ? t('proposals.proxy_toast.set_title') : t('proposals.proxy_toast.cleared_title'),
        description: proxy
          ? t('proposals.proxy_toast.set_description', { proxy })
          : t('proposals.proxy_toast.cleared_description'),
        variant: 'success'
      });
      scheduleInvalidations(queryClient, [['loggedUserAccount', username]]);
    },
    onError: (error: unknown, variables) => {
      handleError(error, { method: 'useProxyMutation', params: variables });
    }
  });
}
