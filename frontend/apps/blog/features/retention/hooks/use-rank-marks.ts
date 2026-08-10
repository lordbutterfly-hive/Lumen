'use client';

import { useQuery } from '@tanstack/react-query';
import { LeagueTier } from '../types';
import { TIERS } from '../lib/tiers';

/**
 * Byline marks for a page of authors, in ONE request.
 *
 * Reads `/api/streak/marks`, which reads only the `lumen_hive_rank` snapshot — no Hive
 * calls, no computation, no fan-out however long the page is. See that route for why the
 * mark had to be built this way rather than by looping the per-account route.
 *
 * ★ THE RANK COMES FROM THE SAME COMPUTATION THE PROFILE USES. That is the entire reason
 * this hook exists instead of a cheap per-post derivation: the previous feed emblem used
 * `bylineTierFromReputation(post.author_reputation)`, a different function, and one person
 * carried two contradicting ranks in a single session (@taskmaster4450 read Beacon in the
 * feed and Torch on his profile). The snapshot is written by `/api/streak/[user]`, so a
 * mark can disagree with a profile only by being older — never by being computed
 * differently — and the server's TTL drops it before that gets far.
 */

export interface RankMark {
  tier: LeagueTier;
  rankNumber: number;
  showMark: boolean;
}

/** Only ids the ladder actually knows survive; anything else is dropped, not defaulted. */
function toTier(raw: string): LeagueTier | null {
  return (Object.values(LeagueTier) as string[]).includes(raw) ? (raw as LeagueTier) : null;
}

export function useRankMarks(authors: string[]): Map<string, RankMark> {
  // Sorted + deduped so two pages with the same authors in a different order share one
  // cache entry rather than issuing two identical requests.
  const key = [...new Set(authors.filter(Boolean).map((a) => a.toLowerCase()))].sort();

  const { data } = useQuery({
    queryKey: ['rank-marks', key.join(',')],
    queryFn: async () => {
      const res = await fetch(`/api/streak/marks?users=${encodeURIComponent(key.join(','))}`);
      if (!res.ok) return { marks: {} as Record<string, { tier: string; rankNumber: number; showMark: boolean }> };
      return (await res.json()) as {
        marks: Record<string, { tier: string; rankNumber: number; showMark: boolean }>;
      };
    },
    enabled: key.length > 0,
    // A rank moves over weeks. Re-fetching per navigation would be pure waste.
    staleTime: 10 * 60 * 1000,
    // The mark is decoration: a failed read must render nothing, never retry-storm.
    retry: false
  });

  const out = new Map<string, RankMark>();
  for (const [account, m] of Object.entries(data?.marks ?? {})) {
    const tier = toTier(m.tier);
    if (!tier) continue;
    // Trust the ladder over the snapshot for the DISPLAY rule: `show_mark` is a
    // denormalised copy, and if the ladder's boundary ever moves, the live table is the
    // authority. The snapshot still decides WHICH rung.
    if (!TIERS[tier].showBylineEmblem) continue;
    out.set(account.toLowerCase(), { tier, rankNumber: m.rankNumber, showMark: true });
  }
  return out;
}
