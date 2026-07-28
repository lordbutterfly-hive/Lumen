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

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { BLOCKS_PER_DAY } from '../lib/contract-math';
import type { Ask, Market, Offering } from '../types';
import { adaptAsk, adaptMarket, blocksToDays, usdFromHbd, type LiveTokenMarket } from './adapt';
import type { PortfolioAsk } from '../market/portfolio';
import type { LiveMarketStatus } from './use-live-token-market';

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

  market: LiveTokenMarket | null;
  /** Escrows awaiting this creator's answer. Chain-read, no indexer. */
  inbox: PortfolioAsk[];
  /** The raw escrows behind `inbox` — answer/decline need seq + deadlineBlock, which the portfolio row does not carry. */
  rawInbox: Ask[];
  offerings: Offering[];
  /** Whole days until the subscription lapses; negative once overdue. */
  subDaysLeft: number;
  tradeFeeClaimableUsd: number;
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
  claimTradeFees: () => Promise<number>;
  sell: (tokens: number) => Promise<void>;
  retire: () => Promise<void>;
  createOffering: (input: { title: string; priceUsd: number }) => Promise<void>;
  setOfferingPrice: (input: { offeringId: number; priceUsd: number }) => Promise<void>;
  setOfferingTitle: (input: { offeringId: number; title: string }) => Promise<void>;
  deleteOffering: (offeringId: number) => Promise<void>;

  isBusy: boolean;
}

export function useLiveStudio(): LiveStudio {
  const queryClient = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const creator = loggedIn ? user.username : null;
  const isLite = user.account_tier === 'lite';

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

  const status: LiveMarketStatus = unavailable
    ? 'unavailable'
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
    if (!creator) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
    if (isLite) throw new Error('CREATOR_TOKENS_LITE_ACCOUNT: this account has no Hive keys and cannot sign a transaction');
    return { source: dataSource, signer: creator };
  }, [dataSource, creator, isLite]);

  const run = useMutation({
    mutationFn: async (fn: (ctx: { source: NonNullable<typeof dataSource>; signer: string }) => Promise<unknown>) => fn(requireSigner()),
    onSuccess: invalidate
  });
  const call = useCallback(
    async <T,>(fn: (ctx: { source: NonNullable<typeof dataSource>; signer: string }) => Promise<T>): Promise<T> => (await run.mutateAsync(fn as never)) as T,
    [run]
  );

  return {
    status,
    creator,
    loggedIn,
    isLite,
    market,
    inbox,
    rawInbox,
    offerings: offeringsQuery.data ?? [],
    subDaysLeft,
    tradeFeeClaimableUsd: usdFromHbd(feeQuery.data ?? 0),
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
    claimTradeFees: useCallback(
      () =>
        call(async ({ source, signer }) => {
          return source.claimTradeFees({ account: signer });
        }),
      [call]
    ),
    sell: useCallback(
      (tokens: number) =>
        call(async ({ source, signer }) => {
          await source.sell({ creator: signer, seller: signer, tokens });
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
