'use client';

/**
 * Deposit HIVE or HBD from the Hive account onto Magi.
 *
 * THE MECHANISM IS ALTERA'S, VERBATIM (altera-app/src/lib/magiTransactions/hive/
 * vscOperations/deposit.ts:13-31): an ordinary Hive `transfer` to the gateway
 * account with the memo `to=<account>`, where `<account>` is the last segment of
 * the Magi account id (`hive:alice` -> `alice`). The gateway is a real Hive account
 * run by the VSC consensus and credits the named Magi account once the block is
 * processed. Signed with the ACTIVE key (Altera: aioha KeyTypes.Active) on the
 * chain the Magi network reads (lib/magi-l1-broadcast.ts).
 */
import env from '@beam-australia/react-env';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getAsset } from '@transaction/lib/utils';
import { logger } from '@ui/lib/logger';
import { broadcastMagiL1 } from '../lib/magi-l1-broadcast';
import { magiAssetsKey } from './use-magi-assets';

/** The Magi gateway account (same env the fuel gauge's funding help reads). */
export const MAGI_GATEWAY_ACCOUNT = env('MAGI_GATEWAY_ACCOUNT') || 'vsc.gateway';

/** Altera's default deposit memo: `to=<last segment of the DID>`. For `hive:alice` that is `to=alice`. */
export function magiDepositMemo(magiAccountId: string): string {
  const segment = magiAccountId.split(':').at(-1) ?? magiAccountId;
  return `to=${segment}`;
}

export interface MagiDepositParams {
  username: string;
  currency: 'HIVE' | 'HBD';
  /** Decimal string with at most 3 places, e.g. "12.500". */
  amount: string;
}

/** Moments after broadcast at which the Magi balance is re-read; the gateway credits after the block is processed, not instantly. */
const RECHECK_DELAYS_MS = [8_000, 25_000, 60_000, 120_000];

export function useMagiDepositMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, currency, amount }: MagiDepositParams) => {
      const asset = await getAsset(amount, currency);
      const memo = magiDepositMemo(`hive:${username}`);
      const result = await broadcastMagiL1(username, (tx) => {
        tx.pushOperation({
          transfer_operation: { from: username, to: MAGI_GATEWAY_ACCOUNT, amount: asset, memo }
        });
      });
      logger.info('Wallet: Magi deposit broadcast: %o', { username, currency, amount, memo, result });
      return { username, currency, amount, transactionId: result.transactionId };
    },
    onSuccess: (data) => {
      for (const delay of RECHECK_DELAYS_MS) {
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: magiAssetsKey(data.username) });
        }, delay);
      }
      void queryClient.invalidateQueries({ queryKey: ['walletSummary', data.username] });
      void queryClient.invalidateQueries({ queryKey: ['accountHistory', data.username] });
      void queryClient.invalidateQueries({ queryKey: ['wallet', 'magiL1Balances'] });
    }
  });
}
