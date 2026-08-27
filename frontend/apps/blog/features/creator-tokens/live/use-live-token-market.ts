'use client';

/**
 * The real-chain replacement for market/store.ts's useTokenMarket().
 *
 * TWO DIFFERENCES FROM THE DEMO IT REPLACES, both deliberate and both visible
 * in the type:
 *
 * 1. `status` is explicit. The demo always had a market — it synthesised one —
 *    so every screen could assume `market` existed. A real page has five
 *    distinct states (feature not provisioned, loading, read failed, creator
 *    has no market, ready) and rendering any of the first four as "a market
 *    with zeros in it" is precisely the lie this wiring exists to remove.
 *
 * 2. The actions are ASYNC and REJECT. The demo's buy/sell/spend returned a
 *    synchronous boolean; a real one builds an op, asks the user to sign it,
 *    and broadcasts. Callers must await and catch — a handler that closes its
 *    modal without awaiting is telling the user their money moved before the
 *    signer has even opened.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTokenAccounts } from './use-token-accounts';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { resolveAskMaxCreditsBaseUnits } from '../market/curve';
import type { BuyQuote, SellQuote } from '../types';
import { adaptMarket, type LiveTokenMarket } from './adapt';
import { magiSpendingPowerKey } from './use-magi-spending-power';

export type LiveMarketStatus =
  /** No contract provisioned and no dev demo flag — the feature is not available in this build. */
  | 'unavailable'
  | 'loading'
  /** The chain read itself failed. NOT the same as "this creator has no market". */
  | 'error'
  /**
   * F14 fix (2026-08-19): OUR OWN session check (`/api/users/me`) failed —
   * distinct from 'error', where the CHAIN read failed. A hook that derives
   * its creator/holder identity from `loggedIn` cannot tell "genuinely signed
   * out" from "session check merely blipped" without this: before this state
   * existed, a failed session made `creator` resolve to null, which read
   * exactly like 'missing' — telling a creator who already has a live market
   * that they have none. Only reachable for hooks that need a signed-in
   * identity to read at all (use-live-studio.ts); use-live-token-market.ts
   * reads a public creator's page regardless of the viewer's own session, so
   * it exposes `sessionUnavailable` directly instead of folding it in here.
   */
  | 'session-unavailable'
  /** Read succeeded; this creator has never registered a market. */
  | 'missing'
  | 'ready';

/**
 * Exported (2026-08-11, creator-token-prominence pass) so the lightweight
 * header-pill/byline-chip read (live/use-token-price-chip.ts) can target the
 * EXACT SAME cache entry this hook's own market query uses — a reader who
 * opens a creator's token page after seeing their chip in the feed gets an
 * instant, already-cached price instead of a second chain read, and vice
 * versa. react-query dedupes by the key's contents, not by which file built
 * it, so this only needs to be the single source of truth for the shape.
 */
export const creatorMarketKey = (creator: string) => ['creatorTokens', 'live', 'market', creator];
const positionKey = (creator: string, holder?: string) => ['creatorTokens', 'live', 'position', creator, holder];
const offeringsKey = (creator: string) => ['creatorTokens', 'live', 'offerings', creator];
const deliveryKey = (creator: string) => ['creatorTokens', 'live', 'delivery', creator];
const historyKey = (creator: string) => ['creatorTokens', 'live', 'priceHistory', creator];

// A market's phase and price move with the curve, not with a ticker, so a 30s
// poll keeps the page honest without hammering the node. Same cadence used
// elsewhere in this feature (use-live-studio.ts).
const REFETCH_MS = 30_000;
const STALE_MS = 15_000;

export interface LiveTokenMarketResult {
  status: LiveMarketStatus;
  /** Non-null only when status === 'ready'. */
  market: LiveTokenMarket | null;
  /**
   * TRUE when the holder-balance read FAILED — distinct from `market.position
   * === null`, which is the same value a genuinely empty balance produces.
   * Anything that renders a sentence about what the viewer holds must check
   * this first: "you hold none of this" and "we could not look" are different
   * claims, and only one of them is safe to make during an outage.
   */
  positionUnavailable: boolean;
  /** The signed-in viewer, or null. Actions all require one. */
  viewer: string | null;
  loggedIn: boolean;
  /**
   * F14 fix: true when `/api/users/me` has definitively FAILED (not merely
   * still loading) — see use-user-core.ts's own doc on the flag. `loggedIn`
   * alone cannot tell a genuinely signed-out visitor from a signed-in one
   * whose session check simply hasn't answered, so a session blip made
   * `viewer` resolve to null for an already-verified creator and every write
   * refused with "sign in to continue" — a falsehood, not a wait. Callers
   * that render "sign in" copy off `!loggedIn` should check this first.
   */
  sessionUnavailable: boolean;
  /** A lite account holds no Hive keys and cannot sign — every money action must be gated on this, not left to fail at the signer. */
  isLite: boolean;
  /** Can this viewer sign a write at all — by Hive key OR by a live wallet chain? */
  canTrade: boolean;
  /** The identity writes are signed AS. */
  signingIdentity: string | null;

  /** buy.go QuoteBuy — the MANDATORY preview before a buy (RULING F). Rejects exactly where a real Buy would. */
  quoteBuy: (tokens: number) => Promise<BuyQuote>;
  /** sell.go QuoteSell for the viewer — the exit-tax rate is the seller's own hold clock, so this is viewer-specific. */
  quoteSell: (tokens: number) => Promise<SellQuote>;

  /** Buys `tokens` whole tokens. `maxTotalUsd` becomes the signed transfer.allow cap — the buyer's ONLY slippage protection. */
  buy: (tokens: number, maxTotalUsd?: number) => Promise<void>;
  sell: (tokens: number, minNetUsd?: number) => Promise<void>;
  /**
   * refund.go Refund — the pro-rata exit at the floor. This is the rail to use
   * once `windingDown` is true: `sell` THROWS in that state, so a UI that offers
   * only sell leaves a holder with no way out of a market that is closing.
   */
  refund: (tokens: number, minNetUsd?: number) => Promise<void>;
  /** Opens an escrowed ask against `offeringId` (0 = the creator's legacy face price). */
  ask: (input: { offeringId: number; contentHash: string; deadlineDays: number; maxCostUsd: number }) => Promise<void>;
  transfer: (to: string, tokens: number) => Promise<void>;

  isBuying: boolean;
  /**
   * Re-read everything this hook owns. Exists so the "Try again" on a failed
   * chain read is a real button: MarketReadFailed accepted an `onRetry` and NO
   * call site ever passed one, so the retry never rendered at all — a dead
   * affordance on the one screen where the user is stuck.
   */
  retry: () => void;
  isSelling: boolean;
  isRefunding: boolean;
  isAsking: boolean;
  isTransferring: boolean;
}

export function useLiveTokenMarket(creator: string): LiveTokenMarketResult {
  const queryClient = useQueryClient();
  const { user, isHydrated, sessionUnavailable } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const viewer = loggedIn ? user.username : null;
  const isLite = user.account_tier === 'lite';

  // ★ A LITE ACCOUNT IS NO LONGER THE SAME THING AS "CANNOT SIGN" (2026-08-20).
  // It used to be, and the refusal below said so. Now a lite account whose EVM
  // wallet is bound signs natively on Magi, so the question changed from "what
  // TIER is this account" to "does this account hold a key that can sign" —
  // which is what `canSign` answers, per chain, from proof. `signingAccount` is
  // the identity that will actually appear in `required_auths`, and every write
  // is signed AS it: a balance lives under the account that bought it, and
  // `rate` is caller-gated at the contract (core/rating.go:68), so signing as
  // the wrong one of a user's identities fails at the chain rather than here.
  const tokenAccounts = useTokenAccounts();
  const signingAccount = tokenAccounts.accounts.find((a) => a.canSign) ?? null;

  // ★★ THE ACCOUNT A POSITION IS HELD UNDER IS NOT `viewer` (audit, 2026-08-20).
  // `viewer` is `user.username` — for a lite account that is the chosen LUMEN
  // DISPLAY NAME, and `readHolderPosition` runs it through `toDid()`, producing
  // `hive:<display name>`: an account that has never existed and never will. So
  // a wallet holder who successfully BOUGHT tokens (their balance sits under
  // their own `did:pkh`) read their position back as ZERO on that token's page.
  //
  // That is not a cosmetic zero. `held` feeds SellModal, RefundModal, AskModal
  // and SendModal, so every exit from the position was blocked while the tokens
  // were provably on chain — and `/wallet/tokens`, which reads across the real
  // account ids, showed them the whole time. Reads and writes must name the SAME
  // identity, so this is the one the signer will use.
  const positionAccount = (isLite ? signingAccount?.id : viewer) ?? null;

  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;
  const enabled = Boolean(creator) && !unavailable;

  const marketQuery = useQuery({
    queryKey: creatorMarketKey(creator),
    queryFn: () => dataSource!.readMarket(creator),
    enabled,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });

  // readMarket resolves phase 'UNKNOWN' rather than rejecting when the read
  // itself fails, so BOTH have to be folded into the error state — a thrown
  // query and an UNKNOWN market mean the same thing to a user, and only one of
  // them is an exception.
  const readFailed = marketQuery.isError || marketQuery.data?.phase === 'UNKNOWN';

  const positionQuery = useQuery({
    queryKey: positionKey(creator, positionAccount ?? undefined),
    queryFn: () => dataSource!.readHolderPosition(creator, positionAccount as string),
    enabled: enabled && Boolean(positionAccount) && !readFailed,
    staleTime: STALE_MS
  });

  const offeringsQuery = useQuery({
    queryKey: offeringsKey(creator),
    queryFn: () => dataSource!.listOfferings(creator),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS
  });

  const deliveryQuery = useQuery({
    queryKey: deliveryKey(creator),
    queryFn: () => dataSource!.readDeliveryRecord(creator),
    enabled: enabled && !readFailed,
    staleTime: STALE_MS
  });

  // Price history is the ONLY read here that is allowed to fail without
  // degrading the page: a market with no chart is still fully tradeable, so this
  // never feeds `status`. It just renders as absent.
  const historyQuery = useQuery({
    queryKey: historyKey(creator),
    queryFn: () => dataSource!.readPriceHistory(creator),
    enabled: enabled && !readFailed,
    staleTime: REFETCH_MS,
    refetchInterval: REFETCH_MS,
    retry: false
  });

  const status: LiveMarketStatus = unavailable
    ? 'unavailable'
    : marketQuery.isLoading
      ? 'loading'
      : readFailed
        ? 'error'
        : marketQuery.data === null
          ? 'missing'
          : 'ready';

  /**
   * ★ "HOLDS NOTHING" AND "WE COULD NOT READ YOUR BALANCE" ARE NOT THE SAME
   * ANSWER, and `market.position` cannot tell them apart (2026-08-27).
   *
   * `readHolderPosition` REJECTS on a genuine read failure precisely so that a
   * zero can never be mistaken for a fact (see its doc in
   * creator-tokens-data-source.ts) — and then `positionQuery.data ?? null`
   * below flattens the rejection back into the same `null` a real empty balance
   * produces, discarding the distinction the data source went out of its way to
   * preserve. Harmless while nothing rendered a sentence about it; the moment a
   * screen says "you hold none of this token", an outage makes that a lie about
   * someone's money.
   *
   * Exposed rather than fixed in `adaptMarket`: `LiveHolderPosition` is the
   * shape of a position that EXISTS, and inventing an "unavailable position"
   * variant would push the ambiguity into every reader of it instead of
   * removing it.
   */
  const positionUnavailable = positionQuery.isError;

  const market =
    status === 'ready' && marketQuery.data
      ? adaptMarket({
          creator,
          market: marketQuery.data,
          position: positionQuery.data ?? null,
          // An offerings read that failed must not silently render as "this
          // creator sells nothing" — fall back to the market's own face price
          // (adaptMarket does that when the list is empty), which is a real,
          // buyable service rather than an empty shop.
          offerings: offeringsQuery.data ?? [],
          delivery: deliveryQuery.data ?? null,
          // null (not []) when the history could not be read — adapt.ts turns
          // that into "no chart", and an empty array would draw a flat line,
          // which is a claim about the price rather than an absence of one.
          priceHistory: historyQuery.isSuccess ? historyQuery.data.map((p) => p.priceHbd) : null
        })
      : null;

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: creatorMarketKey(creator) });
    queryClient.invalidateQueries({ queryKey: positionKey(creator, positionAccount ?? undefined) });
    // ★ THE BALANCE TOO. Every mutation below routes through this callback, and
    // until 2026-08-21 none of them touched the spending-power query — so the
    // number that says how much money you have was the ONE number a trade never
    // refreshed. With a 20s staleTime and both modals closing on success, a user
    // who re-opened Buy inside that window saw their pre-trade balance presented
    // as current: it read as "I wasn't charged". Invalidating on the same
    // identity the signer used keeps the money view and the position view honest
    // together.
    queryClient.invalidateQueries({ queryKey: magiSpendingPowerKey(positionAccount) });
  }, [queryClient, creator, positionAccount]);

  // Every money action funnels through this. It refuses with a NAMED error
  // instead of letting an undefined data source or a missing signer surface as
  // a TypeError three frames deep — and, critically, it refuses a LITE account
  // here as well as in the UI, so a stale render or a deep link can never get
  // past the gate the button is supposed to enforce.
  const requireSigner = useCallback((): { source: NonNullable<typeof dataSource>; signer: string } => {
    if (!dataSource) throw new Error('CREATOR_TOKENS_UNAVAILABLE: no contract is provisioned');
    // F14 fix: distinct from "sign in to continue" — this is our OWN session
    // check failing, not a genuine sign-out. Checked before the generic
    // !viewer branch so a signed-in user whose /api/users/me merely blipped
    // is told the truth instead of being asked to sign in again.
    if (!viewer && sessionUnavailable) {
      throw new Error('CREATOR_TOKENS_SESSION_UNAVAILABLE: we couldn’t verify you’re signed in just now. Try again in a moment.');
    }
    if (!viewer) throw new Error('CREATOR_TOKENS_SIGNED_OUT: sign in to continue');
    // A lite account signs through its wallet when one of its bound chains is
    // live; otherwise it genuinely cannot sign and is told so. The message names
    // the fix (connect a wallet) rather than the tier, because the tier is no
    // longer the reason.
    if (isLite) {
      if (!signingAccount) {
        throw new Error(
          'CREATOR_TOKENS_LITE_ACCOUNT: this account has no key that can sign a transaction — connect an Ethereum wallet to trade.'
        );
      }
      return { source: dataSource, signer: signingAccount.id };
    }
    return { source: dataSource, signer: viewer };
  }, [dataSource, viewer, isLite, signingAccount, sessionUnavailable]);

  const buyMutation = useMutation({
    mutationFn: async ({ tokens, maxTotalUsd }: { tokens: number; maxTotalUsd?: number }) => {
      const { source, signer } = requireSigner();
      await source.buy({ creator, buyer: signer, tokens, maxTotalHbd: maxTotalUsd });
    },
    onSuccess: invalidate
  });

  const sellMutation = useMutation({
    mutationFn: async ({ tokens, minNetUsd }: { tokens: number; minNetUsd?: number }) => {
      const { source, signer } = requireSigner();
      await source.sell({ creator, seller: signer, tokens, minNetHbd: minNetUsd });
    },
    onSuccess: invalidate
  });

  // refund.go Refund — the PRO-RATA rail, and the ONLY way out once the market
  // is winding down. sell() throws in that state (vsc-data-source.ts: "curve
  // sell is closed while the market winds down ... exit via refund() instead"),
  // and until now nothing in the UI called this: the Sell button stayed enabled,
  // reliably failed, and the page's own copy claimed selling always worked. A
  // holder had no reachable exit at exactly the moment they most needed one.
  const refundMutation = useMutation({
    mutationFn: async ({ tokens, minNetUsd }: { tokens: number; minNetUsd?: number }) => {
      const { source, signer } = requireSigner();
      await source.refund({ creator, holder: signer, tokens, minNetHbd: minNetUsd });
    },
    onSuccess: invalidate
  });

  const askMutation = useMutation({
    mutationFn: async (input: { offeringId: number; contentHash: string; deadlineDays: number; maxCostUsd: number }) => {
      const { source, signer } = requireSigner();
      // F4 fix (2026-08-19): maxCreditsBaseUnits used to be built as
      // `humanToBaseUnits(input.maxCostUsd)` — an HBD-milliunit number, while
      // the field is an INTEGER TOKEN COUNT (see resolveAskMaxCreditsBaseUnits's
      // doc above). `maxCostUsd` stays in this input type — the modal still
      // shows it as the price the user is agreeing to — but the SIGNED cap is
      // now the quote's own credits figure, re-read here (not the possibly
      // stale one shown when the modal opened) so a creator can't spike `face`
      // between this read and the signature. Quote the SAME offering the ask
      // will name (readQuote's own offeringId doc) or this would price the
      // wrong service.
      const quote = await source.readQuote(creator, input.offeringId);
      if (quote.creditsRequiredBaseUnits === null) {
        throw new Error(`CREATOR_TOKENS_UNPRICED: we can’t price this ask right now (${quote.oracleStatus}). Try again in a moment.`);
      }
      await source.ask({
        creator,
        asker: signer,
        contentHash: input.contentHash,
        // ask.go bounds the deadline in BLOCKS on both sides; the UI collects
        // days, so the conversion belongs here rather than in four call sites.
        deadlineBlocks: input.deadlineDays * 28_800,
        // The asker's own signed cap on tokens spent — REQUIRED by core.Ask,
        // which rejects a missing or zero value rather than defaulting to
        // unlimited. It is what stops a creator spiking their price between
        // this user signing and the transaction executing.
        maxCreditsBaseUnits: resolveAskMaxCreditsBaseUnits(quote.creditsRequiredBaseUnits),
        // 0 is the reserved alias for the creator's legacy face price, so this
        // is always safe to pass through as-is.
        offeringId: input.offeringId
      });
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['creatorTokens', 'live', 'myAsks'] });
    }
  });

  const transferMutation = useMutation({
    mutationFn: async ({ to, tokens }: { to: string; tokens: number }) => {
      const { source, signer } = requireSigner();
      await source.transferTokens({ creator, from: signer, to, tokens });
    },
    onSuccess: invalidate
  });

  return {
    status,
    market,
    positionUnavailable,
    viewer,
    loggedIn,
    sessionUnavailable,
    isLite,
    // ★ `isLite` is no longer sufficient to gate a write, and every surface that
    // treated it that way now understates what a wallet user can do. `canTrade`
    // is the capability, derived from the same per-chain proof `canSign` is.
    canTrade: !isLite || signingAccount !== null,
    /** The identity writes are signed AS — a `hive:` name, or a wallet DID. */
    signingIdentity: (isLite ? signingAccount?.id : viewer) ?? null,

    quoteBuy: useCallback(
      (tokens: number) => {
        if (!dataSource) return Promise.reject(new Error('CREATOR_TOKENS_UNAVAILABLE'));
        return dataSource.quoteBuy(creator, tokens);
      },
      [dataSource, creator]
    ),
    quoteSell: useCallback(
      (tokens: number) => {
        if (!dataSource) return Promise.reject(new Error('CREATOR_TOKENS_UNAVAILABLE'));
        // Exit tax is the SELLER's own hold clock, so this must be quoted for
        // the identity that actually holds the tokens — not the display name.
        if (!positionAccount) return Promise.reject(new Error('CREATOR_TOKENS_SIGNED_OUT'));
        return dataSource.quoteSell(creator, positionAccount, tokens);
      },
      [dataSource, creator, positionAccount]
    ),

    buy: useCallback((tokens: number, maxTotalUsd?: number) => buyMutation.mutateAsync({ tokens, maxTotalUsd }), [buyMutation]),
    sell: useCallback((tokens: number, minNetUsd?: number) => sellMutation.mutateAsync({ tokens, minNetUsd }), [sellMutation]),
    refund: useCallback(
      (tokens: number, minNetUsd?: number) => refundMutation.mutateAsync({ tokens, minNetUsd }),
      [refundMutation]
    ),
    ask: useCallback((input: { offeringId: number; contentHash: string; deadlineDays: number; maxCostUsd: number }) => askMutation.mutateAsync(input), [askMutation]),
    transfer: useCallback((to: string, tokens: number) => transferMutation.mutateAsync({ to, tokens }), [transferMutation]),

    isBuying: buyMutation.isLoading,
    retry: () => {
      for (const key of [creatorMarketKey(creator), positionKey(creator, positionAccount ?? undefined), offeringsKey(creator), deliveryKey(creator), historyKey(creator)]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    isSelling: sellMutation.isLoading,
    isRefunding: refundMutation.isLoading,
    isAsking: askMutation.isLoading,
    isTransferring: transferMutation.isLoading
  };
}
