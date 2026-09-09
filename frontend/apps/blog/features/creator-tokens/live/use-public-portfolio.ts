'use client';

/**
 * Read-only copy of features/creator-tokens/live/use-live-portfolio.ts,
 * narrowed to the ONE read it makes that a public wallet page needs: what a
 * single account holds.
 *
 * WHAT WAS REMOVED AND WHY. use-live-portfolio.ts answers for the signed-in
 * reader across every wallet they hold under (session-only useTokenAccounts,
 * D5/D11), carries reclaim/rate mutations, and fans out the asks read. None of
 * that belongs on someone else's wallet page: D3 excludes asks from the
 * public Meritum tab, and S1 forbids any mutation on a read-only page. This
 * hook takes the account id as a plain argument instead, makes the one
 * wallet read, and stops there.
 */

import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { HolderPosition } from '../types';

// Identical string to use-live-portfolio.ts's walletKey, so this hook shares
// the same cache entry as the private one for the same account.
const walletKey = (holder: string) => ['creatorTokens', 'live', 'wallet', holder];

const STALE_MS = 15_000;
const REFETCH_MS = 30_000;

export interface PublicPortfolio {
  /** No contract provisioned in this build. */
  unavailable: boolean;
  isLoading: boolean;
  /** TRUE = the indexer could not be reached. Distinct from an empty list, and the caller must say which. */
  holdingsUnavailable: boolean;
  holdings: HolderPosition[];
}

/**
 * One account's Meritum holdings, by account id (a bare Hive name; the data
 * source prefixes `hive:` itself, same as the private hook). `enabled` is
 * false for a lite target, whose wallet DIDs are never resolved on this page
 * (D4).
 */
export function usePublicPortfolio(accountId: string, enabled: boolean): PublicPortfolio {
  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;
  const readEnabled = enabled && !unavailable && accountId.length > 0;

  const query = useQuery({
    queryKey: walletKey(accountId),
    queryFn: () => {
      if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
      return dataSource.readWallet(accountId);
    },
    enabled: readEnabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });

  return {
    unavailable,
    isLoading: readEnabled && query.isLoading,
    holdingsUnavailable: query.isError || Boolean(query.data?.unavailable),
    holdings: query.data?.positions ?? []
  };
}
