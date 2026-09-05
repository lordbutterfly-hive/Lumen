import type { TtlCacheStats } from '@/blog/lib/server-ttl-cache';

/**
 * ★★★ A PROCESS-WIDE ROSTER OF THE SERVER CACHES, SO "WHY IS THIS WORKER 1.3 GB?"
 * IS ANSWERABLE WITH `curl` (2026-09-05, box memory pass).
 *
 * The caps in `cached-api.ts` are RESIDENCY commitments (that file's own budget
 * note), and until now the only way to check one against reality was a heap
 * snapshot. This is the cheap instrument instead: every cache registers a getter
 * for its own counters, and `/api/debug/mem` reads the lot.
 *
 * ★ ON `globalThis`, NOT A MODULE-LEVEL Map — AND HERE THAT IS THE WHOLE POINT.
 * Next bundles server code per route, so a module imported by two routes can end
 * up as TWO copies with two separate states that never see each other
 * (`topic-cache.ts` and `viewer-warmer.ts` document the same trap and the same
 * cure). An instrument that quietly measured only ONE copy would be worse than
 * no instrument: it would under-report residency and we would size the caps
 * against a number that is a fraction of the truth. The registry lives in a
 * process-wide slot so every copy lands in the same roster.
 *
 * ★ WHICH IS ALSO WHY `copies` IS REPORTED. Each copy of a module registers its
 * own cache, and for a `withTtlCache` instance those really are DISTINCT Maps
 * holding distinct entries, so their counters are SUMMED and `copies` says how
 * many were added together. A `copies` above 1 is not an error, it is the
 * bundle-duplication fact made visible — and it means the real per-worker
 * residency for that cache is the summed figure, not one cap.
 *
 * A cache whose state already lives on `globalThis` (the account-posts seed
 * cache) must therefore register EXACTLY ONCE, or summing would count the same
 * shared Map twice; those guard their registration on their own slot.
 */
export type CacheStatsFn = () => TtlCacheStats;

export interface RegisteredCacheStats extends TtlCacheStats {
  /** How many module copies registered under this name; see the note above. */
  copies: number;
}

const SLOT = '__lumenCacheRegistry';

function registry(): Map<string, CacheStatsFn[]> {
  const g = globalThis as unknown as Record<string, Map<string, CacheStatsFn[]> | undefined>;
  if (!g[SLOT]) g[SLOT] = new Map<string, CacheStatsFn[]>();
  return g[SLOT] as Map<string, CacheStatsFn[]>;
}

/**
 * Register one cache under a stable name, at module scope in the file that owns
 * the cache, so a cache and its instrument cannot drift apart.
 */
export function registerCache(name: string, stats: CacheStatsFn): void {
  const reg = registry();
  const existing = reg.get(name);
  if (existing) existing.push(stats);
  else reg.set(name, [stats]);
}

/**
 * Every registered cache's counters, summed per name. Cheap: each `stats()` is
 * a counter read plus `Map.size`, never an iteration over entries, so this is
 * safe to call from a request handler.
 *
 * ★ AN EMPTY RESULT IS A REAL ANSWER, NOT A FAILURE. A cache registers when its
 * module is first LOADED, which for `cached-api.ts` is the first profile or post
 * render. A worker that has served neither reports nothing here, and that is
 * exactly true: it is holding nothing.
 */
export function allCacheStats(): Record<string, RegisteredCacheStats> {
  const out: Record<string, RegisteredCacheStats> = {};
  for (const [name, fns] of registry()) {
    const total: RegisteredCacheStats = {
      size: 0,
      inFlight: 0,
      sweeps: 0,
      swept: 0,
      evictions: 0,
      copies: fns.length
    };
    for (const fn of fns) {
      const s = fn();
      total.size += s.size;
      total.inFlight += s.inFlight;
      total.sweeps += s.sweeps;
      total.swept += s.swept;
      total.evictions += s.evictions;
    }
    out[name] = total;
  }
  return out;
}

/** Visible for tests. */
export function resetCacheRegistry(): void {
  registry().clear();
}
