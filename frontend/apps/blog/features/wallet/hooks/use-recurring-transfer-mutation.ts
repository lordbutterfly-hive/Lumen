import { asset } from '@hiveio/wax';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { logger } from '@ui/lib/logger';
import { broadcastRawOperation } from '../lib/broadcast-raw-operation';

export interface RecurringTransferParams {
  from: string;
  to: string;
  amount: asset;
  memo: string;
  /** Hours between payments; chain minimum is 24. */
  recurrence: number;
  /** Total number of payments; chain minimum is 2. */
  executions: number;
}

/**
 * Schedules an automatic repeating transfer (recurrent_transfer_operation).
 * Same reasoning as useConvertMutation: no typed helper exists yet in
 * TransactionService for this op, so it's built directly via
 * broadcastRawOperation, still going through the real signer.
 */
export function useRecurringTransferMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: RecurringTransferParams) => {
      const { from, to, amount, memo, recurrence, executions } = params;
      const broadcastResult = await broadcastRawOperation(
        (builder) => {
          builder.pushOperation({
            recurrent_transfer_operation: { from, to, amount, memo, recurrence, executions, extensions: [] }
          });
        },
        { observe: true }
      );
      logger.info('Wallet: recurring transfer broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['walletAccountData', data.from] });
      queryClient.invalidateQueries({ queryKey: ['accountHistory', data.from] });
    }
  });
}
