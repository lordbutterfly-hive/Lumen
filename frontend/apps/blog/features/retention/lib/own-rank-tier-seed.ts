import { listRankMarks } from '@/blog/lib/lite/repositories/hive-retention-repository';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { getLogger } from '@ui/lib/logging';
import { LeagueTier } from '../types';

const logger = getLogger('app');

/**
 * SERVER-ONLY. SSR seed for `useOwnRankTier` (C-B, 2026-09-05, owner: "the left
 * navbar spark loads slow").
 *
 * `league-showcase.tsx` already has a fast, CLIENT-side path for this — see
 * `useOwnRankTier`'s own doc — that reads `/api/streak/marks`, which reads only
 * the `lumen_hive_rank` snapshot (migration 0029): one indexed SELECT, zero Hive
 * calls, measured ~0.12s round trip / ~10ms of that is the query itself. That
 * still means every cold `/` load draws the loading `ShowcaseSkeleton` for one
 * client round trip before `ShowcaseInstant` can paint. This reads the SAME
 * snapshot directly from the repository (`listRankMarks`, no HTTP hop) inside
 * the root layout's server render, so `app/layout.tsx` can hand the answer down
 * as `initialData` and the rail paints its tier with the FIRST byte.
 *
 * ★ DELIBERATELY DUPLICATED RATHER THAN IMPORTED FROM THE ROUTE (same choice
 * `wallet-summary-seed.ts` makes, same reason): this lives under
 * `features/retention/`, the route under `app/api/streak/marks/`, and this
 * task's slice is scoped to the former only.
 *
 * ★ `toTier` IS COPIED FROM `use-rank-marks.ts`, NOT IMPORTED. That file opens
 * with `'use client'`; pulling a value import from it into server-only code run
 * from `app/layout.tsx` would drag a client module boundary into the root
 * layout's server graph for a two-line validity check. Same tier list
 * (`LeagueTier`), so the two cannot disagree about what a valid id looks like —
 * only the copy-vs-import choice differs.
 *
 * Never throws — a rank tier is decoration (same as the byline mark this
 * snapshot already serves): any failure here just means "no seed", and
 * `useOwnRankTier`'s existing unseeded client fetch runs exactly as it does
 * today.
 */

/** Mirrors use-rank-marks.ts's own guard — only ids the ladder actually knows survive. */
function toTier(raw: string): LeagueTier | null {
  return (Object.values(LeagueTier) as string[]).includes(raw) ? (raw as LeagueTier) : null;
}

// Matches the account shape use-rank-marks.ts/streak/marks route already validate against.
const USERNAME_RE = /^[a-z0-9.-]{3,16}$/;

/** How long to memoize one viewer's snapshot read in this process. Matches the
 * `/api/streak/marks` route's own `cache-control: public, max-age=60` — a rank
 * moves over weeks, so a minute of staleness here costs nothing and collapses
 * repeat page-to-page navigations by the same signed-in viewer onto one query. */
const SEED_MEMO_MS = 60_000;

export interface OwnRankTierSeed {
  /** Lowercased, so the consumer's own key comparison never case-mismatches. */
  username: string;
  tier: LeagueTier;
  rankNumber: number;
  showMark: boolean;
}

export async function fetchOwnRankTierSeed(username: string): Promise<OwnRankTierSeed | null> {
  const key = username.trim().toLowerCase();
  if (!USERNAME_RE.test(key)) return null;
  try {
    return await cachedRead(`rank-tier-seed:${key}`, SEED_MEMO_MS, async () => {
      const [row] = await listRankMarks([key]);
      if (!row) return null; // No snapshot yet — same "not computed" case the route itself documents.
      const tier = toTier(row.tier);
      if (!tier) return null;
      return { username: key, tier, rankNumber: row.rankNumber, showMark: row.showMark };
    });
  } catch (error) {
    logger.warn(error, 'own rank tier seed failed for %s; client will fetch it instead', key);
    return null;
  }
}
