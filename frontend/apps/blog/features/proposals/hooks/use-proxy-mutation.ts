'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { scheduleInvalidations } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

/**
 * Sets (or clears, with proxy = '') the account_witness_proxy_operation.
 * A single proxy setting delegates BOTH witness votes and proposal votes — see the
 * wax type doc on account_witness_proxy: "{proxy} will also vote for proposals in
 * the name of {account}." Reuses transactionService.witnessProxy, the same builder
 * a future Vote Witness page would use, so this isn't a proposals-only shortcut.
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
      await transactionService.witnessProxy(proxy, { observe: true });
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
