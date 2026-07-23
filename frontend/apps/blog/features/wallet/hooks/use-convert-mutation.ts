import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { logger } from '@ui/lib/logger';
import { broadcastRawOperation } from '../lib/broadcast-raw-operation';

export interface ConvertParams {
  owner: string;
  amount: asset;
}

/**
 * Convert HBD -> HIVE (convert_operation). Locks the HBD and pays out HIVE at
 * the 3.5-day market-median price. TransactionService doesn't have a typed
 * helper for this op, so it's built directly via broadcastRawOperation —
 * still real signing + real broadcast through the same signer as every other
 * button on this page, just without an extra wrapper in the shared package.
 */
export function useConvertMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: ConvertParams) => {
      const { owner, amount } = params;
      const requestid = Math.floor((Date.now() / 1000) % 4294967295);
      const broadcastResult = await broadcastRawOperation(
        (builder) => {
          builder.pushOperation({
            convert_operation: { owner, requestid, amount }
          });
        },
        { observe: true }
      );
      logger.info('Wallet: convert broadcast: %o', { params, requestid, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['walletAccountData', data.owner] });
      queryClient.invalidateQueries({ queryKey: ['accountHistory', data.owner] });
    }
  });
}
