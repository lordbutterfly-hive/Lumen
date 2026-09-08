'use client';

/**
 * Send HBD, HIVE or BTC from one Magi account to another. Altera's send, on
 * the Magi tab: the ops are lib/magi-ops.ts (Altera's builders), the signing is
 * lib/magi-rails.ts (Altera's per-login dispatch). Resolves only on a terminal
 * chain status.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { logger } from '@ui/lib/logger';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { getMagiBtcMappingContractId } from '@/blog/lib/lite/wallet/magi-btc-balance';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { broadcastMagiCall, broadcastMagiTransfer, type MagiRailPhase, type MagiRailResult } from '../lib/magi-rails';
import { magiBtcTransferCustomJson, type MagiSendAsset } from '../lib/magi-ops';
import { magiAssetsKey, magiBtcKey } from './use-magi-assets';

export interface MagiSendParams {
  account: TokenAccount;
  asset: MagiSendAsset;
  /** Resolved recipient id: `hive:<name>` or `did:pkh:…`. */
  to: string;
  /** HBD/HIVE: three-decimal string. BTC: satoshis, integer string. */
  amount: string;
  memo?: string;
}

/** Balances are re-read on a schedule after confirmation; the indexer lags the node by a block or two. */
const RECHECK_DELAYS_MS = [3_000, 10_000, 30_000];

export function useMagiSendMutation() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<MagiRailPhase | null>(null);

  const mutation = useMutation({
    mutationFn: async (params: MagiSendParams): Promise<MagiSendParams & MagiRailResult> => {
      const config = getCreatorTokensConfig();
      if (!config) throw new Error('Magi is not configured on this build.');
      const from = toMagiAccountId(params.account.id);
      let result: MagiRailResult;
      if (params.asset === 'BTC') {
        const contractId = getMagiBtcMappingContractId();
        if (!contractId) throw new Error('The Bitcoin mapping contract is not configured on this build.');
        const op = magiBtcTransferCustomJson({ caller: from, to: params.to, sats: params.amount, contractId, netId: config.netId });
        result = await broadcastMagiCall(params.account, op, { onPhase: setPhase });
      } else {
        result = await broadcastMagiTransfer(
          params.account,
          { from, to: params.to, amount: params.amount, asset: params.asset === 'HBD' ? 'hbd' : 'hive', memo: params.memo, netId: config.netId },
          { onPhase: setPhase }
        );
      }
      logger.info('Wallet: Magi send: %o', { from, to: params.to, asset: params.asset, amount: params.amount, ...result });
      return { ...params, ...result };
    },
    onSettled: () => setPhase(null),
    onSuccess: (data) => {
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: magiAssetsKey(data.account.id) });
        void queryClient.invalidateQueries({ queryKey: magiBtcKey(data.account.id) });
        void queryClient.invalidateQueries({ queryKey: magiAssetsKey(data.to) });
        void queryClient.invalidateQueries({ queryKey: magiBtcKey(data.to) });
      };
      refresh();
      for (const delay of RECHECK_DELAYS_MS) window.setTimeout(refresh, delay);
    }
  });

  return { ...mutation, phase };
}
