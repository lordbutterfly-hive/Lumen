'use client';

/**
 * How far behind the Magi indexer is, for screens that render indexer-backed
 * data as if it were current.
 *
 * ★★★ WHY (2026-08-25). The indexer was found ~17 hours / ~20,100 blocks behind
 * the node on a live build, and `/creators` showed its rows with nothing saying
 * so — no code in this feature read `indexer_health` at all. The existing
 * honest-degradation paths all trigger on FAILURE (`readDiscovery` rejects when
 * the indexer is unreachable; `unavailable ≠ empty` is enforced everywhere),
 * and a lagging indexer does not fail. It answers, correctly and quickly, with
 * old data. That is the one outage shape the design had no signal for.
 *
 * See `IndexerHealth` for why the lag is a BLOCK difference and never a
 * comparison against the viewer's clock.
 */

import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import { MS_PER_BLOCK } from '../lib/contract-math';
import type { IndexerHealth } from '../types';

const healthKey = ['creatorTokens', 'live', 'indexerHealth'];

/**
 * 600 blocks — 30 minutes at Magi's 3s blocks — before we say anything.
 *
 * Deliberately generous. A healthy indexer sits within seconds of the node, so
 * anything approaching half an hour is a real problem, while a threshold tight
 * enough to catch ordinary catch-up jitter would put a warning banner on a
 * working page and teach readers to ignore it. The lag this was written for was
 * 20,100 blocks, so it is not a close call in the case that matters.
 */
export const LAG_BLOCKS_THRESHOLD = 600;

export interface IndexerLag extends IndexerHealth {
  /** true only when we KNOW it is behind. Unknown is never stale — and never fresh either. */
  stale: boolean;
  /** Rough wall-clock equivalent of `blocksBehind`, for copy. null when unknown. */
  behindMs: number | null;
}

/**
 * Polls on the same cadence as `use-live-discovery` so the badge and the rows it
 * annotates cannot drift into disagreeing about the same moment.
 */
export function useIndexerHealth(): IndexerLag {
  const dataSource = getCreatorTokensDataSource();

  const query = useQuery({
    queryKey: healthKey,
    queryFn: () => dataSource!.readIndexerHealth(),
    enabled: dataSource !== null,
    staleTime: 60_000,
    refetchInterval: 120_000,
    // This is an annotation on someone else's screen. One quiet retry, then
    // fall back to "cannot tell" — never a spinner, never an error surface.
    retry: 1
  });

  const health: IndexerHealth = query.data ?? {
    available: false,
    lastUpdate: null,
    indexerBlock: null,
    nodeBlock: null,
    blocksBehind: null
  };

  const behind = health.blocksBehind;
  return {
    ...health,
    stale: behind !== null && behind > LAG_BLOCKS_THRESHOLD,
    behindMs: behind === null ? null : behind * MS_PER_BLOCK
  };
}

/** "17 hours" / "42 minutes" — coarse on purpose; a precise figure would imply a precision block-counting does not have. */
export function describeLag(behindMs: number | null): string | null {
  if (behindMs === null) return null;
  const minutes = Math.round(behindMs / 60_000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
