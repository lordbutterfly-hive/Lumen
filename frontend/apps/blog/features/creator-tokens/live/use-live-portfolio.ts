'use client';

/**
 * The real-chain replacement for market/store.ts's useMyHoldings()/useMyAsks().
 *
 * BOTH READS ARE INDEXER-BACKED — the Magi indexer (magi-mongo-indexer served
 * over Hasura), which is a real, running service. They resolve `unavailable`
 * only when it is genuinely unreachable or unconfigured, and that stays a
 * DISCRIMINATED `{ …, unavailable }` result precisely so a screen can tell
 * "couldn't load" from "you hold nothing". Rendering an empty portfolio as real
 * would tell someone their tokens are gone.
 *
 * Why chain-only is not an option here: a wallet view is a holder -> creators
 * question, and contract state is keyed the other way (creator -> holder). You
 * cannot enumerate "every market this account holds" from state keys without
 * knowing the creators up front, which is exactly the reverse index the indexer
 * exists to build.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { Ask, HolderPosition } from '../types';

const walletKey = (holder: string) => ['creatorTokens', 'live', 'wallet', holder];
const myAsksKey = (asker: string) => ['creatorTokens', 'live', 'myAsks', asker];

const STALE_MS = 15_000;
const REFETCH_MS = 30_000;

export interface LivePortfolio {
  /** No contract provisioned in this build. */
  unavailable: boolean;
  loggedIn: boolean;
  isLite: boolean;
  holder: string | null;
  isLoading: boolean;
  /** TRUE = the indexer could not be reached. Distinct from an empty list, and the UI must say which. */
  holdingsUnavailable: boolean;
  asksUnavailable: boolean;
  holdings: HolderPosition[];
  asks: Ask[];
  /** ask.go Reclaim — permissionless once the window is open, but this always pays the escrow's own asker, never the caller. */
  reclaim: (input: { creator: string; seq: number; deadlineBlock: number }) => Promise<void>;
  isReclaiming: boolean;
  /**
   * rating.go Rate — the buyer's 1-5 score for a delivered job.
   *
   * This is the ONLY protection a buyer has after the fact. `Answer` is
   * unilateral: a creator marks a job delivered and is paid, and the contract
   * cannot see whether anything was actually done. There is no dispute and no
   * clawback — a creator who takes money without delivering is disciplined by
   * their record and their token's price, and this is how that record is made.
   */
  rate: (input: { creator: string; seq: number; score: number }) => Promise<void>;
  isRating: boolean;
}

export function useLivePortfolio(): LivePortfolio {
  const queryClient = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const holder = loggedIn ? user.username : null;
  const isLite = user.account_tier === 'lite';

  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;
  const enabled = Boolean(holder) && !unavailable;

  const walletQuery = useQuery({
    queryKey: walletKey(holder ?? ''),
    queryFn: () => dataSource!.readWallet(holder as string),
    enabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });

  const asksQuery = useQuery({
    queryKey: myAsksKey(holder ?? ''),
    queryFn: () => dataSource!.readMyAsks(holder as string),
    enabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });

  const reclaimMutation = useMutation({
    mutationFn: async (input: { creator: string; seq: number; deadlineBlock: number }) => {
      if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
      if (!holder) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
      if (isLite) throw new Error('CREATOR_TOKENS_LITE_ACCOUNT: this account has no Hive keys and cannot sign a transaction');
      await dataSource.reclaim({ creator: input.creator, seq: input.seq, asker: holder, deadlineBlock: input.deadlineBlock });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: walletKey(holder ?? '') });
      queryClient.invalidateQueries({ queryKey: myAsksKey(holder ?? '') });
    }
  });

  const rateMutation = useMutation({
    mutationFn: async (input: { creator: string; seq: number; score: number }) => {
      if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
      if (!holder) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
      if (isLite) throw new Error('CREATOR_TOKENS_LITE_ACCOUNT: this account has no Hive keys and cannot sign a transaction');
      await dataSource.rate({ creator: input.creator, rater: holder, seq: input.seq, score: input.score });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: myAsksKey(holder ?? '') });
    }
  });

  return {
    unavailable,
    loggedIn,
    isLite,
    holder,
    isLoading: walletQuery.isLoading || asksQuery.isLoading,
    // A thrown query and a resolved `unavailable:true` mean the same thing to a
    // user; fold both rather than making every screen handle two shapes.
    holdingsUnavailable: walletQuery.isError || (walletQuery.data?.unavailable ?? false),
    asksUnavailable: asksQuery.isError || (asksQuery.data?.unavailable ?? false),
    holdings: walletQuery.data?.positions ?? [],
    asks: asksQuery.data?.asks ?? [],
    reclaim: useCallback((input: { creator: string; seq: number; deadlineBlock: number }) => reclaimMutation.mutateAsync(input), [reclaimMutation]),
    isReclaiming: reclaimMutation.isLoading,
    rate: useCallback((input: { creator: string; seq: number; score: number }) => rateMutation.mutateAsync(input), [rateMutation]),
    isRating: rateMutation.isLoading
  };
}
