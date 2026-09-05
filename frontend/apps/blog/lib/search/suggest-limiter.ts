/**
 * Per-IP token bucket for `/api/search/suggest`.
 *
 * ★ IN MEMORY, NOT THE POSTGRES LIMITER. Every other API limiter in this app
 * (`lib/lite/antispam/rate-limit.ts`) writes a `rate_counter` row per call.
 * That is right for a signup or a post and wrong for a request that fires on
 * every debounced keystroke: a typing reader would cost a database write per
 * 200ms for a route whose whole point is to be cheap. The same shape as
 * `lib/request-budget.ts` (token bucket, bounded map, idle eviction) is used
 * instead; per-process, so a 3-worker cluster grants three times the budget,
 * which is still two orders of magnitude below what a script would need to
 * turn keystrokes into a Hive-node problem (the 60s suggestion memo absorbs the
 * repeats anyway).
 *
 * Fails CLOSED for NEW keys when the table is full, exactly like the request
 * budget: a table that fills faster than idle buckets free is an attack on this
 * table, and existing readers keep working.
 */

/** Sustained rate: a person cannot produce more than ~2 suggestable edits a second. */
export const SUGGEST_PER_MINUTE = 120;
/** Burst: a fast typist's first word, with room for the debounce firing between keys. */
export const SUGGEST_BURST = 40;

const MAX_KEYS = 10_000;
const IDLE_MS = 60_000;
const SWEEP_EVERY_MS = 30_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > IDLE_MS) buckets.delete(key);
  }
}

/** Take one token for `key`; `false` means "answer 429". */
export function takeSuggestToken(key: string, now: number = Date.now()): boolean {
  sweep(now);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) {
      // A bucket idle for a minute has fully refilled, so dropping it costs nothing.
      for (const [other, b] of buckets) if (now - b.updatedAt >= IDLE_MS) buckets.delete(other);
      if (buckets.size >= MAX_KEYS) return false;
    }
    bucket = { tokens: SUGGEST_BURST, updatedAt: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(SUGGEST_BURST, bucket.tokens + elapsed * (SUGGEST_PER_MINUTE / 60_000));
    bucket.updatedAt = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Visible for tests. */
export function resetSuggestLimiter(): void {
  buckets.clear();
  lastSweep = 0;
}
