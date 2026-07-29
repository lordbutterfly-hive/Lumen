'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getLogger } from '@ui/lib/logging';
import { useTranslation } from '@/blog/i18n/client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';

const logger = getLogger('app');

/**
 * Broadcasts a real `account_witness_proxy_operation`, signed through the
 * shared smart-signer session. Passing an empty string clears an existing
 * proxy (matches Hive's own semantics for this operation).
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
      const broadcastResult = await transactionService.witnessProxy(proxy, { observe: true });
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
