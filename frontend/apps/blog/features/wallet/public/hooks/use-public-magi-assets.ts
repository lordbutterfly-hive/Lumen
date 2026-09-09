'use client';

/**
 * Read-only copy of features/wallet/hooks/use-magi-assets.ts, narrowed to one
 * account instead of every account a signed-in reader holds under.
 *
 * WHAT WAS REMOVED AND WHY. The private hook resolves ITS OWN list of
 * accounts through useTokenAccounts(), a session-only hook that answers "who
 * is looking" (D5 in the build map). This page answers "whose wallet is in
 * the URL", so it takes one account id as a plain argument instead, and never
 * touches useTokenAccounts, refetchAll, or any of the wallet-identity
 * plumbing. There is also no invalidateQueries/refetchAll here: a read-only
 * page never writes, so nothing ever needs to invalidate these queries.
 *
 * WHY NOT IMPORT use-magi-assets.ts (D11). That file imports useTokenAccounts,
 * which transitively imports the session-only DID lookup. Importing even a
 * named export from a module that does that pulls the whole graph in at
 * module-load time, so this hook duplicates the two one-line query-key
 * builders instead, byte-for-byte the same strings, so the two hooks still
 * share one cache entry per account without one importing the other.
 */

import { useQuery } from '@tanstack/react-query';
import { readMagiAssets, toMagiAccountId, type MagiAssets } from '@/blog/lib/lite/wallet/magi-assets';
import { getMagiBtcMappingContractId, readMagiBtcBalance } from '@/blog/lib/lite/wallet/magi-btc-balance';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';

// Identical strings to use-magi-assets.ts's magiAssetsKey/magiBtcKey, so the
// two hooks address the SAME cache entry for the same account without one
// importing the other.
const magiAssetsKey = (account: string) => ['wallet', 'magiAssets', toMagiAccountId(account)] as const;
const magiBtcKey = (account: string) => ['wallet', 'magiBtc', toMagiAccountId(account)] as const;

const STALE_MS = 20_000;
const REFETCH_MS = 45_000;

export interface PublicMagiAssetsState {
  /** No Magi endpoint is configured in this build; nothing can be read. */
  unavailable: boolean;
  /** No BTC mapping contract id configured; the Bitcoin row cannot be read. */
  btcUnavailable: boolean;
  /** Null until resolved or when the read failed; check the flags. */
  assets: MagiAssets | null;
  assetsLoading: boolean;
  assetsFailed: boolean;
  /** Null until resolved, when the read failed, or when no mapping contract is configured. */
  btcSats: bigint | null;
  btcLoading: boolean;
  btcFailed: boolean;
}

/**
 * One Magi account's balances, by account id. `enabled` gates both reads at
 * once: false for a lite target, whose wallet DIDs are never resolved on this
 * page (D4).
 */
export function usePublicMagiAssets(accountId: string, enabled: boolean): PublicMagiAssetsState {
  const config = getCreatorTokensConfig();
  const unavailable = config === null;
  const btcContractId = getMagiBtcMappingContractId();
  const readsEnabled = enabled && !unavailable && accountId.length > 0;

  const assetsQuery = useQuery({
    queryKey: magiAssetsKey(accountId),
    queryFn: () => readMagiAssets(accountId),
    enabled: readsEnabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    retry: 1
  });

  const btcQuery = useQuery({
    queryKey: magiBtcKey(accountId),
    queryFn: () => readMagiBtcBalance(btcContractId ?? '', accountId),
    enabled: readsEnabled && btcContractId !== null,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    retry: 1
  });

  return {
    unavailable,
    btcUnavailable: btcContractId === null,
    assets: assetsQuery.data ?? null,
    assetsLoading: readsEnabled && assetsQuery.isLoading,
    assetsFailed: assetsQuery.isError,
    btcSats: btcQuery.data ?? null,
    btcLoading: readsEnabled && btcContractId !== null && btcQuery.isLoading,
    btcFailed: btcQuery.isError
  };
}
