import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { logger } from '@ui/lib/logger';

const invalidate = (queryClient: ReturnType<typeof useQueryClient>, username: string) => {
  queryClient.invalidateQueries({ queryKey: ['walletAccountData', username] });
  queryClient.invalidateQueries({ queryKey: ['accountHistory', username] });
};

export interface SavingsTransferParams {
  fromAccount: string;
  toAccount: string;
  memo: string;
  amount: asset;
}

/** Deposit: moves HIVE or HBD into savings (transfer_to_savings_operation). */
export function useSavingsDepositMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: SavingsTransferParams) => {
      const { amount, fromAccount, memo, toAccount } = params;
      const broadcastResult = await transactionService.transferToSavings(amount, fromAccount, memo, toAccount, {
        observe: true
      });
      logger.info('Wallet: savings deposit broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => invalidate(queryClient, data.fromAccount)
  });
}

export interface SavingsWithdrawParams extends SavingsTransferParams {
  requestId: number;
}

/**
 * Withdraw: requests HIVE or HBD out of savings (transfer_from_savings_operation).
 * Clears after Hive's fixed 3-day security delay — there's no way to skip that
 * from the client, this just files the request.
 */
export function useSavingsWithdrawMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: SavingsWithdrawParams) => {
      const { amount, fromAccount, memo, toAccount, requestId } = params;
      const broadcastResult = await transactionService.transferFromSavings(
        amount,
        fromAccount,
        memo,
        toAccount,
        requestId,
        { observe: true }
      );
      logger.info('Wallet: savings withdraw broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => invalidate(queryClient, data.fromAccount)
  });
}
