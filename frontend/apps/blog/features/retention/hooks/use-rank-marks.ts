'use client';

import { useQuery } from '@tanstack/react-query';
import { LeagueTier } from '../types';
import { TIERS } from '../lib/tiers';
import { useOwnRankTierSeed } from '../lib/own-rank-tier-context';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RANK AS LUMINOSITY — the same rank, WITHOUT the byline-emblem gate.
 * Illumination SPEC.md §2, the avatar anchor.
 *
 * ★★★ WHY THIS EXISTS RATHER THAN REUSING `useRankMarks`. That hook drops any
 * account whose tier has `showBylineEmblem: false` — ranks 0-4 — because the
 * EMBLEM is a top-of-ladder honour and printing one for rank 1 would devalue it.
 * Correct for the emblem, wrong for the glow: §2 wants a nine-step ramp starting
 * at 0.06, and its whole argument is that the bottom of the ladder must be
 * *nearly* indistinguishable from unlit rather than *absent*. Driving the halo
 * off `useRankMarks` would have lit ranks 5-9 and left 1-4 completely dark — a
 * cliff exactly where the spec asks for a gentle floor.
 *
 * The rank itself was never gated: `/api/streak/marks` returns `rankNumber` for
 * every account asked for, and `useRankMarks` filters client-side. So this needs
 * no new endpoint and no second request — it shares the query key, so React
 * Query issues ONE fetch that both hooks read.
 *
 * ★ RANK 0 IS UNRANKED AND STAYS UNLIT. §2's ramp is defined for 1..9 only. Do
 * not stretch it to include 0: an unranked account must sit below rank 1, not on
 * it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const RANK_LUMINOSITY: Record<number, number> = {
  1: 0.06,
  2: 0.16,
  3: 0.27,
  4: 0.38,
  5: 0.5,
  6: 0.62,
  7: 0.74,
  8: 0.87,
  9: 1
};

/** `account` (lowercased) -> `--l`, the §2 luminosity for that rank. */
export function useRankLuminosity(authors: string[]): Map<string, number> {
  const key = [...new Set(authors.filter(Boolean).map((a) => a.toLowerCase()))].sort();

  const { data } = useQuery({
    // ★ THE SAME KEY `useRankMarks` USES, deliberately: both hooks want the same
    // answer for the same accounts, so they must share one request and one cache
    // entry. A different key here would double every feed page's rank traffic.
    queryKey: ['rank-marks', key.join(',')],
    queryFn: async () => {
      const res = await fetch(`/api/streak/marks?users=${encodeURIComponent(key.join(','))}`);
      if (!res.ok) return { marks: {} as Record<string, { tier: string; rankNumber: number; showMark: boolean }> };
      return (await res.json()) as {
        marks: Record<string, { tier: string; rankNumber: number; showMark: boolean }>;
      };
    },
    enabled: key.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: false
  });

  const out = new Map<string, number>();
  for (const [account, m] of Object.entries(data?.marks ?? {})) {
    const l = RANK_LUMINOSITY[m.rankNumber];
    if (l === undefined) continue; // rank 0 / unknown: unlit, no entry
    out.set(account.toLowerCase(), l);
  }
  return out;
}

/**
 * The signed-in viewer's OWN tier, from the fast rank snapshot — UNGATED by the
 * byline-emblem rule, unlike `useRankMarks`.
 *
 * ★ WHY IT EXISTS (2026-09-03, owner-reported: "the left navbar spark loads
 * slow"). The left-rail showcase reads the viewer's full standing from
 * `/api/streak/[user]`, which is a chain fan-out measured live at 4-11s COLD
 * (0.14s warm) — so on a cold cache the block shimmers for seconds. But the
 * viewer's TIER is already in `/api/streak/marks`, which reads only the
 * `lumen_hive_rank` snapshot and answers in ~0.12s, and a tier is all the
 * showcase needs to paint the emblem, the rung name and "rank N of 9"
 * (`useRankNaming` takes the tier alone). So this hook lets the block paint its
 * identity instantly and fill the ring and streak in when the slow read lands.
 *
 * ★ SAME COMPUTATION, SO NO "TWO CONTRADICTING RANKS" RISK. The snapshot this
 * reads is WRITTEN by `/api/streak/[user]` (see the note on `useRankMarks`), so
 * the instant tier can differ from the full read only by being older, never by
 * being computed differently — and a rank moves over weeks, so in practice they
 * agree. This costs one cheap snapshot read per viewer (~0.12s, `staleTime` 10
 * min so once per 10 min per viewer, deduped across navigations); it does NOT
 * share `useRankMarks`' cache entry (that hook keys on the sorted author LIST,
 * `['rank-marks', a.join(',')]`, while this keys on the single viewer name), so
 * the caller should gate it on `enabled` to skip the read entirely when the full
 * summary is already in hand and this row will never render.
 *
 * Returns null when the viewer has no snapshot yet (a brand-new account whose
 * streak was never computed) — the caller then falls back to its skeleton.
 *
 * ★★★ SSR-SEEDED (C-B, 2026-09-05). `app/layout.tsx` reads this same snapshot
 * server-side (`own-rank-tier-seed.ts`, no HTTP hop) and hands it down via
 * `OwnRankTierProvider` so this query has data on the SERVER render itself,
 * not only after the client's own `/api/streak/marks` round trip resolves —
 * without it, `league-showcase.tsx` painted `ShowcaseSkeleton` on every cold
 * load regardless of how fast the client fetch was, because a fetch cannot
 * beat the first paint it is triggered from.
 *
 * The `seed.username === key` guard is the same money-correctness pattern
 * `use-wallet-account.ts` uses for its own SSR seed: the context is a single
 * value, not keyed by username, so it must never be applied to a query for a
 * DIFFERENT viewer than the one it was fetched for (a session change on the
 * client, or a `username` that arrives before `identity` has settled, must
 * not paint a stranger's tier).
 *
 * Seeded with `initialDataUpdatedAt: 0`, not a real timestamp — same choice
 * `use-wallet-account.ts` and `profile-main.tsx` make and for the same reason
 * (see feedback_isloading_lies_with_initialdata): the query is marked
 * immediately stale so it still revalidates against the client's own fetch in
 * the background, this can only ever replace a slightly-stale seed with a
 * fresher answer sooner, never show a stale one longer.
 */
export function useOwnRankTier(username: string, enabled = true): LeagueTier | null {
  const key = (username || '').toLowerCase();
  const seed = useOwnRankTierSeed();
  const seedMatches = seed && seed.username === key;
  const initialData = seedMatches
    ? { marks: { [key]: { tier: seed.tier, rankNumber: seed.rankNumber, showMark: seed.showMark } } }
    : undefined;

  const { data } = useQuery({
    queryKey: ['rank-marks', key],
    queryFn: async () => {
      const res = await fetch(`/api/streak/marks?users=${encodeURIComponent(key)}`);
      if (!res.ok) return { marks: {} as Record<string, { tier: string; rankNumber: number; showMark: boolean }> };
      return (await res.json()) as {
        marks: Record<string, { tier: string; rankNumber: number; showMark: boolean }>;
      };
    },
    enabled: key.length > 0 && enabled,
    staleTime: 10 * 60 * 1000,
    retry: false,
    initialData,
    initialDataUpdatedAt: initialData ? 0 : undefined
  });

  const m = data?.marks?.[key];
  return m ? toTier(m.tier) : null;
}
