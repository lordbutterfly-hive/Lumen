'use client';

/**
 * Holders, holder count and first trade for `/m/<handle>` (handoff §1). The
 * same data-source getter every other live hook uses; a missing source (the
 * feature not provisioned) reads as unavailable, exactly like an outage.
 */
import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { CreatorPublicStats } from '../types';

export const creatorPublicStatsKey = (creator: string) => ['creatorTokens', 'live', 'publicStats', creator] as const;

export function useCreatorPublicStats(creator: string): { stats: CreatorPublicStats | null; isLoading: boolean } {
  const dataSource = getCreatorTokensDataSource();
  const enabled = Boolean(creator) && dataSource !== null;
  const query = useQuery({
    queryKey: creatorPublicStatsKey(creator),
    queryFn: () => dataSource!.readCreatorPublicStats(creator),
    enabled,
    staleTime: 60_000,
    retry: 1
  });
  return { stats: query.data ?? null, isLoading: enabled && query.isLoading };
}
