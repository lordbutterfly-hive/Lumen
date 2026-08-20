'use client';

/**
 * The real-chain replacement for market/store.ts's useStudio().
 *
 * The creator side is the part of this product that is fully readable from the
 * chain TODAY: a creator's own market, their escrow inbox (kSeq + e|creator|i,
 * no indexer needed), their posted shop, their claimable trade fees and their
 * billing state all come straight from contract state. The only studio number
 * that genuinely needs the indexer is lifetime commission earned, which is a
 * replay of past events — so that one is reported as UNKNOWN rather than
 * guessed at (see `commissionEarnedUsd`).
 *
 * Same two contract changes as useLiveTokenMarket: an explicit `status`, and
 * async actions that reject. See that file's header for why.
 */

import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTokenAccounts } from './use-token-accounts';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { BLOCKS_PER_DAY } from '../lib/contract-math';
import type { Ask, Market, Offering } from '../types';
import { adaptAsk, adaptMarket, blocksToDays, usdFromHbd, type LiveTokenMarket } from './adapt';
import type { PortfolioAsk } from '../market/portfolio';
import type { LiveMarketStatus } from './use-live-token-market';
import { collapseRead } from './collapse-read';

const marketKey = (creator: string) => ['creatorTokens', 'live', 'market', creator];
const asksKey = (creator: string) => ['creatorTokens', 'live', 'creatorAsks', creator];
const offeringsKey = (creator: string) => ['creatorTokens', 'live', 'offerings', creator];
const deliveryKey = (creator: string) => ['creatorTokens', 'live', 'delivery', creator];
const feeKey = (account: string) => ['creatorTokens', 'live', 'feeBalance', account];

const REFETCH_MS = 30_000;
const STALE_MS = 15_000;

export interface LiveStudio {
  status: LiveMarketStatus;
  /** The signed-in creator. All studio actions are self-signed, so this is both the subject and the signer. */
  creator: string | null;
  loggedIn: boolean;
  isLite: boolean;
  /**
   * F14 fix: re-run `/api/users/me` — the retry affordance for
   * status === 'session-unavailable'. Distinct from `retry` below, which only
   * re-reads chain state and does nothing when the block is the session
   * itself, since `creator` is null in that state and every chain query is
   * disabled.
   */
  retrySession: () => void;

  market: LiveTokenMarket | null;
  /** Escrows awaiting this creator's answer. Chain-read, no indexer. */
  inbox: PortfolioAsk[];
  /** The raw escrows behind `inbox` — answer/decline need seq + deadlineBlock, which the portfolio row does not carry. */
  rawInbox: Ask[];
  /**
   * NULL when the shop could not be read — NOT an empty shop.
   *
   * ★ These two used to collapse a REJECTED chain read into a confident zero
   * (`offeringsQuery.data ?? []`, `usdFromHbd(feeQuery.data ?? 0)`), because both
   * gate their loading state on the MARKET query's success rather than their own.
   * A transient node failure on either read therefore rendered as fact: "You
   * haven't posted any services yet" to a creator whose services are live, and a
   * claimable balance of $0 with the Claim button reading "Claimed" and disabled
   * — real earnings, hidden behind a disabled control, with nothing on screen
   * saying a read had failed. `null` forces the caller to say "unavailable", the
   * way `commissionEarnedUsd` already does.
   */
  offerings: Offering[] | null;
  /** Whole days until the subscription lapses; negative once overdue. */
  subDaysLeft: number;
  /** NULL when the fee balance could not be read — NOT a zero balance. See `offerings`. */
  tradeFeeClaimableUsd: number | null;
  /**
   * NULL, always, until the indexer serves HTTP. Lifetime commission is a
   * replay of past `answered` events and cannot be derived from current state.
   * The demo showed a running total; a real studio must show "not available"
   * rather than a number a creator would reconcile their income against.
   */
  commissionEarnedUsd: number | null;

  /** market.go Register — opens the creator's own market. `faceHbd` is their default posted price; named services are separate offerings. */
  register: (input: { faceHbd: number; capTokens: number; firstBuyTokens?: number }) => Promise<void>;
  answer: (input: { seq: number; deadlineBlock: number; answerHash: string }) => Promise<void>;
  decline: (input: { seq: number; deadlineBlock: number }) => Promise<void>;
  renew: (periods: number) => Promise<void>;
  setCap: (newCapTokens: number) => Promise<void>;
  /** market.go SetFace — the posted base price, banded to at most 2x in any 7 days. */
  setFace: (newPriceUsd: number) => Promise<void>;
  claimTradeFees: () => Promise<number>;
  /**
   * F5 fix (2026-08-19): `minNetUsd` used to not exist on this signature at
   * all — sell.go's checkMinNet floor (OUTFLOW-CLIFF-1) was structurally
   * unreachable from the creator's own "Cash out" control, which is the ONE
   * place a creator sells on the curve, no matter what token-modals.tsx grew
   * around SellModal. Optional and additive: absent still means no floor,
   * same as everywhere else this parameter appears.
   */
  sell: (tokens: number, minNetUsd?: number) => Promise<void>;
  retire: () => Promise<void>;
  createOffering: (input: { title: string; priceUsd: number }) => Promise<void>;
  setOfferingPrice: (input: { offeringId: number; priceUsd: number }) => Promise<void>;
  setOfferingTitle: (input: { offeringId: number; title: string }) => Promise<void>;
  deleteOffering: (offeringId: number) => Promise<void>;

  /**
   * Re-read everything this hook owns. Exists so the "Try again" on a failed
   * chain read is a real button: MarketReadFailed accepted an `onRetry` and NO
   * call site ever passed one, so the retry never rendered at all — a dead
   * affordance on the one screen where the user is stuck.
   */
  retry: () => void;
  isBusy: boolean;
}

export function useLiveStudio(): LiveStudio {
  const queryClient = useQueryClient();
  const { user, isHydrated, sessionUnavailable, retrySession } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const creator = loggedIn ? user.username : null;
  const isLite = user.account_tier === 'lite';

  // ★ CAPABILITY, NOT TIER (2026-08-20, audit A3-F1). `use-live-token-market`
  // was migrated to a capability check when the wallet rail landed and this hook
  // was NOT, so every studio action — setFace, setCap, answer, decline,
  // createOffering, retire, claimTradeFees — stayed hard-refused for a lite
  // account even when its bound wallet demonstrably signs. A wallet identity
  // registers its market under its OWN did:pkh, so that DID is also the creator
  // whose market this studio administers.
  const tokenAccounts = useTokenAccounts();
  const signingAccount = tokenAccounts.accounts.find((a) => a.canSign) ?? null;

  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;
  const enabled = Boolean(creator) && !unavailable;

  const marketQuery = useQuery({
    queryKey: marketKey(creator ?? ''),
    queryFn: () => dataSource!.readMarket(creator as string),
    enabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });
  const readFailed = marketQuery.isError || marketQuery.data?.phase === 'UNKNOWN';

  const asksQuery = useQuery({
    queryKey: asksKey(creator ?? ''),
    queryFn: () => dataSource!.readCreatorAsks(creator as string),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });

  const offeringsQuery = useQuery({
    queryKey: offeringsKey(creator ?? ''),
    queryFn: () => dataSource!.listOfferings(creator as string),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS
  });

  const deliveryQuery = useQuery({
    queryKey: deliveryKey(creator ?? ''),
    queryFn: () => dataSource!.readDeliveryRecord(creator as string),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS
  });

  const feeQuery = useQuery({
    queryKey: feeKey(creator ?? ''),
    queryFn: () => dataSource!.readFeeBalance(creator as string),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS
  });

  // F14 fix: `sessionUnavailable` is checked BEFORE `!creator` — a failed
  // session ALSO makes `creator` null (loggedIn defaults false), and that
  // used to read exactly like 'missing', rendering "Launch your Meritum.
  // Free to launch." for a creator who already has a live market. Only
  // reachable while `!loggedIn`: once the session answers, `sessionUnavailable`
  // goes false again (use-user-core.ts's own doc on the flag).
  const sessionCheckFailed = !loggedIn && sessionUnavailable;
  const status: LiveMarketStatus = unavailable
    ? 'unavailable'
    : sessionCheckFailed
      ? 'session-unavailable'
      : !creator
        ? 'missing'
        : marketQuery.isLoading
          ? 'loading'
          : readFailed
            ? 'error'
            : marketQuery.data === null
              ? 'missing'
              : 'ready';

  const chainMarket: Market | null = status === 'ready' ? (marketQuery.data ?? null) : null;
  const market =
    chainMarket && creator
      ? adaptMarket({
          creator,
          market: chainMarket,
          // A creator's own holding is read on the market page, not here — the
          // studio's own-token panel uses supply/reserve, and fetching a
          // position we do not render would be a read for nothing.
          position: null,
          // The market VIEW still needs a concrete list; a failed read shows no
          // rows there, and the studio's own shop section reports the failure.
          offerings: offeringsQuery.data ?? [],
          delivery: deliveryQuery.data ?? null
        })
      : null;

  // Awaiting-only, and NOT filtered by asker: a creator's own self-dealt ask is
  // still an escrow they must resolve. (It just does not count toward their
  // delivery record — that exclusion lives in the contract, not here.)
  const rawInbox = (asksQuery.data ?? []).filter((a) => a.status === 'awaiting' || a.status === 'expired');
  const inbox = market ? rawInbox.map((a) => adaptAsk(a, market.priceUsd)) : [];

  const subDaysLeft = chainMarket ? blocksToDays(Math.max(0, chainMarket.paidUntilBlock - headOf(chainMarket))) : 0;

  const invalidate = useCallback(() => {
    if (!creator) return;
    queryClient.invalidateQueries({ queryKey: marketKey(creator) });
    queryClient.invalidateQueries({ queryKey: asksKey(creator) });
    queryClient.invalidateQueries({ queryKey: offeringsKey(creator) });
    queryClient.invalidateQueries({ queryKey: feeKey(creator) });
  }, [queryClient, creator]);

  const requireSigner = useCallback((): { source: NonNullable<typeof dataSource>; signer: string } => {
    if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
    // F14 fix: distinct from "sign in to continue" — this is our OWN session
    // check failing, not a genuine sign-out. Checked before the generic
    // !creator branch so a signed-in creator whose /api/users/me merely
    // blipped is told the truth instead of being asked to sign in again.
    if (!creator && sessionUnavailable) {
      throw new Error('CREATOR_TOKENS_SESSION_UNAVAILABLE: we couldn’t verify you’re signed in just now. Try again in a moment.');
    }
    if (!creator) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
    if (isLite) {
      if (!signingAccount) {
        throw new Error(
          'CREATOR_TOKENS_LITE_ACCOUNT: this account has no key that can sign a transaction — connect an Ethereum or Bitcoin wallet to manage your token.'
        );
      }
      return { source: dataSource, signer: signingAccount.id };
    }
    return { source: dataSource, signer: creator };
  }, [dataSource, creator, isLite, signingAccount, sessionUnavailable]);

  const run = useMutation({
    mutationFn: async (fn: (ctx: { source: NonNullable<typeof dataSource>; signer: string }) => Promise<unknown>) => fn(requireSigner()),
    onSuccess: invalidate
  });
  // F7 fix (2026-08-19): EVERY studio write funnels through `call()` —
  // register, answer, decline, setCap, setFace, claimTradeFees, sell, retire,
  // createOffering, setOfferingPrice, setOfferingTitle, deleteOffering, renew
  // — so guarding ONCE, here, protects all of them at the choke point instead
  // of duplicating a guard at every button (Raise cap, Sell, Claim, Renew,
  // Remove offering, the two PriceInput commits, …). `run.isLoading` (below,
  // as `isBusy`) is a useState-backed value that only updates on the NEXT
  // render, so two same-tick invocations (a fast double-click, or two
  // buttons fired together) would both read it as false and both broadcast.
  // A ref mutates synchronously — mirrors
  // ui/meritum/launch/use-meritum-launch.ts's inFlight ref, the one guard in
  // this feature that was already correct. Throws (rather than silently
  // no-op-ing) because `call()`'s return value is awaited and treated as
  // success by its caller — a silent no-op on the SECOND click would let that
  // click's UI believe it had succeeded when nothing was sent for it.
  const inFlight = useRef(false);
  const call = useCallback(
    async <T,>(fn: (ctx: { source: NonNullable<typeof dataSource>; signer: string }) => Promise<T>): Promise<T> => {
      if (inFlight.current) {
        throw new Error('CREATOR_TOKENS_BUSY: another action is still in progress. Wait for it to finish.');
      }
      inFlight.current = true;
      try {
        return (await run.mutateAsync(fn as never)) as T;
      } finally {
        inFlight.current = false;
      }
    },
    [run]
  );

  return {
    status,
    creator,
    loggedIn,
    isLite,
    retrySession,
    market,
    inbox,
    rawInbox,
    offerings: collapseRead(offeringsQuery),
    subDaysLeft,
    tradeFeeClaimableUsd: ((hbd) => (hbd === null ? null : usdFromHbd(hbd)))(collapseRead(feeQuery)),
    commissionEarnedUsd: null,

    register: useCallback(
      (input: { faceHbd: number; capTokens: number; firstBuyTokens?: number }) =>
        call(async ({ source, signer }) => {
          await source.registerMarket({ creator: signer, faceHbd: input.faceHbd, capTokens: input.capTokens, firstBuyTokens: input.firstBuyTokens });
        }),
      [call]
    ),
    answer: useCallback(
      (input: { seq: number; deadlineBlock: number; answerHash: string }) =>
        call(async ({ source, signer }) => {
          await source.answer({ creator: signer, seq: input.seq, answerHash: input.answerHash, deadlineBlock: input.deadlineBlock });
        }),
      [call]
    ),
    decline: useCallback(
      (input: { seq: number; deadlineBlock: number }) =>
        call(async ({ source, signer }) => {
          await source.decline({ creator: signer, seq: input.seq, deadlineBlock: input.deadlineBlock });
        }),
      [call]
    ),
    renew: useCallback(
      (periods: number) =>
        call(async ({ source, signer }) => {
          await source.renewSubscription({ creator: signer, caller: signer, periods });
        }),
      [call]
    ),
    setCap: useCallback(
      (newCapTokens: number) =>
        call(async ({ source, signer }) => {
          await source.setCap({ creator: signer, newCapTokens });
        }),
      [call]
    ),
    setFace: useCallback(
      (newPriceUsd: number) =>
        call(async ({ source, signer }) => {
          // HBD is treated 1:1 with USD in this product (adapt.ts documents the
          // single conversion point); setFace takes HBD.
          await source.setFace({ creator: signer, newFaceHbd: newPriceUsd });
        }),
      [call]
    ),
    claimTradeFees: useCallback(
      () =>
        call(async ({ source, signer }) => {
          return source.claimTradeFees({ account: signer });
        }),
      [call]
    ),
    sell: useCallback(
      (tokens: number, minNetUsd?: number) =>
        call(async ({ source, signer }) => {
          await source.sell({ creator: signer, seller: signer, tokens, minNetHbd: minNetUsd });
        }),
      [call]
    ),
    retire: useCallback(
      () =>
        call(async ({ source, signer }) => {
          await source.retire({ creator: signer });
        }),
      [call]
    ),
    createOffering: useCallback(
      (input: { title: string; priceUsd: number }) =>
        call(async ({ source, signer }) => {
          await source.createOffering({ creator: signer, title: input.title, priceHbd: input.priceUsd });
        }),
      [call]
    ),
    setOfferingPrice: useCallback(
      (input: { offeringId: number; priceUsd: number }) =>
        call(async ({ source, signer }) => {
          await source.setOfferingPrice({ creator: signer, offeringId: input.offeringId, newPriceHbd: input.priceUsd });
        }),
      [call]
    ),
    setOfferingTitle: useCallback(
      (input: { offeringId: number; title: string }) =>
        call(async ({ source, signer }) => {
          await source.setOfferingTitle({ creator: signer, offeringId: input.offeringId, title: input.title });
        }),
      [call]
    ),
    deleteOffering: useCallback(
      (offeringId: number) =>
        call(async ({ source, signer }) => {
          await source.deleteOffering({ creator: signer, offeringId });
        }),
      [call]
    ),

    retry: () => {
      for (const key of [marketKey(creator ?? ''), asksKey(creator ?? ''), offeringsKey(creator ?? ''), deliveryKey(creator ?? '')]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    isBusy: run.isLoading
  };
}

/**
 * The head block the Market was built against. Market carries derived
 * timestamps rather than the raw head, and graceExpiresAtBlock is
 * paidUntilBlock + GRACE_BLOCKS exactly, so the head is recoverable from the
 * pair without a second chain read — this keeps "days until lapse" consistent
 * with the phase the very same read produced, instead of racing a fresh head
 * against a stale market.
 */
function headOf(market: Market): number {
  const msUntilPaidUntil = market.paidUntilAt - Date.now();
  return market.paidUntilBlock - Math.round(msUntilPaidUntil / 3000);
}

export const STUDIO_GRACE_DAYS = 5 * BLOCKS_PER_DAY;
