'use client';

/**
 * Withdraw from Magi: HBD / HIVE to a Hive L1 account (`vsc.withdraw` or the
 * container `withdraw` op), or BTC to a Bitcoin address (the mapping
 * contract's `unmap`). Altera's withdraw, on the Magi tab.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { logger } from '@ui/lib/logger';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { getMagiBtcMappingContractId } from '@/blog/lib/lite/wallet/magi-btc-balance';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { broadcastMagiCall, broadcastMagiWithdraw, type MagiRailPhase, type MagiRailResult } from '../lib/magi-rails';
import { magiBtcUnmapCustomJson, type MagiSendAsset } from '../lib/magi-ops';
import { magiAssetsKey, magiBtcKey } from './use-magi-assets';

export interface MagiWithdrawParams {
  account: TokenAccount;
  asset: MagiSendAsset;
  /** HBD/HIVE: `hive:<name>`. BTC: a raw Bitcoin address. */
  to: string;
  /** HBD/HIVE: three-decimal string. BTC: satoshis, integer string. */
  amount: string;
}

/** The gateway pays out on L1 after the block is anchored; the Hive balance lags the Magi one. */
const RECHECK_DELAYS_MS = [8_000, 25_000, 60_000, 120_000];

export function useMagiWithdrawMutation() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<MagiRailPhase | null>(null);

  const mutation = useMutation({
    mutationFn: async (params: MagiWithdrawParams): Promise<MagiWithdrawParams & MagiRailResult> => {
      const config = getCreatorTokensConfig();
      if (!config) throw new Error('Magi is not configured on this build.');
      const from = toMagiAccountId(params.account.id);
      let result: MagiRailResult;
      if (params.asset === 'BTC') {
        const contractId = getMagiBtcMappingContractId();
        if (!contractId) throw new Error('The Bitcoin mapping contract is not configured on this build.');
        const op = magiBtcUnmapCustomJson({ caller: from, to: params.to, sats: params.amount, contractId, netId: config.netId });
        result = await broadcastMagiCall(params.account, op, { onPhase: setPhase });
      } else {
        result = await broadcastMagiWithdraw(
          params.account,
          { from, to: params.to, amount: params.amount, asset: params.asset === 'HBD' ? 'hbd' : 'hive', netId: config.netId },
          { onPhase: setPhase }
        );
      }
      logger.info('Wallet: Magi withdraw: %o', { from, to: params.to, asset: params.asset, amount: params.amount, ...result });
      return { ...params, ...result };
    },
    onSettled: () => setPhase(null),
    onSuccess: (data) => {
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: magiAssetsKey(data.account.id) });
        void queryClient.invalidateQueries({ queryKey: magiBtcKey(data.account.id) });
        void queryClient.invalidateQueries({ queryKey: ['wallet', 'magiL1Balances'] });
        if (data.account.kind === 'hive') {
          void queryClient.invalidateQueries({ queryKey: ['walletSummary', data.account.id] });
          void queryClient.invalidateQueries({ queryKey: ['accountHistory', data.account.id] });
        }
      };
      refresh();
      for (const delay of RECHECK_DELAYS_MS) window.setTimeout(refresh, delay);
    }
  });

  return { ...mutation, phase };
}
