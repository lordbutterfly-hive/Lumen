'use client';

/**
 * Every Magi account the signed-in reader holds under, with its balances.
 *
 * WHICH ACCOUNTS: `useTokenAccounts` (creator-tokens) is the one source of that
 * answer in this app: `hive:<name>` for a full account, one `did:pkh` per bound
 * wallet for a lite account, never merged (use-token-accounts.ts:21-28). This
 * hook fans out two reads per account, the ledger record (HBD, sHBD, HIVE,
 * staked HIVE, unstaking) and the BTC mapping balance, the way
 * use-live-portfolio.ts fans out holdings per account.
 *
 * ★ FAILED IS NOT ZERO. Each read keeps `failed` distinct from a real zero so
 * the panel can say "couldn't check" instead of "you have nothing"
 * (magi-balance.ts:26-29, the rule every Magi read in this app follows).
 *
 * Timing mirrors use-magi-spending-power.ts:115-116 (stale 20s, refetch 45s).
 * Keys are exported so a write (a deposit) can invalidate them.
 */

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTokenAccounts, type TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { readMagiAssets, toMagiAccountId, type MagiAssets } from '@/blog/lib/lite/wallet/magi-assets';
import { getMagiBtcMappingContractId, readMagiBtcBalance } from '@/blog/lib/lite/wallet/magi-btc-balance';

export const magiAssetsKey = (account: string) => ['wallet', 'magiAssets', toMagiAccountId(account)] as const;
export const magiBtcKey = (account: string) => ['wallet', 'magiBtc', toMagiAccountId(account)] as const;

const STALE_MS = 20_000;
const REFETCH_MS = 45_000;

export interface MagiAccountAssets {
  account: TokenAccount;
  /** Null until resolved or when the read failed; check the flags. */
  assets: MagiAssets | null;
  assetsLoading: boolean;
  assetsFailed: boolean;
  /** Null until resolved, when the read failed, or when no mapping contract is configured. */
  btcSats: bigint | null;
  btcLoading: boolean;
  btcFailed: boolean;
}

export interface MagiAssetsState {
  /** No Magi endpoint is configured in this build; nothing can be read. */
  unavailable: boolean;
  /** No BTC mapping contract id configured; the Bitcoin row cannot be read. */
  btcUnavailable: boolean;
  accounts: MagiAccountAssets[];
  /** The wallet-identity lookup has not answered yet. Distinct from "no accounts". */
  accountsLoading: boolean;
  /** The wallet-identity lookup itself failed. NOT "no accounts". */
  accountsFailed: boolean;
  /** False only for a Google-only lite account: no keypair, no Magi account. */
  canHold: boolean;
  /** Re-read every balance now (after a deposit). */
  refetchAll: () => void;
}

export function useMagiAssets(): MagiAssetsState {
  const queryClient = useQueryClient();
  const config = getCreatorTokensConfig();
  const unavailable = config === null;
  const btcContractId = getMagiBtcMappingContractId();
  const tokenAccounts = useTokenAccounts();
  const accounts = tokenAccounts.accounts;

  const assetQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: magiAssetsKey(a.id),
      queryFn: () => readMagiAssets(a.id),
      enabled: !unavailable,
      staleTime: STALE_MS,
      refetchInterval: REFETCH_MS,
      retry: 1
    }))
  });

  const btcQueries = useQueries({
    queries: accounts.map((a) => ({
      queryKey: magiBtcKey(a.id),
      queryFn: () => readMagiBtcBalance(btcContractId ?? '', a.id),
      enabled: !unavailable && btcContractId !== null,
      staleTime: STALE_MS,
      refetchInterval: REFETCH_MS,
      retry: 1
    }))
  });

  const refetchAll = useCallback(() => {
    for (const a of accounts) {
      void queryClient.invalidateQueries({ queryKey: magiAssetsKey(a.id) });
      void queryClient.invalidateQueries({ queryKey: magiBtcKey(a.id) });
    }
  }, [accounts, queryClient]);

  return {
    unavailable,
    btcUnavailable: btcContractId === null,
    accounts: accounts.map((account, i) => {
      const aq = assetQueries[i];
      const bq = btcQueries[i];
      return {
        account,
        assets: aq?.data ?? null,
        assetsLoading: !unavailable && Boolean(aq?.isLoading),
        assetsFailed: Boolean(aq?.isError),
        btcSats: bq?.data ?? null,
        btcLoading: !unavailable && btcContractId !== null && Boolean(bq?.isLoading),
        btcFailed: Boolean(bq?.isError)
      };
    }),
    accountsLoading: tokenAccounts.isLoading,
    accountsFailed: tokenAccounts.failed,
    canHold: tokenAccounts.canHold,
    refetchAll
  };
}
