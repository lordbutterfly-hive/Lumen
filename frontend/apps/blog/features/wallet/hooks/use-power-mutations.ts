import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { createAsset } from '@transaction/lib/utils';
import { logger } from '@ui/lib/logger';

const invalidate = (queryClient: ReturnType<typeof useQueryClient>, username: string) => {
  queryClient.invalidateQueries({ queryKey: ['walletAccountData', username] });
  queryClient.invalidateQueries({ queryKey: ['accountHistory', username] });
};

/** Stake: liquid HIVE -> Hive Power (transfer_to_vesting_operation). */
export function usePowerUpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { fromAccount: string; toAccount: string; amount: asset }) => {
      const { amount, fromAccount, toAccount } = params;
      const broadcastResult = await transactionService.transferToVesting(amount, fromAccount, toAccount, {
        observe: true
      });
      logger.info('Wallet: power up broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => invalidate(queryClient, data.fromAccount)
  });
}

/** Unstake: schedules a 13-week Hive Power withdrawal (withdraw_vesting_operation). */
export function usePowerDownMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { account: string; hp: asset }) => {
      const { account, hp } = params;
      const broadcastResult = await transactionService.withdrawFromVesting(account, hp, { observe: true });
      logger.info('Wallet: power down broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => invalidate(queryClient, data.account)
  });
}

/** STOP: cancels an active power down by re-issuing withdraw_vesting_operation with 0 HP. */
export function useCancelPowerDownMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: { account: string }) => {
      const { account } = params;
      const zeroHp = await createAsset('0', 'HIVE');
      const broadcastResult = await transactionService.withdrawFromVesting(account, zeroHp, { observe: true });
      logger.info('Wallet: cancel power down broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => invalidate(queryClient, data.account)
  });
}
