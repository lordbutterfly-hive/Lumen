'use client';

/**
 * The ranked creator list, from the Magi indexer's `lumen_ct_discovery` view.
 *
 * THE RANKING IS NOT DONE HERE, ON PURPOSE. The view orders in SQL — proven
 * creators first, then completion rate, then rating, then responsiveness — and
 * this hook preserves that order verbatim. Sorting client-side would put the
 * product's central claim about what a creator token is worth holding into
 * whichever component last touched the array, and the first person who wanted a
 * "top gainers" tab would only have to change a comparator.
 *
 * Unproven creators are NOT hidden; they sort last. Missing is not the same as
 * perfect, and a new creator should be discoverable without outranking someone
 * who has actually delivered.
 */

import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { CreatorSummary } from '../types';

const discoveryKey = ['creatorTokens', 'live', 'discovery'];

// Discovery moves slowly — a creator's record changes on the scale of jobs, not
// blocks — so this polls far less often than a market page.
const STALE_MS = 60_000;
const REFETCH_MS = 120_000;

export interface LiveDiscovery {
  /** No contract provisioned in this build. */
  unavailable: boolean;
  isLoading: boolean;
  /** The indexer could not be reached. DISTINCT from "nobody has launched a token" — the screen must say which. */
  failed: boolean;
  creators: CreatorSummary[];
}

export function useLiveDiscovery(limit = 60): LiveDiscovery {
  const dataSource = getCreatorTokensDataSource();
  const unavailable = dataSource === null;

  const query = useQuery({
    queryKey: [...discoveryKey, limit],
    queryFn: () => dataSource!.readDiscovery(limit),
    enabled: !unavailable,
    staleTime: STALE_MS,
    refetchInterval: REFETCH_MS,
    // One retry only: discovery is a whole-page read, and a spinner that hangs
    // through three backoffs reads as broken.
    retry: 1
  });

  return {
    unavailable,
    isLoading: query.isLoading,
    failed: query.isError,
    creators: query.data ?? []
  };
}
