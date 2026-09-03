import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ★★★ ANONYMOUS ACCOUNT-POSTS SEED CACHE, SHARED BETWEEN /api/account-posts AND
 * THE PROFILE RENDER (2026-09-03). Replaces the reverted PROFILE_SEED_LOOPBACK.
 *
 * WHY. The profile Posts/Feed tabs seed page 1 with a getAccountPosts wax read
 * issued DURING the RSC render; that read fails in the render context, so the
 * posts are absent from the SSR HTML and the browser refetches ~1.4s later. The
 * first fix self-fetched /api/account-posts from the render - which, per profile
 * render under crawler load on a single-process server, starved the event loop
 * and 502'd the origin. So the render must NOT do any network here.
 *
 * Instead: the /api/account-posts route (isolated handler, where the chain read
 * works) WRITES the anonymous page-1 result into this cache, and the profile
 * render READS it - a process-local map lookup, zero network, zero self-fetch.
 * This is exactly the topic-cache pattern (lib/feed/topic-cache.ts) and carries
 * the same guarantees: bounded, TTL'd, and served stale until the client's own
 * fetch refreshes it. Cold miss = the page falls through to today's client
 * fetch, which then populates this cache for the next reader.
 *
 * ★ ON globalThis, NOT A MODULE-LEVEL Map. Next bundles the route and the render
 * as separate server chunks; a module-level Map would be TWO maps that never see
 * each other (topic-cache.ts and viewer-warmer.ts document the same trap). The
 * process-wide slot is the only thing both chunks share - and getting this wrong
 * is precisely why a render-time read would otherwise never see a route write.
 *
 * ★ ANONYMOUS ONLY. The key carries no viewer; only the route's signed-OUT
 * answer is written here, and only a signed-OUT render reads it. A signed-in
 * reader's answer carries their own block list and vote, which only the route
 * applies per-request - they are never seeded from this shared cache.
 */
export const ACCOUNT_POSTS_SEED_MS = 300_000; // 5 min, matches the topic cache
export const ACCOUNT_POSTS_SEED_MAX = 300; // bounded so a crawler cannot grow it unbounded

interface SeedEntry {
  entries: Entry[];
  at: number;
}

const SLOT = '__lumenAccountPostsSeedCache';
function store(): Map<string, SeedEntry> {
  const g = globalThis as unknown as Record<string, Map<string, SeedEntry> | undefined>;
  if (!g[SLOT]) g[SLOT] = new Map<string, SeedEntry>();
  return g[SLOT] as Map<string, SeedEntry>;
}

export function accountPostsSeedKey(sort: string, account: string): string {
  return `${sort}|${account.toLowerCase()}`;
}

/** Write the anonymous page-1 result (call ONLY for a signed-out request, first page). */
export function rememberAccountPostsSeed(sort: string, account: string, entries: Entry[]): void {
  if (!entries || entries.length === 0) return;
  const cache = store();
  // Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= ACCOUNT_POSTS_SEED_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(accountPostsSeedKey(sort, account), { entries, at: Date.now() });
}

/** The cached anonymous page-1 entries for (sort, account) if still fresh, else null. */
export function anonymousAccountPostsSeed(
  sort: string,
  account: string,
  now: number = Date.now()
): Entry[] | null {
  const hit = store().get(accountPostsSeedKey(sort, account));
  if (!hit) return null;
  if (now - hit.at >= ACCOUNT_POSTS_SEED_MS) return null;
  // Touch so the hottest profiles are not the first evicted (same LRU refresh
  // the topic cache does on read).
  const cache = store();
  cache.delete(accountPostsSeedKey(sort, account));
  cache.set(accountPostsSeedKey(sort, account), hit);
  return hit.entries;
}

/** Visible for tests. */
export function resetAccountPostsSeedCache(): void {
  store().clear();
}
