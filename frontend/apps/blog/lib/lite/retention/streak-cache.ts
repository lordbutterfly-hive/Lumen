import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * ════ THE STREAK ROUTE'S IN-PROCESS CACHE ════
 *
 * ★★ IT LIVES HERE, OUTSIDE THE ROUTE, FOR ONE REASON: THE GOAL WRITE HAS TO BE ABLE TO
 * INVALIDATE IT (bug found 2026-08-09 by a UX agent, runtime-proven).
 *
 * Symptom, exactly as measured: `POST /api/retention/goal {goal:2}` answered
 * `200 {"goal":2}` instantly, and then the daily card AND the streak API kept reporting
 * `0/4` and "Day 2 holds when you reach 4 today" through hard reloads at 19s, 47s, 122s and
 * 256s, flipping only at 320s.
 *
 * Cause: the goal moved server-side the same day it started GATING THE STREAK, so a goal
 * change now changes a cached, chain-derived answer — and the cache was a module-private
 * `Map` inside the route with a 5-minute TTL and no invalidation path. A Next App Router
 * route module may only export HTTP handlers, so the goal route had no way to reach it even
 * in principle. The card's `refetch()` after a successful write dutifully re-requested a
 * route that handed back the stale body.
 *
 * The user-visible result is worse than a plain bug: the picker looks like it does nothing,
 * for a duration that depends on when the last cache fill happened. Sometimes it is
 * instant (a cache miss), sometimes it is five minutes. A tester who saw it change
 * instantly, as I did, concludes it works.
 *
 * ★ TWO INDEPENDENT DEFENCES, because one of them is best-effort by nature:
 *
 *   1. `dropStreakCache(account)` — the goal route calls this after a successful write, so
 *      the next read recomputes. One slow request, immediately after the user acted and is
 *      expecting something to change, which is the best possible moment to spend it.
 *   2. `goalUsed` on the entry — a stale-goal HIT is detected and discarded even if (1)
 *      never ran. It has to be here: (1) is process-local, and nothing guarantees the
 *      request that writes the goal lands on the same worker as the request that filled the
 *      cache. Without this the fix would work perfectly on one dev server and intermittently
 *      in production, which is the failure mode hardest to ever see again.
 */

export interface StreakCacheEntry {
  at: number;
  body: unknown;
  /** A negative (account-not-found) entry — see NEG_TTL_MS. */
  notFound?: boolean;
  /**
   * The daily goal this body was computed against.
   *
   * Undefined for a negative entry (nothing was computed) and for a body predating the
   * field. A defined value that DISAGREES with the caller's current goal invalidates the
   * entry — see `readStreakCache`.
   */
  goalUsed?: number;
}

export const STREAK_TTL_MS = 5 * 60 * 1000;
// F-L15: a DEFINITIVE not-found is negative-cached, but for a SHORTER window than a
// positive result and NEVER for a transient upstream failure (that returns 502 and is left
// uncached, so a node hiccup can't pin a real account as missing for 5 minutes).
export const STREAK_NEG_TTL_MS = 60 * 1000;
// F-L15: hard cap. It was an unbounded Map on a public, unauth route — every distinct
// (validated) username added an entry that was never evicted, so walking the username space
// was a slow memory-exhaustion vector. FIFO-evict once over.
export const STREAK_MAX_ENTRIES = 10_000;

const cache = new Map<string, StreakCacheEntry>();

export function writeStreakCache(account: string, entry: StreakCacheEntry): void {
  cache.set(account, entry);
  // Map preserves insertion order, so the first key is the oldest — evict until bounded.
  while (cache.size > STREAK_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * A live entry, or undefined.
 *
 * `currentGoal` is the goal the CALLER just read from the datastore. Pass it and a
 * stale-goal entry is dropped rather than served; omit it and only the TTL applies.
 */
export function readStreakCache(account: string, currentGoal?: number): StreakCacheEntry | undefined {
  const hit = cache.get(account);
  if (!hit) return undefined;
  const ttl = hit.notFound ? STREAK_NEG_TTL_MS : STREAK_TTL_MS;
  if (Date.now() - hit.at >= ttl) return undefined;
  // A negative entry has no goal and is not affected by one.
  if (!hit.notFound && typeof currentGoal === 'number' && typeof hit.goalUsed === 'number' && hit.goalUsed !== currentGoal) {
    cache.delete(account);
    logger.info(
      'streak: cached body for %s was computed against goal %d but the goal is now %d — recomputing',
      account,
      hit.goalUsed,
      currentGoal
    );
    return undefined;
  }
  return hit;
}

/** Forget this account's cached answer. Called by the goal write. Safe if absent. */
export function dropStreakCache(account: string): boolean {
  return cache.delete(account);
}

/** Test seam. */
export function clearStreakCache(): void {
  cache.clear();
}

/** Entry count, for tests and diagnostics. */
export function streakCacheSize(): number {
  return cache.size;
}
