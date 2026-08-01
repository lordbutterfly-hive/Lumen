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
// The chart's history only grows at the tail, and it comes from an indexer that
// lags the chain anyway — polling it on the ticker cadence would be pure waste.
const SERIES_STALE_MS = 60_000;
const SERIES_REFETCH_MS = 120_000;

/**
 * Single hook every market component uses. Both MarketWidget (always mounted in
 * the right rail) and MarketTab call this with the same ROUND_KEY, so react-query
 * dedupes the fetch — the widget primes the cache, opening the tab reads instantly.
 */
export function useMarket() {
  const queryClient = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  // A keyless Lumen account: it can read the market but cannot sign anything.
  const isLite = user.account_tier === 'lite';
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

  // The chart's history. Kept as its own query rather than folded into
  // readRound() so a slow or dead indexer can never delay the round itself —
  // the numbers people bet on come from chain state and must render regardless.
  // Polled far more slowly than the round: a bet only shifts the tail of it.
  const seriesQuery = useQuery({
    queryKey: ['predictionMarket', 'poolSeries', round?.roundId, round?.buckets.length],
    queryFn: () =>
      dataSource && round ? dataSource.readPoolSeries(round.roundId, round.buckets.length) : Promise.resolve(null),
    enabled: isAvailable && Boolean(round?.roundId),
    staleTime: SERIES_STALE_MS,
    refetchInterval: SERIES_REFETCH_MS
  });

  const placeBetMutation = useMutation({
    mutationFn: (input: { bucketId: string; amount: number }) => {
      if (!dataSource || !round) return Promise.reject(new Error('No active round'));
      // F-P11 — the ONLY lite gate on betting was `disabled` on the submit
      // button (bet-form.tsx). Its two siblings below refuse inside the
      // mutation; this one did not, so any path that reaches placeBet without
      // that button — a keyboard submit on a re-enabled form, a stale render,
      // any future caller of the returned placeBet() — handed a keyless account
      // to a signer it has no key for and surfaced a raw error. A render-only
      // tier gate is not a gate (F-L22 family).
      if (isLite) return Promise.reject(new Error('Placing a bet needs a full Hive account. Upgrade to bet.'));
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
      // A keyless Lumen account cannot sign. Bet was already gated; Claim was
      // not, so a lite user with a resolved position saw a fully enabled Claim
      // button that threw a raw error. There is no Lumen-local equivalent — the
      // payout is on chain — so this refuses with a sentence instead.
      if (isLite) return Promise.reject(new Error('Claiming a payout needs a full Hive account. Upgrade to claim.'));
      // F-P9: defense-in-depth behind the now-gated button — a settled position that
      // won nothing has no on-chain payout, so refuse rather than broadcast a Claim the
      // contract will reject.
      if (positionQuery.data && !positionQuery.data.claimable) {
        return Promise.reject(new Error('This round settled with no payout for your position.'));
      }
      return dataSource.claim({ roundId: round.roundId, username: user.username });
    },
    onSuccess: (position) => {
      queryClient.setQueryData(positionKey(position.roundId, user.username), position);
      scheduleReconcile(position.roundId);
    }
  });

  // The fail-safe. Offered only when the position says the round is genuinely
  // stuck past its deadline — see MyPosition.reclaimable, derived from the same
  // rule market/reclaim.go enforces.
  const reclaimMutation = useMutation({
    mutationFn: () => {
      if (!dataSource || !round) return Promise.reject(new Error('No active round'));
      if (isLite) return Promise.reject(new Error('Reclaiming a stake needs a full Hive account. Upgrade to reclaim.'));
      return dataSource.reclaim({ roundId: round.roundId, username: user.username });
    },
    onSuccess: (position) => {
      queryClient.setQueryData(positionKey(position.roundId, user.username), position);
      // A reclaim VOIDS the round, so the round itself changed too — not just
      // this account's position.
      queryClient.invalidateQueries({ queryKey: ROUND_KEY });
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
    // null ⇒ no usable history; the caller draws the labelled placeholder.
    poolSeries: seriesQuery.data ?? null,
    loggedIn,
    placeBet: useCallback(
      (bucketId: string, amount: number) => placeBetMutation.mutateAsync({ bucketId, amount }),
      [placeBetMutation]
    ),
    isPlacingBet: placeBetMutation.isLoading,
    claim: useCallback(() => claimMutation.mutateAsync(), [claimMutation]),
    isClaiming: claimMutation.isLoading,
    reclaim: useCallback(() => reclaimMutation.mutateAsync(), [reclaimMutation]),
    isReclaiming: reclaimMutation.isLoading,
    isLite
  };
}
