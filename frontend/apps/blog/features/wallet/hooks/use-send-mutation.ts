import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { logger } from '@ui/lib/logger';

export interface SendParams {
  fromAccount: string;
  toAccount: string;
  memo: string;
  amount: asset;
}

/**
 * Real HIVE/HBD transfer — builds and broadcasts a transfer_operation through
 * transactionService, which signs it with whatever signer the app is
 * configured with (Keychain / HiveAuth / HiveSigner / password), exactly
 * like the vote and reblog flows already do.
 */
export function useSendMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: SendParams) => {
      const { amount, fromAccount, memo, toAccount } = params;
      const broadcastResult = await transactionService.transfer(amount, fromAccount, memo, toAccount, {
        observe: true
      });
      logger.info('Wallet: transfer broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['walletAccountData', data.fromAccount] });
      queryClient.invalidateQueries({ queryKey: ['accountHistory', data.fromAccount] });
    }
  });
}
