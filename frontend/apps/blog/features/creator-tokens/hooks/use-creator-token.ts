'use client';

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';

// Single hook the profile/access-panel surfaces use, mirroring
// features/prediction-market/use-market.ts's shape and its react-query
// dedup trick: every component calling useCreatorToken(creator) for the same
// creator shares one cache entry.
//
// Scope: this hook wires the READS (market, position, asks, delivery record,
// quote) plus the three primary HOLDER-facing writes (prepay/ask/refund —
// UI-BRIEF Pages 1, 2 and 4, the surfaces §2.1 orders first). Creator-
// dashboard-only writes (answer, reclaim, renewSubscription, setFace, setCap,
// transferCredits, refundHolder) are lower-frequency and deliberately left
// off this hook to keep it within the repo's file-size guidance — a
// dashboard component can call getCreatorTokensDataSource() directly, or a
// sibling use-creator-dashboard.ts hook can wire them the same way later.

const marketKey = (creator: string) => ['creatorTokens', 'market', creator];
const positionKey = (creator: string, holder?: string) => ['creatorTokens', 'position', creator, holder];
const asksKey = (creator: string) => ['creatorTokens', 'asks', creator];
const deliveryKey = (creator: string) => ['creatorTokens', 'delivery', creator];
const quoteKey = (creator: string) => ['creatorTokens', 'quote', creator];

// Market state (paidUntil, phase) moves slowly relative to a bet pool, so a
// longer poll than prediction-market's 15s ticker is enough to keep the
// status chip honest without hammering the node.
const REFETCH_MS = 30_000;
const STALE_MS = 15_000;

export function useCreatorToken(creator: string) {
  const queryClient = useQueryClient();
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const dataSource = getCreatorTokensDataSource();

  const marketQuery = useQuery({
    queryKey: marketKey(creator),
    queryFn: () => dataSource.readMarket(creator),
    enabled: Boolean(creator),
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS
  });
  const market = marketQuery.data ?? null;
  // A resolved-but-unreachable read (see CreatorTokensDataSource.readMarket
  // doc) must disable actions exactly like a thrown query error would — fold
  // both into one flag so components don't have to know the difference.
  const marketUnknown = market?.phase === 'UNKNOWN';

  const positionQuery = useQuery({
    queryKey: positionKey(creator, user.username),
    queryFn: () => dataSource.readHolderPosition(creator, user.username),
    enabled: Boolean(creator) && loggedIn,
    staleTime: STALE_MS
  });

  const asksQuery = useQuery({
    queryKey: asksKey(creator),
    queryFn: () => dataSource.readCreatorAsks(creator),
    enabled: Boolean(creator) && !marketUnknown,
    staleTime: STALE_MS
  });

  const deliveryQuery = useQuery({
    queryKey: deliveryKey(creator),
    queryFn: () => dataSource.readDeliveryRecord(creator),
    enabled: Boolean(creator),
    staleTime: STALE_MS
  });

  const quoteQuery = useQuery({
    queryKey: quoteKey(creator),
    queryFn: () => dataSource.readQuote(creator),
    // Never worth pricing an ask against a market we can't even confirm
    // exists or that has nothing issued yet.
    enabled: Boolean(market) && !marketUnknown && (market?.supplyCredits ?? 0) > 0,
    staleTime: STALE_MS
  });

  const invalidateAfterMoney = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: marketKey(creator) });
    queryClient.invalidateQueries({ queryKey: positionKey(creator, user.username) });
  }, [queryClient, creator, user.username]);

  const prepayMutation = useMutation({
    mutationFn: (hbdAmount: number) => dataSource.prepay({ creator, holder: user.username, hbdAmount }),
    onSuccess: invalidateAfterMoney
  });

  const askMutation = useMutation({
    // maxCreditsBaseUnits is REQUIRED and deliberately has no default here.
    // It is the asker's signed cap on credits spent, and the whole point is
    // that the person paying chooses it after seeing the quote — a hook-level
    // default would silently reinstate the unlimited-spend hole it exists to
    // close. The calling UI must derive it from Quote.creditsRequiredBaseUnits
    // (finding C-D — the base-unit figure, not the human-scaled
    // Quote.creditsRequired) plus the tolerance it shows the user.
    mutationFn: (input: { contentHash: string; deadlineBlocks: number; maxCreditsBaseUnits: number }) =>
      dataSource.ask({ creator, asker: user.username, ...input }),
    onSuccess: () => {
      invalidateAfterMoney();
      queryClient.invalidateQueries({ queryKey: asksKey(creator) });
    }
  });

  const refundMutation = useMutation({
    mutationFn: (credits: number) => dataSource.refund({ creator, holder: user.username, credits }),
    onSuccess: invalidateAfterMoney
  });

  return {
    market,
    isLoadingMarket: marketQuery.isLoading,
    isMarketError: marketQuery.isError,
    marketUnknown,

    position: positionQuery.data ?? null,
    isLoadingPosition: positionQuery.isLoading,

    asks: asksQuery.data ?? [],
    isLoadingAsks: asksQuery.isLoading,

    deliveryRecord: deliveryQuery.data ?? null,

    quote: quoteQuery.data ?? null,

    loggedIn,

    prepay: useCallback((hbdAmount: number) => prepayMutation.mutateAsync(hbdAmount), [prepayMutation]),
    isPrepaying: prepayMutation.isLoading,

    ask: useCallback(
      (input: { contentHash: string; deadlineBlocks: number; maxCreditsBaseUnits: number }) =>
        askMutation.mutateAsync(input),
      [askMutation]
    ),
    isAsking: askMutation.isLoading,

    refund: useCallback((credits: number) => refundMutation.mutateAsync(credits), [refundMutation]),
    isRefunding: refundMutation.isLoading
  };
}
