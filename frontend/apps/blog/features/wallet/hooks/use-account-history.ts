import { useQuery } from '@tanstack/react-query';
import { getChain } from '@transaction/lib/chain';
import type { HiveOperation } from '@hive/common-hiveio-packages/wax';
import { WALLET_HISTORY_OPERATION_NAMES } from '../lib/account-history';

/** One page is enough for a "Recent activity" card — the full-history link
 * (see getTransfersUrl) is where someone goes for more than this. */
export const HISTORY_PAGE_SIZE = 25;

export interface WalletHistoryPage {
  operations: HiveOperation[];
  totalOperations: number;
}

/**
 * Real on-chain wallet activity for `username`, via two REST calls — the
 * same two apps/wallet's pre-Lumen account-history feed made (see
 * apps/wallet/lib/hive.ts `getAccountOperations`):
 *
 *  1. hafah-api/operation-types, to resolve the numeric op_type_ids the
 *     hivemind filter wants (they're not stable enough to hardcode).
 *  2. hivemind-api/accounts/{name}/operations, filtered to just the wallet-
 *     relevant types, so posting/voting activity doesn't crowd out transfers.
 *
 * Both are real Hive REST APIs (not condenser JSON-RPC), so they hang off
 * `chain.restApi` — the same access pattern
 * packages/transaction/lib/hivesense-api.ts already uses in this app for the
 * AI-search endpoint.
 */
export function useAccountHistory(username: string) {
  return useQuery<WalletHistoryPage>({
    queryKey: ['walletAccountHistory', username],
    queryFn: async () => {
      const chain = await getChain();
      const opTypes = await chain.restApi['hafah-api']['operation-types']();
      const operationTypeIds = WALLET_HISTORY_OPERATION_NAMES.map(
        (name) => opTypes.find((opType) => opType.operation_name === name)?.op_type_id
      )
        .filter((id): id is number => id !== undefined)
        .join(',');

      const response = await chain.restApi['hivemind-api'].accountsOperations({
        'account-name': username,
        'page-size': HISTORY_PAGE_SIZE,
        'operation-types': operationTypeIds,
        'observer-name': username
      });

      return { operations: response.operations_result, totalOperations: response.total_operations };
    },
    enabled: !!username,
    refetchInterval: 60_000
  });
}
