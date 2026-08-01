import { ApiAccount } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getLogger } from '@ui/lib/logging';
import { FullAccount } from '@hive/common-hiveio-packages/wax';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
const logger = getLogger('app');

/**
 * Makes claim reward transaction.
 *
 * @export
 * @return {*}
 */
export function useClaimRewardsMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const queryKey = ['profileData', user.username];
  const claimRewardMutation = useMutation({
    mutationFn: async (params: { account: ApiAccount }) => {
      // The ONLY wallet-adjacent action that had no tier check of any kind.
      // It is hard to reach today only because a lite handle is not a real Hive
      // account, so the bridge API returns no reward data to claim — an
      // accident of routing, not a gate. Claiming rewards is a chain operation
      // with no Lumen-local equivalent, so it refuses rather than forks.
      refuseIfLite(user.account_tier, 'Claiming rewards needs a full Hive account.');
      const { account } = params;

      const broadcstResult = await transactionService.claimRewards(account, { observe: true });
      const prevData: FullAccount | undefined = queryClient.getQueryData(queryKey);
      const response = { ...params, broadcstResult, prevData };

      logger.info('Done claim reward tranasaction: %o', response);
      return response;
    },
    onSettled: (data) => {
      if (!data) return;
      const { prevData } = data;
      if (prevData) {
        queryClient.setQueryData(queryKey, () => ({
          ...prevData,
          reward_hbd_balance: { amount: '0', nai: '@@000000013', precision: 3 },
          reward_hive_balance: { amount: '0', nai: '@@000000021', precision: 3 },
          reward_vesting_hive: { amount: '0', nai: '@@000000021', precision: 3 }
        }));
      }
    },
    onSuccess: () => {
      toast({
        title: 'Claim rewards',
        description: 'Your rewards have been claimed successfully.',
        variant: 'success'
      });
      // Invalidate after 60s — the API will have caught up by then.
      // Until then, the component uses claimedBalances to suppress stale data.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey });
      }, 60000);
    },
    onError: (error: any, variables) => {
      handleError(error, {
        method: 'useClaimRewardsMutation',
        params: variables
      });
    }
  });

  return claimRewardMutation;
}
