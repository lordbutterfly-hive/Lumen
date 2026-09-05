import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { MarketPrice } from '../types';

/**
 * Spot prices for MANY creators in one read, for a price chip on every card.
 *
 * ★ WHY NOT `useTokenPriceChip` PER CARD. That hook is one handle, one query,
 * one round trip. On a feed page that is N requests, which is the N+1 this
 * codebase has already measured and paid for twice. The existing chip avoids it
 * only because `useLiveDiscovery` makes almost every author ineligible for a
 * read — true today, and false the moment creators actually have markets. This
 * hook's cost does not grow when the feature succeeds.
 *
 * ★ ONE QUERY KEY FOR THE WHOLE PAGE, built from the SORTED, de-duplicated
 * handle list. React Query then issues it once however many cards mount, and
 * two components asking for the same set share the result instead of racing.
 * Sorting matters: `[a,b]` and `[b,a]` are the same request and must not be two
 * cache entries.
 *
 * ★ CHUNKING IS THE DATA SOURCE'S JOB, not the caller's. `MAX_STATE_KEYS` is a
 * property of the proxy and the node; a card should never have to know it.
 * Pass whatever handles you have.
 *
 * Every requested handle gets an entry, so a caller can always distinguish
 * "no market" from "not answered yet" — a chip must not render a Buy affordance
 * for a token that cannot be bought, and must not claim a creator has no token
 * because a read failed.
 */
export interface TokenPriceChips {
  /** Keyed by the handle exactly as passed in. */
  prices: Map<string, MarketPrice>;
  /** True while the first read for this handle set is in flight. */
  isLoading: boolean;
}

const STALE_MS = 60_000;

/** The state every handle starts in: asked for, not yet answered. */
const PENDING: MarketPrice = { status: 'unknown', priceUsd: null, health: null };

export function useTokenPriceChips(handles: readonly string[]): TokenPriceChips {
  const dataSource = getCreatorTokensDataSource();

  // Sorted + de-duplicated so the key is stable across render order, and so a
  // page that reshuffles its cards does not refetch.
  const deduped = [...new Set(handles.map((h) => h.trim()).filter((h) => h.length > 0))].sort();
  const wantedKey = deduped.join(',');
  /*
   * ★ T3j (2026-09-04 perf hunt) — STABILISED BY ITS OWN CACHE KEY.
   *
   * `deduped` is a fresh array on every render because `handles` is (every
   * caller passes `list.map((e) => e.author)`), but its CONTENT changes only
   * when `wantedKey` does. `wantedKey` is already the string this hook trusts to
   * decide whether two renders are asking the same question, since it is the
   * React Query key. Keying the array on it makes `wanted` a stable reference
   * for exactly as long as that is true, which is what lets the price map below
   * be memoised at all.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wanted = useMemo(() => deduped, [wantedKey]);
  const enabled = wanted.length > 0 && dataSource !== null;

  const query = useQuery({
    queryKey: ['creator-tokens', 'prices', wantedKey],
    queryFn: () => dataSource!.readMarketPrices(wanted),
    enabled,
    staleTime: STALE_MS
  });

  // A failed read reports `unknown` per handle rather than an empty map, so a
  // caller looping over its own handles never has to special-case "missing".
  //
  // ★ T3j: built once per (handle set, query result) rather than once per render
  // of the list. React Query returns the same `data` reference while its cache
  // entry is untouched, so those two are the whole dependency set. The VALUES
  // were already reference-stable (they come straight off `query.data`, or the
  // shared `PENDING` constant), which is why `MediumPostCard`'s comparator can
  // compare `price` by reference; this makes the map holding them stable too.
  const data = query.data;
  const prices = useMemo(() => {
    const out = new Map<string, MarketPrice>();
    for (const handle of wanted) {
      out.set(handle, data?.get(handle) ?? PENDING);
    }
    return out;
  }, [wanted, data]);

  const isLoading = enabled && query.isLoading;
  // The RESULT OBJECT is memoised too, so a caller that ever puts it in a
  // dependency array does not re-fire on every render of its list.
  return useMemo(() => ({ prices, isLoading }), [prices, isLoading]);
}
