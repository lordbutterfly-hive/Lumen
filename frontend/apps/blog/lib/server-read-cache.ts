/**
 * A very small TTL memo for SERVER-SIDE chain reads, plus in-flight coalescing.
 *
 * ★★★ WHY (measured 2026-08-13, browser, production build). `/api/account` was the
 * slowest request on almost every page — 933ms on Home, 912ms on a topic page,
 * 898ms on Witnesses, 1,145ms on `/@ecency` — and `/api/manabar` a steady
 * 130-444ms beside it. Both are `private, no-store`, so every page paid the full
 * upstream cost again, and a profile view fired `/api/account` twice and
 * `/api/vests-to-hp` four times (two of them in the SAME millisecond with
 * identical params).
 *
 * ★ THIS DOES NOT CHANGE WHAT GOES OVER THE WIRE. The routes keep
 * `cache-control: private, no-store`, so nothing is cached in a browser or a
 * shared proxy and the existing reasoning in `/api/account/route.ts` still holds.
 * What is cached is our own upstream call, in this process, keyed by the exact
 * account being read. That distinction is the whole point: `getAccountFull(name)`
 * returns PUBLIC chain state for `name` — identical bytes whoever asks — so one
 * reader can never see another's data through this. Only freshness is traded, and
 * only for `ttlMs`.
 *
 * `ttlMs` should stay comfortably under a Hive block (3s) times a small number:
 * balances and manabar move per block, and the point is to collapse the burst of
 * duplicate reads a single page render produces, not to serve yesterday's balance.
 *
 * ★ THE IN-FLIGHT MAP IS THE HALF THAT FIXES THE SAME-MILLISECOND DUPLICATES.
 * A TTL cache alone does nothing for two identical requests that arrive before
 * either has answered — both miss, both call upstream. Callers that arrive while a
 * read is in flight join that promise instead of starting a second one.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Bounded so a long-running server cannot accumulate an entry per account ever seen. */
const MAX_ENTRIES = 500;

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

export async function cachedRead<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await read();
      // Oldest-first eviction: Map preserves insertion order, so the first key is
      // the least recently ADDED. Good enough for a burst-collapsing cache; it is
      // not trying to be an LRU.
      if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      // Always cleared, including on throw — a failed read must not wedge every
      // later caller onto a rejected promise.
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise as Promise<T>;
}
