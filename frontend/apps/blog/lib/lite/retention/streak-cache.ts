/**
 * ════ THE STREAK ROUTE'S IN-PROCESS CACHE ════
 *
 * It lives here, outside `/api/streak/[user]`, because a Next App Router route module may
 * export nothing but HTTP handlers — so a cache private to that file could not be reached
 * by any other route and, more to the point, could not be unit-tested or cleared by one.
 *
 * ★ IT NO LONGER CARRIES A `goalUsed` DISCRIMINATOR (2026-08-18). The daily goal used to
 * GATE the streak, so a cached body was only valid for the goal it was computed against;
 * `/api/retention/goal` called `dropStreakCache` on every write and every entry carried
 * the goal it had been computed under, because the drop is process-local and a
 * multi-worker deployment can land the write on a worker that never filled the cache.
 * The goal is deleted, so both defences are deleted with it — the body now depends on
 * nothing but the account and the clock.
 *
 * What remains: the fresh TTL, the shorter negative TTL, the LRU bound (this is a public,
 * unauthenticated route, so an unbounded Map keyed by username was a memory-exhaustion
 * vector), and the stale-while-revalidate window with its single-flight lock.
 */

export interface StreakCacheEntry {
  at: number;
  body: unknown;
  /** A negative (account-not-found) entry — see NEG_TTL_MS. */
  notFound?: boolean;
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
/**
 * ════ THE STALE-WHILE-REVALIDATE WINDOW (2026-08-11) ════
 *
 * Measured live: `GET /api/streak/[user]` on a MISS is a real chain fan-out (3-12 upstream
 * Hive calls in practice, not the theoretical ~50), and a single call to the public node
 * this app is configured against routinely takes 1-6 seconds and occasionally 502s from
 * the node's OWN infrastructure — reproduced directly against api.hive.blog, no app code
 * involved. This widget sits in the left rail, i.e. on every page, so every reader whose
 * cache entry had gone stale (past `STREAK_TTL_MS`) was blocking their page on that.
 *
 * An entry between `STREAK_TTL_MS` and `STREAK_STALE_TTL_MS` old is a REAL, previously
 * computed answer — never invented — so the route serves it immediately
 * (`readStaleStreakCache`) and refreshes it in the background instead of blocking the
 * response on a recompute. `provenance.computedAt` already on the wire tells a consumer
 * exactly how old it is, so nothing about this is silent.
 *
 * 30 minutes, deliberately much longer than the 5-minute fresh TTL: the fresh TTL is sized
 * for "don't recompute on every page view within a browsing session"; this one is sized for
 * "don't ever block a page load for an account anyone has looked at recently". A reader who
 * takes an action (posts, comments) may see a stale number for up to one background
 * revalidation cycle — bounded by how often THIS account gets viewed, and self-correcting
 * within seconds of the next view once the background refresh lands.
 */
export const STREAK_STALE_TTL_MS = 30 * 60 * 1000;

const cache = new Map<string, StreakCacheEntry>();
// Single-flight guard for background revalidation, keyed by account. Without this, every
// concurrent page view of the same account during the stale window would fire its own
// background walk — the same upstream-amplification problem the fresh cache already
// solves for the synchronous path, reappearing on the async one.
const revalidating = new Set<string>();

export function writeStreakCache(account: string, entry: StreakCacheEntry): void {
  cache.set(account, entry);
  // Map preserves insertion order, so the first key is the oldest — evict until bounded.
  while (cache.size > STREAK_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** A live entry, or undefined. */
export function readStreakCache(account: string): StreakCacheEntry | undefined {
  const hit = cache.get(account);
  if (!hit) return undefined;
  const ttl = hit.notFound ? STREAK_NEG_TTL_MS : STREAK_TTL_MS;
  if (Date.now() - hit.at >= ttl) return undefined;
  return hit;
}

/**
 * A STALE entry — expired past `STREAK_TTL_MS` but still inside `STREAK_STALE_TTL_MS` —
 * or undefined. See the constant's doc for why this exists.
 *
 * Deliberately excludes `notFound` entries: their TTL is already short (60s), and serving
 * a definitive-not-found answer "stale" buys nothing (re-checking existence is cheap — it
 * fails on the very first upstream call) while risking a renamed/recreated account being
 * told it does not exist for up to 30 minutes instead of 60 seconds.
 *
 */
export function readStaleStreakCache(account: string): StreakCacheEntry | undefined {
  const hit = cache.get(account);
  if (!hit || hit.notFound) return undefined;
  const age = Date.now() - hit.at;
  if (age < STREAK_TTL_MS || age >= STREAK_STALE_TTL_MS) return undefined;
  return hit;
}

/**
 * Claim the right to run this account's background revalidation. Returns false if one is
 * already in flight — the caller must not start a second one. Always pair with
 * `finishRevalidation` (a `finally`), or the account can never revalidate again.
 */
export function tryStartRevalidation(account: string): boolean {
  if (revalidating.has(account)) return false;
  revalidating.add(account);
  return true;
}

/** Release the single-flight lock. Safe to call even if never acquired. */
export function finishRevalidation(account: string): void {
  revalidating.delete(account);
}

/** Test seam. */
export function clearStreakCache(): void {
  cache.clear();
}

/** Entry count, for tests and diagnostics. */
export function streakCacheSize(): number {
  return cache.size;
}
