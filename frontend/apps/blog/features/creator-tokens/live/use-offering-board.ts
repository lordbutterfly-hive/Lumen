'use client';

/**
 * The Meritum landing page's left-rail board: up to ten creators, each showing
 * ONE of their live offerings, cycling like a departures board.
 *
 * ★ THE SELECTION IS RANDOM, AND IT IS FROZEN PER MOUNT. A board that re-rolled
 * on every render would reshuffle whenever any unrelated state changed, and a
 * reader who spotted something interesting would watch it vanish mid-reach.
 * `useState(() => ...)` runs the shuffle exactly once for the life of the
 * component, so the ROWS are stable and only the offering WITHIN a row moves.
 *
 * ★ RANDOM, NOT RANKED, ON PURPOSE. `use-live-discovery` ranks in SQL — proven
 * creators first — and that ordering is the product's claim about what a token
 * is worth holding. Re-using it here would make this a second, quieter ranking
 * surface that nobody maintains. This is a sampler: it says "here is some of
 * what is on sale", and it says so without implying an order.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { useLiveDiscovery } from './use-live-discovery';
import type { BoardCreator } from '../types';

/**
 * ★ MARKETS THE BOARD NEVER ADVERTISES (owner, 2026-09-11: "remove hbd temp from
 * it since that's a test account").
 *
 * These are real, registered, tradeable markets on mainnet — they cannot be
 * filtered at the contract, and they SHOULD still be reachable at their own URL
 * and in the discovery list, which is an index rather than a shop window. What
 * they must not be is PROMOTED: the board is the landing page's recommendation of
 * what to go and buy, and pointing a first-time visitor at a test market is the
 * worst first impression this product can make.
 *
 * Matched on the BARE handle, because discovery returns `hive:hbd-temp` while the
 * name a person recognises is `hbd-temp` — comparing the raw key would silently
 * match nothing, which is the identity drift that has already bitten this feature
 * four times. Keep the list short and keep the reason next to each entry; a
 * growing unexplained denylist is how a real creator eventually disappears from
 * the product with nobody able to say why.
 */
const NEVER_PROMOTED = new Set([
  'hbd-temp' // the owner's own test market, used to prove the rails
]);

/** The board never shows more than this many rows, however many creators exist. */
export const BOARD_MAX_ROWS = 10;

/**
 * How many creators to ASK the chain about. Larger than the row cap so a board
 * of ten can still be filled when some of the sampled creators turn out to have
 * an empty shop — their rows are dropped after the read, not before it.
 */
const SAMPLE_POOL = 24;

const boardKey = (creators: string[]) => ['creatorTokens', 'live', 'offeringBoard', ...creators];

/** Fisher-Yates on a copy. Never mutates the discovery array, which react-query owns. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface OfferingBoard {
  /** Creators with at least one live offering, capped at BOARD_MAX_ROWS. Empty until loaded. */
  rows: BoardCreator[];
  isLoading: boolean;
  /** No contract in this build, or the reads failed. The board renders NOTHING in either case. */
  unavailable: boolean;
}

export function useOfferingBoard(): OfferingBoard {
  const dataSource = getCreatorTokensDataSource();
  const discovery = useLiveDiscovery(SAMPLE_POOL);

  // The shuffle seed: a stable, mount-scoped permutation of whatever discovery
  // returned. Recomputed only when the set of creator NAMES actually changes,
  // not when their stats do — a price tick must not reshuffle the board.
  const names = useMemo(
    () => discovery.creators.map((c) => c.creator).filter(Boolean).sort().join(','),
    [discovery.creators]
  );
  const [seed] = useState(() => Math.random());
  const sample = useMemo(() => {
    const all = names === '' ? [] : names.split(',');
    if (all.length === 0) return [];
    // Deterministic given (names, seed) so the memo is honest: the same inputs
    // always produce the same sample, and only a genuinely new creator set or a
    // remount changes it.
    const rotated = all.slice(Math.floor(seed * all.length)).concat(all.slice(0, Math.floor(seed * all.length)));
    return shuffled(rotated).slice(0, SAMPLE_POOL);
  }, [names, seed]);

  const query = useQuery({
    queryKey: boardKey(sample),
    queryFn: () => dataSource!.readOfferingBoard(sample),
    enabled: dataSource !== null && sample.length > 0,
    // The shop changes on the scale of a creator editing it, not per block.
    staleTime: 120_000
  });

  const rows = useMemo(
    () =>
      (query.data ?? [])
        .filter((r) => r.offerings.length > 0)
        .filter((r) => !NEVER_PROMOTED.has(r.creator.startsWith('hive:') ? r.creator.slice(5) : r.creator))
        .slice(0, BOARD_MAX_ROWS),
    [query.data]
  );

  return {
    rows,
    isLoading: discovery.isLoading || query.isLoading,
    // A failed read is NOT an empty board with a message — on a landing page's
    // left rail there is no room to explain, and a broken box is worse than no
    // box. The caller renders nothing.
    unavailable: dataSource === null || discovery.failed || query.isError
  };
}
