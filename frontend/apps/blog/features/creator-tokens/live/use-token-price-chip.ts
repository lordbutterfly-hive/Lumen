'use client';

/**
 * The cheapest possible answer to "does this handle have a creator token, and
 * what does it cost right now" — for the small chip that sits next to an
 * author's name in a feed row, a post byline, or the signed-in reader's own
 * name in the header. Everything else about a market (position, offerings,
 * delivery record, price history) is a bigger read meant for the token PAGE
 * (useLiveTokenMarket) or the STUDIO (useLiveStudio); a byline chip only ever
 * needs the one number, so this fetches only `readMarket`.
 *
 * SAME CACHE ENTRY AS THE TOKEN PAGE, ON PURPOSE. This uses
 * use-live-token-market.ts's own `creatorMarketKey`, so a reader who has
 * already opened @gtg's token page this session sees their feed chip render
 * from cache instantly, and a feed page with twenty posts by the same author
 * fires exactly ONE chain read for all twenty chips, not twenty — react-query
 * dedupes identical query keys regardless of how many components ask for one.
 *
 * FOUR POSSIBLE ANSWERS, not two. A UI deciding whether to draw a small pill
 * cannot act on "no" and "we don't know yet" as if they were the same thing —
 * see TokenAuthorChip's own doc for why the chip renders on 'ready' only and
 * treats the other three identically (nothing drawn):
 *   - 'unknown'  the feature isn't provisioned in this build, OR the chain
 *                read itself failed (readMarket resolves phase 'UNKNOWN'
 *                rather than throwing on a failed read — see vsc-data-source
 *                .ts's readMarket doc).
 *   - 'loading'  the first read for this handle hasn't resolved yet.
 *   - 'none'     resolved, and this creator has never registered a market.
 *   - 'ready'    resolved, with a live price.
 */

import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { usdFromHbd } from './adapt';
import { creatorMarketKey } from './use-live-token-market';
import type { Market } from '../types';

const STALE_MS = 15_000;
const REFETCH_MS = 30_000;

export type TokenPriceChipStatus = 'unknown' | 'loading' | 'none' | 'ready';

export interface TokenPriceChip {
  status: TokenPriceChipStatus;
  /** Non-null only when status === 'ready'. */
  priceUsd: number | null;
}

export function useTokenPriceChip(handle: string): TokenPriceChip {
  const dataSource = getCreatorTokensDataSource();
  const trimmed = handle.trim();
  const enabled = trimmed.length > 0 && dataSource !== null;

  const query = useQuery({
    queryKey: creatorMarketKey(trimmed),
    queryFn: () => dataSource!.readMarket(trimmed),
    enabled,
    staleTime: STALE_MS,
    // ★ STOP POLLING ONCE THE ANSWER CANNOT CHANGE (O6 build map item 6,
    // 2026-08-13). `readMarket` never throws on a failed chain/indexer read —
    // it CATCHES and resolves `unknownMarket()` (`vsc-data-source.ts`) so the
    // chip never renders broken mid-outage. But that means react-query always
    // sees a "success", so its own `retry`/backoff never engages — a constant
    // 30s number here polled a DEAD backend forever, on every page, for the
    // rest of the session: measured live, 2 POSTs per refetch (`getStateByKeys`
    // + `getHeadBlock` in one `Promise.all`) against an indexer that was 502ing
    // throughout, including on routes with no creator-token UI at all
    // (`/witnesses`). This hook has three callers (this file's own doc), all
    // deduping onto the same `creatorMarketKey`, so the fix belongs here, not
    // in any one caller — `site-header/user-menu.tsx` picks it up for free.
    //
    // Cadence is data-driven, not a constant: keep polling only while the last
    // resolved answer was a LIVE market. `null` (this creator has never
    // registered one — not a fact that changes on a clock) and `'UNKNOWN'`
    // (the read itself failed) both stop the interval. `data === undefined`
    // (no answer yet — first mount, or `enabled` just flipped true) keeps the
    // original constant cadence so the FIRST successful read is never starved.
    // A later remount (e.g. navigating away and back) still fires that one-time
    // mount read, so "no market -> has market" is never permanently missed —
    // only the blind, indefinite repeat against a known-bad or known-empty
    // answer is.
    refetchInterval: (data: Market | null | undefined) => {
      if (data === undefined) return REFETCH_MS;
      if (data === null) return false;
      if (data.phase === 'UNKNOWN') return false;
      return REFETCH_MS;
    },
    // One retry, same reasoning as discovery: a chip that hangs through three
    // backoffs on a busy feed reads as broken, and readMarket already has its
    // own honest 'UNKNOWN' fallback for a failed read.
    retry: 1
  });

  if (!enabled) return { status: 'unknown', priceUsd: null };

  // `data === undefined` — not `isLoading` — is the robust "no confident
  // answer yet" check: it is true for a first fetch in flight AND doesn't
  // depend on react-query's `isLoading`/`isPending` semantics matching a
  // particular major version's exact definition when a query is disabled.
  if (query.data === undefined) {
    return { status: query.isError ? 'unknown' : 'loading', priceUsd: null };
  }
  if (query.data === null) return { status: 'none', priceUsd: null };
  if (query.data.phase === 'UNKNOWN') return { status: 'unknown', priceUsd: null };

  return { status: 'ready', priceUsd: usdFromHbd(query.data.spotPriceHbd) };
}
