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
 * ★ WHAT MUST NEVER GO THROUGH IT: anything transactional. A stale BALANCE is a
 * far worse bug than a slow page. Wallet reads call their upstream directly and
 * must keep doing so.
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
}

/**
 * Wrap an async single-argument-keyed loader with a bounded TTL cache.
 * The returned function has the same signature as the loader.
 */
export function withTtlCache<A extends unknown[], T>(
  loader: (...args: A) => Promise<T>,
  keyOf: (...args: A) => string,
  { ttlMs, max = 500, shouldCache, ttlFor }: TtlCacheOptions<T>
): (...args: A) => Promise<T> {
  const fresh = new Map<string, { value: T; expires: number }>();
  const inFlight = new Map<string, Promise<T>>();
  const keep = shouldCache ?? ((v: T) => v !== null && v !== undefined);

  return (...args: A): Promise<T> => {
    const key = keyOf(...args);
    const now = Date.now();

    const hit = fresh.get(key);
    if (hit) {
      if (hit.expires > now) return Promise.resolve(hit.value);
      fresh.delete(key);
    }

    const flying = inFlight.get(key);
    if (flying) return flying;

    const pending = loader(...args)
      .then((value) => {
        if (keep(value)) {
          fresh.set(key, { value, expires: Date.now() + (ttlFor ? ttlFor(value) : ttlMs) });
          while (fresh.size > max) {
            const oldest = fresh.keys().next().value;
            if (oldest === undefined) break;
            fresh.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, pending);
    return pending;
  };
}
