/**
 * A small cross-request cache for server-side upstream reads.
 *
 * ★ WHY THIS EXISTS. React's `cache()` is REQUEST-scoped — it deduplicates
 * within one render and then throws the result away. That is the right tool for
 * `generateMetadata` racing a layout, and the wrong tool for "the same upstream
 * call costs 360ms and every visitor pays it again". Measured from this box on
 * 2026-08-15: `database_api.find_accounts` 357-366ms, `bridge.list_communities`
 * 629ms. Those two numbers were the majority of the two slowest server routes in
 * the app, and no amount of local optimisation touches them — the only lever is
 * not making the call.
 *
 * ★ THE FOUR PROPERTIES, EACH FOR A REAL FAILURE MODE:
 *
 *  1. **Failures are never cached.** api.hive.blog answers 429 under load, and
 *     the profile layout's own comment records what happened when a rejection
 *     was treated as an answer: /@blocktrades 404'd for an account that plainly
 *     exists. A cached failure turns a one-second blip into a sticky error for
 *     the whole TTL, for everyone. Rejections propagate and store nothing, and
 *     callers may reject a result as uncacheable via `shouldCache`.
 *
 *  2. **Single-flight.** Ten concurrent misses for one key must make ONE
 *     upstream call, not ten — concurrency is what produced the 429 to begin
 *     with. Arrivals during a miss share the in-flight promise.
 *
 *  3. **Bounded.** These are keyed on URL-derived values, so an unbounded map is
 *     a memory leak any anonymous visitor can drive by walking `/@a`, `/@b`, …
 *     Insertion-ordered eviction keeps the size flat.
 *
 *  4. **Per-process, deliberately.** No Redis, no shared store. This is a
 *     latency shim over a slow read, not a source of truth, and a cache that
 *     needs infrastructure to be correct is a cache that will be wrong.
 *
 *  5. **Optionally, expiry does not have to cost a reader anything** — see
 *     `staleWhileRevalidateMs` below. OFF by default: every caller that existed
 *     before this option keeps the exact behaviour it was reasoned into.
 *
 * ★ WHAT MUST NEVER GO THROUGH IT: anything transactional. A stale BALANCE is a
 * far worse bug than a slow page. Wallet reads call their upstream directly and
 * must keep doing so.
 *
 * ★★★ THE GAP `ttlMs` ALONE LEAVES, measured on this box 2026-08-17.
 *
 * A plain TTL cache moves the upstream cost, it does not remove it: on expiry the
 * entry is DELETED and the next reader through the door waits for the full
 * round trip while everyone behind them waits too. So the cost is not gone, it is
 * concentrated — one unlucky reader per TTL period pays all of it, and which
 * reader that is, is luck.
 *
 * That is affordable at 360ms and it is not affordable when the upstream has a bad
 * minute. Timed directly against `api.hive.blog` on 2026-08-17,
 * `bridge.list_communities` answered in **6.6s cold and 1.1s warm** — so the
 * measured spread for one reader is 60ms (hit) versus 6.6s (the expiry landing on
 * a cold upstream), on a page whose warm render is 61ms. Nothing in this app is
 * slow; the reader who lands on the expiry is.
 *
 * `staleWhileRevalidateMs` closes it the ordinary way: past `expires`, keep
 * answering from the value we already hold and refresh it BEHIND the reader. The
 * freshness contract is unchanged in kind — a caller already declared how stale
 * this value may be — and only the reader's wait is removed.
 *
 * ★★★ WHY EXPIRY NOW SWEEPS, AND WHY `max: 500` WAS THE WRONG DEFAULT
 * (measured on the prod box 2026-09-05).
 *
 * Everything above reasons about a value's LIFETIME and nothing about its
 * RESIDENCY, and those stopped being the same thing. Two assumptions baked into
 * the 500-entry defaults both broke:
 *
 *  · **One process.** These maps are per-process by design (property 4), and the
 *    box now runs THREE cluster workers, so every bound below is really three
 *    times itself. A 500-entry cap is a 1500-entry cap.
 *
 *  · **Warm repeat traffic.** A cap only bounds what a cache HOLDS; the TTL was
 *    doing the actual shrinking, on the assumption that readers keep coming back
 *    to the same keys. Crawler traffic has no repeats: measured 2026-09-05,
 *    ~870 profile renders/hour across 868 DISTINCT accounts and ~2200 post-page
 *    requests per 10 minutes across distinct posts. Every key is a miss, every
 *    miss stores, and NOTHING reads it again.
 *
 * The consequence is the bug: an entry that expired 50 seconds ago was still
 * RESIDENT, because the only two things that ever removed one were a READ past
 * `staleUntil` and insertion-order eviction at `max`. A key nobody reads twice
 * gets neither. So each map filled to its cap with dead values and stayed there
 * — worker RSS grew 540 MB at start to 1.08-1.35 GB within 80 minutes, on a
 * 7.9 GB box also carrying a 2.4 GB ranker.
 *
 * The fix is in two halves, and only the first one is in this file:
 *
 *  6. **Expiry now costs memory, not just a read.** An insert that actually
 *     STORES a value, landing with the map past `max/2`, sweeps entries whose
 *     `staleUntil` has already passed. This is deliberately NOT a timer: no
 *     `setInterval` to leak, no work on an idle process, and the sweep runs
 *     exactly when the map is growing.
 *
 *     ★ "THAT ACTUALLY STORES" IS LOAD-BEARING, not a quibble. `store` returns
 *     early when `shouldCache` rejects a value, BEFORE the sweep — so a cache
 *     being hammered with results it refuses to keep (an upstream returning
 *     empty pages, say) never sweeps at all. That is the right trade, since such
 *     a cache is not growing either, but it does mean the sweep is driven by
 *     successful writes and NOT by request volume. A cache that has stopped
 *     storing has also stopped reclaiming, and its residents age out only on a
 *     read past `staleUntil`, exactly as before this change.
 *
 *     The walk is bounded by `max` for free: `store` restores `size <= max`
 *     before it returns, so the map can never hold more than `max` entries to
 *     walk. It stops earlier than that in the ordinary case, the moment `size`
 *     is back under `max/2`.
 *
 *     ★ SEMANTICS ARE UNCHANGED, and that is the whole safety argument: the
 *     sweep deletes ONLY entries past `staleUntil`, which is precisely what the
 *     read path already does to such an entry (`fresh.delete(key)` below). It
 *     can never drop a fresh value or one inside its stale window, so no reader
 *     sees a miss it would not have seen anyway. It changes WHEN the delete
 *     happens, never WHETHER.
 *
 *     The second half is in `cached-api.ts`: caps re-derived from each TTL and
 *     the measured request rate, because a sweep cannot help a value that is
 *     still fresh and still unread.
 *
 * ★★★ WHY A NAMED CACHE'S STORE LIVES ON `globalThis` (2026-09-06, module-copies
 * build map). Next compiles this file once per webpack LAYER — `rsc` (every page
 * render and app route handler) and `instrument` (instrumentation.ts and
 * everything it imports) each get their OWN module factory, so `fresh`,
 * `inFlight` and `counters` below used to be two separate closures with two
 * separate Maps, proven live: the boot warm (instrument copy) filled
 * `communities` to size 1 while every render (rsc copy) read size 0 for 12
 * minutes, and the first render after every restart still paid the full
 * upstream cost the warm exists to remove (145-214ms measured).
 *
 * `name` opts a cache INTO one process-wide store instead of a module-local one:
 * `globalThis[Symbol.for('lumen.ttlCache.v1')]` holds a `Map<name, {fresh,
 * inFlight, counters, ttlMs, max}>`, and every module copy that calls
 * `withTtlCache` with the same name reads and writes the SAME three structures.
 * A second copy adopting a name must agree on `ttlMs` and `max` — those are the
 * only two knobs a caller can get wrong independently of the shared source, and a
 * mismatch would mean two call sites silently disagreeing about what the name
 * means, so it throws at module load instead of picking one silently.
 *
 * Unnamed callers are untouched: `fresh`/`inFlight`/`counters` stay exactly the
 * module-local `new Map()`/counters object they always were. Every existing test
 * of this file's invariants uses an unnamed cache and stays green unchanged.
 *
 * ★ REGISTRATION IS FOLDED IN. A named cache also registers itself with
 * `cache-registry.ts` under its own name, so `cached-api.ts` no longer lists a
 * separate `registerCache(...)` call per cache — the registry name and the
 * shared-store name are now, by construction, the same string, which is what
 * makes "name mandatory for registered caches" a fact about the code rather than
 * a convention someone has to remember.
 */
import { registerCache } from '@/blog/lib/cache-registry';

/**
 * The state a named cache keeps in the process-wide slot instead of in its own
 * module closure — see the header note above. Loosely typed (`unknown` in place
 * of each cache's own `T`) because the slot is shared across call sites with
 * different `T`s; each `withTtlCache` call narrows its own entry back on read.
 */
interface SharedTtlCacheState {
  fresh: Map<string, { value: unknown; expires: number; staleUntil: number }>;
  inFlight: Map<string, Promise<unknown>>;
  counters: { sweeps: number; swept: number; evictions: number };
  ttlMs: number;
  max: number;
}

const TTL_CACHE_SLOT = Symbol.for('lumen.ttlCache.v1');

function ttlCacheSlot(): Map<string, SharedTtlCacheState> {
  const carrier = globalThis as typeof globalThis & { [TTL_CACHE_SLOT]?: Map<string, SharedTtlCacheState> };
  carrier[TTL_CACHE_SLOT] ??= new Map<string, SharedTtlCacheState>();
  return carrier[TTL_CACHE_SLOT];
}

/**
 * ★★★ THE OTHER HALF OF NAME-COLLISION DETECTION (2026-09-06 review fix).
 * `ttlMs`/`max` mismatch (below) catches two call sites that disagree on
 * options, but NOT two call sites that happen to agree — and six of today's
 * named caches all use `{ttlMs: 30_000, max: 100}` (discussion, community,
 * followList, followers, following, plus any future one), so a typo'd or
 * copy-pasted `name` that collides with one of them and happens to match its
 * options would sail through the `ttlMs`/`max` check and silently share ONE
 * store between two semantically unrelated caches — wrong answers at REQUEST
 * time, from a mistake that was made at MODULE LOAD.
 *
 * ★ DELIBERATELY MODULE-LOCAL, NOT SHARED. Cross-copy adoption (the whole
 * point of `name`) ALWAYS sees a different `loader`/`keyOf` reference on the
 * second copy — different module factory invocation, different closures over
 * identical source — so comparing against a value from the SHARED slot can
 * never tell a legitimate adopting copy apart from a same-copy mistake; both
 * look identical from that vantage point. What CAN tell them apart is
 * per-copy memory: within ONE module evaluation, every `withTtlCache({name})`
 * call is either the FIRST time this copy has used that name (nothing to
 * compare against yet) or a SECOND call in the SAME copy re-using it — and a
 * second call in the same copy can only be a mistake, because legitimate code
 * never calls `withTtlCache` twice for one logical cache. This Map starts
 * empty on every fresh module evaluation, so it holds only entries THIS copy
 * itself created, which is exactly what makes "have I, this copy, already
 * used this name for something else?" answerable by reference equality.
 */
const localNamedLoaders = new Map<string, { loader: unknown; keyOf: unknown }>();

export interface TtlCacheOptions<T> {
  /** How long a stored value stays fresh. */
  ttlMs: number;
  /** Maximum entries before insertion-ordered eviction. */
  max?: number;
  /**
   * Whether a resolved value is worth storing. Defaults to "anything not
   * null/undefined". Use it to refuse the shapes that mean "we could not tell"
   * rather than "here is the answer".
   */
  shouldCache?: (value: T) => boolean;
  /**
   * Per-value TTL override. Lets a caller keep a confident answer for a while
   * and an absence for only a moment, which is the difference between "this
   * account does not exist on chain" (cheap to re-check, expensive to be wrong
   * about for long) and "here is the account".
   */
  ttlFor?: (value: T) => number;
  /**
   * How long past `expires` a stored value may still be SERVED, while a refresh
   * runs in the background. `0`/omitted (the default) keeps the original
   * behaviour exactly: expiry deletes, and the next caller waits.
   *
   * ★ WHY THIS IS OPT-IN AND NOT THE DEFAULT. Every existing caller of this
   * module chose its TTL from what its value IS — 20s for global chain
   * properties, 30s for a profile header, 60s for reputation — and those
   * numbers were argued in `cached-api.ts`'s own notes. Serving past a TTL is a
   * change to that argument, so it is made per caller, out loud, where the
   * reasoning lives. A default would have applied it to callers nobody
   * re-examined.
   *
   * ★ A FUNCTION, FOR THE SAME REASON `ttlFor` IS ONE. An ABSENCE must be able
   * to opt out while a real answer opts in: `getAccountFullCached` deliberately
   * keeps "no such account" for only 10s so a just-created account appears
   * almost at once, and a stale window on THAT would quietly undo it. Returning
   * `0` for a value means "never serve this one stale".
   */
  staleWhileRevalidateMs?: number | ((value: T) => number);
  /**
   * Opt this cache's store into the process-wide slot instead of a module-local
   * one — see this file's header note on why that is what makes a boot warm or a
   * registered cache visible to every webpack layer, not just the one that ran
   * it. Also the name it registers under in `cache-registry.ts` (folded in
   * automatically below, so a caller no longer registers separately). Two call
   * sites sharing a name must pass identical `ttlMs`/`max`, or the second one
   * throws at module load — see `ttlCacheSlot` above.
   *
   * Omit it for a cache that is deliberately per-copy (there are none of these
   * among today's callers, but the option stays opt-in rather than the default
   * for the same reason `staleWhileRevalidateMs` is: a default would apply a new
   * behaviour to callers nobody re-examined).
   */
  name?: string;
}

/**
 * A `withTtlCache` result: callable exactly like the wrapped loader, plus a
 * `.set` escape hatch — see its own doc comment below for why it exists.
 */
export interface TtlCacheStats {
  /** Entries currently resident (fresh, stale-servable, and not-yet-swept). */
  size: number;
  /** Entries in flight right now — a miss others are sharing. */
  inFlight: number;
  /** How many inserts ran a sweep (i.e. landed with the map past `max/2`). */
  sweeps: number;
  /** Entries removed by those sweeps because they were past `staleUntil`. */
  swept: number;
  /** Entries removed by the hard insertion-order bound at `max`. */
  evictions: number;
}

export interface TtlCache<A extends unknown[], T> {
  (...args: A): Promise<T>;
  set(key: string, value: T): void;
  /**
   * A cheap read-only counter snapshot — no iteration, just the running totals
   * plus `Map.size`. It exists so "is this cache actually bounded in prod?" is
   * answerable without a heap snapshot: `swept` climbing while `size` sits well
   * under `max` is the sweep working; `size` pinned AT `max` with `evictions`
   * climbing means the cap, not expiry, is doing the bounding and the cap is
   * too small for the traffic.
   */
  stats(): TtlCacheStats;
}

/**
 * Wrap an async single-argument-keyed loader with a bounded TTL cache.
 * The returned function has the same signature as the loader, plus `.set`.
 */
export function withTtlCache<A extends unknown[], T>(
  loader: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string,
  { ttlMs, max = 500, shouldCache, ttlFor, staleWhileRevalidateMs, name }: TtlCacheOptions<T>
): TtlCache<A, T> {
  // `staleUntil` is stored, not recomputed on read: the window a value earned is
  // a property of THAT value (an absence may earn none — see the option's note),
  // and deciding it at write time is what keeps the read path a comparison.
  //
  // ★ NAMED CACHES GET THEIR THREE STRUCTURES FROM THE SHARED SLOT INSTEAD OF A
  // FRESH `new Map()` — see this file's header note. Every line below this block
  // reads `fresh`/`inFlight`/`counters` exactly as it always did; only where
  // those three live changes.
  let fresh: Map<string, { value: T; expires: number; staleUntil: number }>;
  let inFlight: Map<string, Promise<T>>;
  let counters: { sweeps: number; swept: number; evictions: number };
  if (name) {
    // ★ SAME-COPY COLLISION CHECK FIRST — see `localNamedLoaders`'s own doc.
    // This runs BEFORE the shared-slot check below because it needs to fire
    // even when this copy is the FIRST one to ever use `name` (a same-copy
    // collision between the FIRST and SECOND local uses of a fresh name would
    // otherwise slip past the shared-slot branch entirely, since that branch
    // only compares against whatever the FIRST of the two calls already
    // wrote).
    const localExisting = localNamedLoaders.get(name);
    if (localExisting && (localExisting.loader !== loader || localExisting.keyOf !== keyOf)) {
      throw new Error(
        `withTtlCache: name "${name}" was already used in this module for a DIFFERENT loader/keyOf pair — ` +
          'two unrelated caches cannot share one name; give one of them a different name'
      );
    }
    localNamedLoaders.set(name, { loader, keyOf });

    const slot = ttlCacheSlot();
    const existing = slot.get(name);
    if (existing) {
      // ★ THE CROSS-COPY PROTECTION: two call sites choosing the same name
      // with DIFFERENT options. Both copies of a single call site are
      // identical by construction (same source, same build), so this can
      // only fire on a genuine name collision between two different caches —
      // exactly the case that must not silently share a store. (The
      // same-copy case just above is the other half: two call sites that
      // choose the same name with matching options too, which this ttlMs/max
      // comparison alone cannot see.)
      if (existing.ttlMs !== ttlMs || existing.max !== max) {
        throw new Error(
          `withTtlCache: named cache "${name}" already exists with ttlMs=${existing.ttlMs} max=${existing.max}, ` +
            `but this copy requested ttlMs=${ttlMs} max=${max} — two call sites are sharing one name with ` +
            'different options; give one of them a different name'
        );
      }
      fresh = existing.fresh as Map<string, { value: T; expires: number; staleUntil: number }>;
      inFlight = existing.inFlight as Map<string, Promise<T>>;
      counters = existing.counters;
    } else {
      fresh = new Map<string, { value: T; expires: number; staleUntil: number }>();
      inFlight = new Map<string, Promise<T>>();
      counters = { sweeps: 0, swept: 0, evictions: 0 };
      slot.set(name, {
        fresh: fresh as Map<string, { value: unknown; expires: number; staleUntil: number }>,
        inFlight: inFlight as Map<string, Promise<unknown>>,
        counters,
        ttlMs,
        max
      });
    }
  } else {
    fresh = new Map<string, { value: T; expires: number; staleUntil: number }>();
    inFlight = new Map<string, Promise<T>>();
    counters = { sweeps: 0, swept: 0, evictions: 0 };
  }
  const keep = shouldCache ?? ((v: T) => v !== null && v !== undefined);
  const staleFor = (value: T): number => {
    if (typeof staleWhileRevalidateMs === 'function') return staleWhileRevalidateMs(value);
    return staleWhileRevalidateMs ?? 0;
  };

  /**
   * The level the sweep triggers at AND stops at. Half the cap, so a map only
   * pays for a sweep once it is genuinely filling, and a sweep that reaches this
   * level has already freed enough to stop walking.
   *
   * ★ `max` can be 1 (nothing in the app does this, a test may): `Math.max(1, …)`
   * keeps the threshold at least 1 so `size > halfMax` cannot be true for an
   * empty map and the sweep is never entered with nothing to do.
   */
  const halfMax = Math.max(1, Math.floor(max / 2));

  /**
   * ★ REMOVE WHAT EXPIRY ALREADY KILLED (2026-09-05) — see this file's header
   * for the measurement that made it necessary.
   *
   * Deletes ONLY entries past `staleUntil`, i.e. exactly the ones the read path
   * would delete on sight, so this is a change of TIMING and never of meaning.
   * Two independent bounds keep an insert cheap:
   *
   *  · the walk can never exceed `max` entries, because `store` re-establishes
   *    `size <= max` before returning, so that is the map's hard size;
   *  · it stops the moment `size` is back under `halfMax`, which is the exit the
   *    ordinary case takes.
   *
   * ★ WHAT IS **NOT** GUARANTEED, AND WAS ONCE CLAIMED HERE: that insertion
   * order tracks expiry order, i.e. that the dead entries sit at the FRONT. It
   * does not, for two independent reasons. `Map.set` on an EXISTING key updates
   * the value and KEEPS the key's original position, so a refreshed entry stays
   * wherever it first landed while carrying a brand-new, later `staleUntil` — a
   * live entry parked at the front. And `ttlFor` lets one cache mint different
   * lifetimes per value (`getAccountFullCached` gives an absence 10s and a real
   * account 30s), so even first-insert order is not expiry order there.
   *
   * The consequence is only about WORK, never about correctness: a sweep may
   * walk past live entries before reaching a dead one, and in the worst case
   * walks the whole map and frees nothing. Both bounds above still hold, and the
   * `staleUntil > now` test below is what makes the outcome safe regardless of
   * the order the walk happens to see.
   *
   * Deleting during `for…of` over a Map is well-defined: the iterator visits
   * each remaining key once and is unaffected by removals at or behind it.
   */
  const sweepExpired = (now: number): void => {
    if (fresh.size <= halfMax) return;
    counters.sweeps++;
    // No explicit walk counter: `store` guarantees `size <= max` on entry, so
    // this loop is already bounded by `max` and a second guard would be dead
    // code pretending to be a safety net.
    for (const [key, entry] of fresh) {
      if (entry.staleUntil > now) continue;
      fresh.delete(key);
      counters.swept++;
      if (fresh.size <= halfMax) break;
    }
  };

  /**
   * The one place a value is written into `fresh`. Shared by the ordinary load
   * path below and by `.set` (added 2026-09-05, see its own doc comment) so
   * there remains exactly one place deciding whether a value is worth storing
   * and for how long — a caller priming the cache by hand earns the same
   * `keep`/`ttlFor`/`staleWhileRevalidateMs` rules as a value this module
   * fetched itself, never a second, drifting copy of them.
   */
  const store = (key: string, value: T): void => {
    if (!keep(value)) return;
    const now = Date.now();
    // Reclaim the already-dead before adding to the pile. Ordered BEFORE the
    // insert so a fresh value is never a sweep candidate in its own write, and
    // so the hard bound below only ever evicts when the map is genuinely full of
    // LIVE entries rather than of corpses.
    sweepExpired(now);
    const expires = now + (ttlFor ? ttlFor(value) : ttlMs);
    fresh.set(key, { value, expires, staleUntil: expires + Math.max(0, staleFor(value)) });
    // The hard bound stays exactly as it was: the sweep is an optimisation on
    // top of it, never a replacement for it. If every entry is still live, this
    // is what keeps the map finite.
    while (fresh.size > max) {
      const oldest = fresh.keys().next().value;
      if (oldest === undefined) break;
      fresh.delete(oldest);
      counters.evictions++;
    }
  };

  /**
   * The one place an upstream call is started. Used by the blocking miss and
   * the background refresh so `inFlight` is written by exactly one code path
   * — that is what makes single-flight hold across both. Storing the result
   * is delegated to `store` above, the same helper `.set` uses.
   */
  const startLoad = (key: string, ...args: A): Promise<T> => {
    const pending = loader(...args)
      .then((value) => {
        store(key, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, pending);
    return pending;
  };

  const cached = ((...args: A): Promise<T> => {
    const key = keyOf(...args);
    const now = Date.now();

    const hit = fresh.get(key);
    if (hit) {
      if (hit.expires > now) return Promise.resolve(hit.value);
      if (now < hit.staleUntil) {
        // ★ SERVE STALE, REFRESH BEHIND. The reader gets the value we already
        // hold, immediately; the round trip happens off their request.
        //
        // ★ `.catch()` IS LOAD-BEARING, NOT DEFENSIVE NOISE. Nobody awaits a
        // background refresh, so an upstream rejection here is an UNHANDLED
        // rejection — which on Node 20 is a process-level crash by default, i.e.
        // one 429 from api.hive.blog taking the whole server down. Swallowing it
        // is also exactly right on the merits: property 1 says failures are never
        // stored, so a failed refresh must leave the stale value standing and let
        // the next caller try again. If every refresh fails, `staleUntil` still
        // passes and the read below goes back to blocking on the upstream, which
        // is the un-cached behaviour — degraded, never wrong.
        if (!inFlight.has(key)) void startLoad(key, ...args).catch(() => {});
        return Promise.resolve(hit.value);
      }
      fresh.delete(key);
    }

    const flying = inFlight.get(key);
    if (flying) return flying;

    return startLoad(key, ...args);
  }) as TtlCache<A, T>;

  /**
   * ★ WRITE-THROUGH FOR A CALLER'S OWN SUCCESSFUL RETRY (2026-09-05).
   *
   * Every value in `fresh` used to arrive only through this module's own
   * `loader` call — right for every caller that existed then, since none of
   * them ever compute the value another way. `(user-profile)/layout.tsx` does:
   * on a rejected `getAccountFullCached`, its retry calls the RAW
   * `getAccountFull` directly (deliberately bypassing both this cache and the
   * request-scoped `cache()` wrapper around it, per that file's own comment,
   * to open a fresh connection rather than replay the already-rejected
   * promise). A successful retry answer used to be handed straight to that one
   * page and then thrown away — every other reader landing in the same 30s
   * window paid the identical failed-then-retried round trip again.
   *
   * `.set` lets that retry deposit its answer into the SAME store a normal
   * `loader` call would have filled, under the SAME rules `store` above
   * enforces: an absence, or a rejected retry, still writes nothing (the
   * caller never calls `.set` on a rejection — see the call site), exactly as
   * an absence never reaches `fresh` from the ordinary path (property 1 in
   * this file's header comment). It does not touch `inFlight`: a `.set` is not
   * a load, so there is nothing to single-flight and nothing pending to mark.
   */
  cached.set = store;

  /** See `TtlCacheStats` — counters only, no iteration, safe to call anywhere. */
  cached.stats = (): TtlCacheStats => ({
    size: fresh.size,
    inFlight: inFlight.size,
    sweeps: counters.sweeps,
    swept: counters.swept,
    evictions: counters.evictions
  });

  // ★ REGISTRATION FOLDED IN — see this file's header note and `name`'s own doc.
  // Every module copy that constructs this named cache registers here, under
  // the same name the shared store lives under, so a caller can no longer
  // register under a name that does not match what is actually shared.
  if (name) registerCache(name, cached.stats);

  return cached;
}
