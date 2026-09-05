import type { Entry } from '@hive/common-hiveio-packages/wax';
import { registerCache } from '@/blog/lib/cache-registry';
import type { TtlCacheStats } from '@/blog/lib/server-ttl-cache';

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
/**
 * ★★★ THE SAME RESIDENCY BUG THIS FILE'S BOUNDS DID NOT COVER (2026-09-05, box
 * memory pass). "Bounded, TTL'd" above describes a value's LIFETIME; it said
 * nothing about how long a DEAD value stays RESIDENT, and those stopped being
 * the same thing under crawler load.
 *
 * Removal here happened in exactly two places: `anonymousAccountPostsSeed`
 * returning null on a read past the TTL, and the insertion-order eviction below
 * at `ACCOUNT_POSTS_SEED_MAX`. Crawlers walk DISTINCT accounts (measured
 * 2026-09-05: ~870 profile renders/hour over 868 distinct accounts), so a key is
 * essentially never read a second time and the first path never fires. The map
 * therefore filled to 300 and stayed there, holding trimmed pages that expired
 * five minutes ago: 300 x ~127 KB ~= 38 MB per worker, x3 workers, of values no
 * reader will ever ask for again.
 *
 * `sweepExpiredSeeds` below is the same fix `lib/server-ttl-cache.ts` carries,
 * for the same reason and with the same guarantees: it runs on WRITE, only past
 * `max/2`, deletes ONLY entries already past `ACCOUNT_POSTS_SEED_MS` (exactly
 * what a read would have rejected), and is bounded. The cap stays as the hard
 * bound. No TTL, no key shape and no read path changes.
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

/**
 * ★ THE COUNTERS LIVE ON `globalThis` TOO, AND THAT IS NOT SYMMETRY FOR ITS OWN
 * SAKE. The Map is already process-wide because two bundled copies of this
 * module must share one cache; counters kept at module scope would then split
 * across those copies and describe a map neither of them wholly owns. Same slot
 * discipline, same reason.
 *
 * `registered` guards registration for the same arithmetic: `allCacheStats`
 * SUMS every registration under a name, which is right for `withTtlCache`
 * instances (genuinely separate Maps) and would DOUBLE-COUNT this one shared Map
 * if each copy registered. So it registers exactly once.
 */
interface SeedCounters {
  sweeps: number;
  swept: number;
  evictions: number;
  registered: boolean;
}
const COUNTERS_SLOT = '__lumenAccountPostsSeedCounters';
function counters(): SeedCounters {
  const g = globalThis as unknown as Record<string, SeedCounters | undefined>;
  if (!g[COUNTERS_SLOT]) g[COUNTERS_SLOT] = { sweeps: 0, swept: 0, evictions: 0, registered: false };
  return g[COUNTERS_SLOT] as SeedCounters;
}

/**
 * Reclaim entries already past `ACCOUNT_POSTS_SEED_MS` — see this module's
 * header. Bounded twice: the walk cannot exceed `ACCOUNT_POSTS_SEED_MAX` because
 * the caller re-establishes that bound on every write, and it stops as soon as
 * `size` is back under half the cap.
 *
 * Deletes ONLY what `anonymousAccountPostsSeed` would already refuse to serve,
 * so this changes WHEN an entry goes, never WHETHER a reader could have had it.
 */
function sweepExpiredSeeds(cache: Map<string, SeedEntry>, now: number): void {
  const half = Math.max(1, Math.floor(ACCOUNT_POSTS_SEED_MAX / 2));
  if (cache.size <= half) return;
  const c = counters();
  c.sweeps++;
  for (const [key, entry] of cache) {
    if (now - entry.at < ACCOUNT_POSTS_SEED_MS) continue;
    cache.delete(key);
    c.swept++;
    if (cache.size <= half) break;
  }
}

/** Counters for `/api/debug/mem`; `inFlight` is always 0 (this cache never loads). */
export function accountPostsSeedStats(): TtlCacheStats {
  const c = counters();
  return { size: store().size, inFlight: 0, sweeps: c.sweeps, swept: c.swept, evictions: c.evictions };
}

export function accountPostsSeedKey(sort: string, account: string): string {
  return `${sort}|${account.toLowerCase()}`;
}

/** Write the anonymous page-1 result (call ONLY for a signed-out request, first page). */
export function rememberAccountPostsSeed(
  sort: string,
  account: string,
  entries: Entry[],
  // `now` is injectable for the same reason `anonymousAccountPostsSeed` already
  // takes it: the TTL here is five MINUTES, so a test that could not move the
  // clock could not reach the expiry path at all. Production callers omit it.
  now: number = Date.now()
): void {
  if (!entries || entries.length === 0) return;
  const cache = store();
  // Reclaim the already-expired before adding to the pile, so the hard bound
  // below only ever evicts when the map is genuinely full of LIVE seeds.
  sweepExpiredSeeds(cache, now);
  // Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= ACCOUNT_POSTS_SEED_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      counters().evictions++;
    }
  }
  cache.set(accountPostsSeedKey(sort, account), { entries, at: now });
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
  const c = counters();
  c.sweeps = 0;
  c.swept = 0;
  c.evictions = 0;
}

// Registered once per process — see `SeedCounters.registered` for why a guard is
// required here and not for the `withTtlCache` instances in `cached-api.ts`.
if (!counters().registered) {
  counters().registered = true;
  registerCache('accountPostsSeed', accountPostsSeedStats);
}
