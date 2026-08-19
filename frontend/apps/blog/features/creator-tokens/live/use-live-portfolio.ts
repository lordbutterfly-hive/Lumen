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

import { useCallback, useRef } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { useTokenAccounts, type TokenAccount } from './use-token-accounts';
import type { Ask, HolderPosition } from '../types';

const walletKey = (holder: string) => ['creatorTokens', 'live', 'wallet', holder];
const myAsksKey = (asker: string) => ['creatorTokens', 'live', 'myAsks', asker];

const STALE_MS = 15_000;
const REFETCH_MS = 30_000;

export interface LivePortfolio {
  /** No contract provisioned in this build. */
  unavailable: boolean;
  loggedIn: boolean;
  /**
   * F14 fix: true when `/api/users/me` has definitively FAILED (not merely
   * still loading) — see use-user-core.ts's own doc. `loggedIn` alone cannot
   * tell a genuinely signed-out visitor from one whose session check simply
   * hasn't answered, so a session blip made `holder` resolve to null for an
   * already-verified user and your-tokens-view.tsx said "Sign in to see the
   * Meritum you hold" to someone who already holds some. Persists until the
   * next focus/reconnect, not a flicker.
   */
  sessionUnavailable: boolean;
  isLite: boolean;
  holder: string | null;
  isLoading: boolean;
  /** TRUE = the indexer could not be reached. Distinct from an empty list, and the UI must say which. */
  holdingsUnavailable: boolean;
  asksUnavailable: boolean;
  holdings: HolderPosition[];
  asks: Ask[];
  /**
   * The Magi accounts these holdings are read under — one Hive account, or one
   * row per bound wallet. Carried so a screen can label WHICH wallet holds what:
   * two bound wallets are two separate Magi accounts and nothing moves between
   * them.
   */
  accounts: TokenAccount[];
  /**
   * FALSE for a Google-only lite account: there is no keypair behind it, so it is
   * not a Magi account and cannot hold anything. Screens must say that rather
   * than render an empty portfolio, which reads as "your tokens are gone".
   */
  canHold: boolean;
  /**
   * FALSE for every wallet identity today: holding and being paid work, but
   * initiating a transaction needs a signature over the transaction itself,
   * which is a rail we have not ported yet. Separate from `canHold` on purpose.
   */
  canSign: boolean;
  /** The wallet lookup itself failed — NOT "no wallets". Never render an empty portfolio here. */
  accountsFailed: boolean;
  /** The wallet-link lookup has not answered yet. Distinct from 'answered: no wallet'. */
  accountsLoading: boolean;
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
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const isLite = user.account_tier === 'lite';

  // WHICH ACCOUNTS TO READ. Previously this was always `user.username`, which is
  // wrong for a lite account: a Lumen handle is a display name Magi has never
  // heard of, so a Bitcoin- or Ethereum-wallet user saw an empty portfolio no
  // matter what they held. Their real holder identity is the wallet's `did:pkh`,
  // which the contract already accepts. A user may have bound more than one
  // wallet, so this is a LIST and each holding keeps the account it is under.
  const tokenAccounts = useTokenAccounts();
  const accountIds = tokenAccounts.accounts.map((a) => a.id);
  // Primary account, kept for the write paths below (all of which still require
  // Hive keys) and for query-key continuity on a full Hive session.
  const holder = loggedIn && accountIds.length > 0 ? accountIds[0] : null;

  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;
  const enabled = accountIds.length > 0 && !unavailable;

  const walletQueries = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: walletKey(id),
      queryFn: () => dataSource!.readWallet(id),
      enabled,
      staleTime: STALE_MS,
      refetchInterval: REFETCH_MS
    }))
  });

  const asksQueries = useQueries({
    queries: accountIds.map((id) => ({
      queryKey: myAsksKey(id),
      queryFn: () => dataSource!.readMyAsks(id),
      enabled,
      staleTime: STALE_MS,
      refetchInterval: REFETCH_MS
    }))
  });

  // A PARTIAL portfolio is treated as unavailable, not as complete. Someone with
  // two wallets who is shown only one wallet's tokens would reasonably conclude
  // the rest are gone — so if any single account's read fails, the whole view
  // says "couldn't load" rather than silently under-reporting holdings.
  const walletQuery = {
    isLoading: walletQueries.some((q) => q.isLoading),
    data: {
      positions: walletQueries.flatMap((q) => q.data?.positions ?? []),
      unavailable: walletQueries.some((q) => q.isError || q.data?.unavailable)
    }
  };
  const asksQuery = {
    isLoading: asksQueries.some((q) => q.isLoading),
    data: {
      asks: asksQueries.flatMap((q) => q.data?.asks ?? []),
      unavailable: asksQueries.some((q) => q.isError || q.data?.unavailable)
    }
  };

  const reclaimMutation = useMutation({
    mutationFn: async (input: { creator: string; seq: number; deadlineBlock: number }) => {
      if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
      // F14 fix: distinct from "sign in to continue" — see use-live-token-market.ts's requireSigner for the identical reasoning.
      if (!holder && sessionUnavailable) {
        throw new Error('CREATOR_TOKENS_SESSION_UNAVAILABLE: we couldn’t verify you’re signed in just now. Try again in a moment.');
      }
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
      if (!holder && sessionUnavailable) {
        throw new Error('CREATOR_TOKENS_SESSION_UNAVAILABLE: we couldn’t verify you’re signed in just now. Try again in a moment.');
      }
      if (!holder) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
      if (isLite) throw new Error('CREATOR_TOKENS_LITE_ACCOUNT: this account has no Hive keys and cannot sign a transaction');
      await dataSource.rate({ creator: input.creator, rater: holder, seq: input.seq, score: input.score });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: myAsksKey(holder ?? '') });
    }
  });

  // F7 fix (2026-08-19): see token-modals.tsx BuyModal's `inFlight` doc for
  // the full rationale — `reclaimMutation.isLoading`/`rateMutation.isLoading`
  // are useState-backed react-query values with the identical same-tick race.
  // Two separate refs: a double-submit on ONE reclaim/rate must not block an
  // unrelated one on a different escrow. Throws (not a silent no-op) because
  // the resolved promise is treated as success by AskCard/RateStrip's own
  // try/catch (RateStrip flips to "Thanks, recorded" on resolve).
  const reclaimInFlight = useRef(false);
  const rateInFlight = useRef(false);

  return {
    unavailable,
    loggedIn,
    sessionUnavailable,
    isLite,
    holder,
    isLoading: tokenAccounts.isLoading || walletQuery.isLoading || asksQuery.isLoading,
    // A thrown query and a resolved `unavailable:true` mean the same thing to a
    // user; fold both rather than making every screen handle two shapes.
    // The aggregate already folds thrown queries and resolved `unavailable:true`
    // into one flag (see walletQuery above), so there is no separate isError here.
    holdingsUnavailable: walletQuery.data.unavailable,
    asksUnavailable: asksQuery.data.unavailable,
    holdings: walletQuery.data.positions,
    asks: asksQuery.data.asks,
    accounts: tokenAccounts.accounts,
    canHold: tokenAccounts.canHold,
    canSign: tokenAccounts.canSign,
    accountsFailed: tokenAccounts.failed,
    accountsLoading: tokenAccounts.isLoading,
    reclaim: useCallback(
      async (input: { creator: string; seq: number; deadlineBlock: number }) => {
        if (reclaimInFlight.current) {
          throw new Error('CREATOR_TOKENS_BUSY: that reclaim is already in progress. Wait for it to finish.');
        }
        reclaimInFlight.current = true;
        try {
          await reclaimMutation.mutateAsync(input);
        } finally {
          reclaimInFlight.current = false;
        }
      },
      [reclaimMutation]
    ),
    isReclaiming: reclaimMutation.isLoading,
    rate: useCallback(
      async (input: { creator: string; seq: number; score: number }) => {
        if (rateInFlight.current) {
          throw new Error('CREATOR_TOKENS_BUSY: that rating is already in progress. Wait for it to finish.');
        }
        rateInFlight.current = true;
        try {
          await rateMutation.mutateAsync(input);
        } finally {
          rateInFlight.current = false;
        }
      },
      [rateMutation]
    ),
    isRating: rateMutation.isLoading
  };
}
