import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { logger } from '@ui/lib/logger';

/** Delegate HP to another account (delegate_vesting_shares_operation). Amount 0 revokes it. */
export function useDelegateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { delegator: string; delegatee: string; hp: asset }) => {
      const { delegatee, delegator, hp } = params;
      const broadcastResult = await transactionService.delegateVestingShares(delegator, delegatee, hp, {
        observe: true
      });
      logger.info('Wallet: delegate broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['vestingDelegations', data.delegator] });
      queryClient.invalidateQueries({ queryKey: ['walletAccountData', data.delegator] });
    }
  });
}
