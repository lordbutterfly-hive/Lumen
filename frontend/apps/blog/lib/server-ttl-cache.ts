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
 */

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
}

/**
 * A `withTtlCache` result: callable exactly like the wrapped loader, plus a
 * `.set` escape hatch — see its own doc comment below for why it exists.
 */
export interface TtlCache<A extends unknown[], T> {
  (...args: A): Promise<T>;
  set(key: string, value: T): void;
}

/**
 * Wrap an async single-argument-keyed loader with a bounded TTL cache.
 * The returned function has the same signature as the loader, plus `.set`.
 */
export function withTtlCache<A extends unknown[], T>(
  loader: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string,
  { ttlMs, max = 500, shouldCache, ttlFor, staleWhileRevalidateMs }: TtlCacheOptions<T>
): TtlCache<A, T> {
  // `staleUntil` is stored, not recomputed on read: the window a value earned is
  // a property of THAT value (an absence may earn none — see the option's note),
  // and deciding it at write time is what keeps the read path a comparison.
  const fresh = new Map<string, { value: T; expires: number; staleUntil: number }>();
  const inFlight = new Map<string, Promise<T>>();
  const keep = shouldCache ?? ((v: T) => v !== null && v !== undefined);
  const staleFor = (value: T): number => {
    if (typeof staleWhileRevalidateMs === 'function') return staleWhileRevalidateMs(value);
    return staleWhileRevalidateMs ?? 0;
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
    const expires = Date.now() + (ttlFor ? ttlFor(value) : ttlMs);
    fresh.set(key, { value, expires, staleUntil: expires + Math.max(0, staleFor(value)) });
    while (fresh.size > max) {
      const oldest = fresh.keys().next().value;
      if (oldest === undefined) break;
      fresh.delete(oldest);
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

  return cached;
}
