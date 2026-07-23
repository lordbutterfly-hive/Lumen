'use client';

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getMarketDataSource } from './lib/market-data-source';

const ROUND_KEY = ['predictionMarket', 'round'] as const;
const positionKey = (roundId?: string, username?: string) => ['predictionMarket', 'position', roundId, username];

// Live-ish: the pool totals and countdown move, so poll like a ticker.
const REFETCH_MS = 15_000;
const STALE_MS = 10_000;
// After a bet/claim, reconcile the optimistic position against real on-chain
// state promptly rather than waiting up to a full poll interval.
const RECONCILE_MS = 4_000;

/**
 * Single hook every market component uses. Both MarketWidget (always mounted in
 * the right rail) and MarketTab call this with the same ROUND_KEY, so react-query
 * dedupes the fetch — the widget primes the cache, opening the tab reads instantly.
 */
export function useMarket() {
  const queryClient = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const dataSource = getMarketDataSource();
  // null data source ⇒ the market is not provisioned. Surface this as a distinct
  // state so the UI renders "not available yet", never a bettable fake round.
  const isAvailable = dataSource !== null;

  // Reconcile the optimistic post-bet/claim position against confirmed on-chain
  // state shortly after the mutation resolves (backstop: positionQuery's poll).
  const scheduleReconcile = useCallback(
    (roundId: string) => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: positionKey(roundId, user.username) });
      }, RECONCILE_MS);
    },
    [queryClient, user.username]
  );

  const roundQuery = useQuery({
    queryKey: ROUND_KEY,
    queryFn: () => (dataSource ? dataSource.readRound() : Promise.resolve(null)),
    enabled: isAvailable,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });
  const round = roundQuery.data ?? null;

  const positionQuery = useQuery({
    queryKey: positionKey(round?.roundId, user.username),
    queryFn: () => (dataSource && round ? dataSource.readMyPosition(round.roundId, user.username) : Promise.resolve(null)),
    enabled: isAvailable && Boolean(round?.roundId) && loggedIn,
    staleTime: STALE_MS,
    // placeBet/claim return an OPTIMISTIC position (L1-accepted, not L2-executed).
    // Without a poll that optimistic number could persist indefinitely even if L2
    // rejected — poll on the round cadence so real on-chain state reconciles it.
    refetchInterval: REFETCH_MS
  });

  const placeBetMutation = useMutation({
    mutationFn: (input: { bucketId: string; amount: number }) => {
      if (!dataSource || !round) return Promise.reject(new Error('No active round'));
      return dataSource.placeBet({ ...input, roundId: round.roundId, username: user.username });
    },
    onSuccess: (position) => {
      queryClient.invalidateQueries({ queryKey: ROUND_KEY });
      queryClient.setQueryData(positionKey(position.roundId, user.username), position);
      scheduleReconcile(position.roundId);
    }
  });

  const claimMutation = useMutation({
    mutationFn: () => {
      if (!dataSource || !round) return Promise.reject(new Error('No active round'));
      return dataSource.claim({ roundId: round.roundId, username: user.username });
    },
    onSuccess: (position) => {
      queryClient.setQueryData(positionKey(position.roundId, user.username), position);
      scheduleReconcile(position.roundId);
    }
  });

  return {
    round,
    isUnavailable: !isAvailable,
    isLoading: isAvailable && roundQuery.isLoading,
    isError: roundQuery.isError,
    refetch: roundQuery.refetch,
    myPosition: positionQuery.data ?? null,
    loggedIn,
    placeBet: useCallback(
      (bucketId: string, amount: number) => placeBetMutation.mutateAsync({ bucketId, amount }),
      [placeBetMutation]
    ),
    isPlacingBet: placeBetMutation.isLoading,
    claim: useCallback(() => claimMutation.mutateAsync(), [claimMutation]),
    isClaiming: claimMutation.isLoading
  };
}
