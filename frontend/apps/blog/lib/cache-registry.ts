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
 * Next bundles server code per webpack LAYER, so a module imported by both the
 * `rsc` layer (pages, app route handlers) and the `instrument` layer
 * (instrumentation.ts and everything it imports) ends up as TWO copies with two
 * separate module closures (`topic-cache.ts`, `viewer-warmer.ts` and
 * `hive-warm-gate.ts` document the same trap and the same cure). An instrument
 * that quietly measured only ONE copy would be worse than no instrument: it
 * would under-report residency and we would size the caps against a number that
 * is a fraction of the truth. The registry lives in a process-wide slot so every
 * copy lands in the same roster.
 *
 * ★★ WHY `copies` NO LONGER MEANS "SUM THESE" (2026-09-06, module-copies build
 * map, R1/R4). Before this pass, a `withTtlCache` instance's `fresh`/`inFlight`/
 * `counters` really were a SEPARATE Map per module copy, so summing every
 * registered `stats()` was the only way to see a cache's true whole-process
 * residency — proven live: the boot warm (instrument copy) filled `communities`
 * to size 1 while every render (rsc copy) read size 0, for 12 minutes.
 *
 * A NAMED `withTtlCache` (see that file's own header) now backs `fresh`/
 * `inFlight`/`counters` with ONE process-wide slot per name, so every copy that
 * registers under a name is reading the SAME underlying Map and counters —
 * summing two identical readings would double-count a single store, not add up
 * two real ones. So registration now keeps only the FIRST copy's `stats` fn per
 * name and counts `copies` separately, and `shared` says whether more than one
 * copy has registered so far: `copies` above 1 (`shared: true`) is the proof
 * that the store really is one Map seen by both layers, not the residency
 * multiplier it used to be.
 *
 * A cache whose state already lives on its own `globalThis` slot (the
 * account-posts seed cache) still registers EXACTLY ONCE by its own guard,
 * which was always correct and remains so — it just no longer relies on
 * `allCacheStats` to avoid double-counting on its behalf.
 */
export type CacheStatsFn = () => TtlCacheStats;

export interface RegisteredCacheStats extends TtlCacheStats {
  /** How many module copies have registered under this name so far. */
  copies: number;
  /**
   * `copies > 1`: at least one other module copy has registered under this
   * name, so the numbers above are one store seen by more than one webpack
   * layer, not a lone copy's private counters. `false` is not necessarily a
   * bug — the other layer may simply not have loaded yet (e.g. right after a
   * boot warm, before the first render) — see `warm-server-caches.ts`.
   *
   * ★ CARVE-OUT: a cache using the "registered exactly once, on purpose"
   * pattern (`account-posts-seed-cache.ts`'s own `registered` guard, which
   * predates and is independent of this field) will show `shared: false`
   * PERMANENTLY — its `copies` never exceeds 1 by design, whether or not the
   * underlying store is actually process-wide. For those caches `shared`
   * answers "did more than one copy register", not "is the store shared" —
   * the two questions coincide for a named `withTtlCache` (which registers
   * once per copy that loads it) but not for a cache that deliberately
   * registers only once regardless of how many copies exist.
   */
  shared: boolean;
}

interface RegistryEntry {
  /** The first copy's `stats` fn to register under this name — see header. */
  stats: CacheStatsFn;
  copies: number;
}

const SLOT = '__lumenCacheRegistry';

function registry(): Map<string, RegistryEntry> {
  const g = globalThis as unknown as Record<string, Map<string, RegistryEntry> | undefined>;
  if (!g[SLOT]) g[SLOT] = new Map<string, RegistryEntry>();
  return g[SLOT] as Map<string, RegistryEntry>;
}

/**
 * Register one cache under a stable name, at module scope in the file that owns
 * the cache, so a cache and its instrument cannot drift apart.
 *
 * ★ THE FIRST REGISTRATION'S `stats` WINS, LATER ONES ONLY BUMP `copies` — see
 * this file's header on why reading through a second copy's `stats` fn would
 * report the exact same numbers the first one already does, once the cache
 * behind it is a named, shared-slot one (server-ttl-cache.ts).
 */
export function registerCache(name: string, stats: CacheStatsFn): void {
  const reg = registry();
  const existing = reg.get(name);
  if (existing) existing.copies += 1;
  else reg.set(name, { stats, copies: 1 });
}

/**
 * Every registered cache's counters, one reading per name. Cheap: `stats()` is
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
  for (const [name, entry] of registry()) {
    const s = entry.stats();
    out[name] = { ...s, copies: entry.copies, shared: entry.copies > 1 };
  }
  return out;
}

/** Visible for tests. */
export function resetCacheRegistry(): void {
  registry().clear();
}
