/**
 * ★★★ HOW LONG ONE recsys `/feed` CALL MAY RUN, AND WHY IT HAS A FLOOR
 * (2026-09-05). Pure, no I/O, unit-tested next door — split out of
 * `feed-client.ts` for exactly that reason (that file is `import 'server-only'`
 * and cannot be loaded by a plain test runner).
 *
 * ★★★ THE FLOOR IS THE WHOLE POINT OF THIS MODULE, AND IT WAS PAID FOR IN
 * PRODUCTION. `getRecsysConfig` used to accept any positive number, so
 * `/opt/lumen/.env` carrying `RECSYS_FEED_TIMEOUT_MS=4000` silently disabled
 * personalised ranking for EVERY signed-in reader on this box for two days.
 * Measured 2026-09-05 before the value was corrected:
 *
 *   recsys `/feed`   11.6s (hbd-temp) / 18.6s (gtg) / 24.4s (tibfox)
 *   every attempt    "recsys attempt 3/3 for gtg failed in 4197ms"
 *   every build      "build for gtg produced nothing after 14364ms"
 *                    (3 x 4.2s of aborts + 2 x 750ms of backoff)
 *   lumen_feed_store 4 rows, newest 2 DAYS old — not one build had landed
 *
 * and the reader-visible result was the permanent "Personalised ranking is
 * warming up. Showing popular posts meanwhile." banner, because a viewer with
 * no stored row can only ever be served the trending fallback. With the floor
 * applied the same warm cycle stored three rows in under two minutes.
 *
 * ★ WHY A FLOOR IS LEGITIMATE HERE AND NOT OPERATOR-OVERRIDE VANDALISM. Before
 * 2026-08-15 this number bounded THE READER'S WAIT, so a small value was a
 * real (if costly) latency choice. It does not any more: `firstBuildPatienceMs`
 * bounds how long a reader watches a first build (2s with the ready pill on),
 * and the build itself runs on past the response and stores its result. So the
 * only thing this timeout still decides is WHETHER A BUILD CAN EVER FINISH.
 * Set below the cold-build cost it does not trade latency for robustness — it
 * buys nothing at all and guarantees that nothing is ever ranked. That is a
 * misconfiguration, not a tuning position, and it is worth refusing.
 *
 * Raising it is still entirely the operator's call; only lowering it past the
 * point where a build cannot complete is clamped. Same posture, and the same
 * reasoning, as `feedBands()`'s `Math.max(presentMaxMs, ...)` clamp on an
 * abandon ceiling set below the presentation ceiling.
 */

/**
 * ★ 15s, MEASURED 2026-08-06 against a real recsys with a real trust snapshot:
 * 9.6s for a viewer whose profile cache is COLD, 0.51s once warm. 4000ms — the
 * first guess — fell back to trending on every first view, so a reader would
 * never see a ranked feed until something else warmed them. 15s covers the cold
 * case with headroom; the fallback still protects against a wedged recsys.
 */
export const RECSYS_FEED_TIMEOUT_DEFAULT_MS = 15_000;

/**
 * The lowest value a build can complete at, and therefore the lowest value this
 * module will honour. Deliberately EQUAL to the default rather than some
 * comfortable fraction of it: the default is already the measured cold-build
 * cost, so anything under it is under the cost of the work being timed.
 */
export const RECSYS_FEED_TIMEOUT_FLOOR_MS = RECSYS_FEED_TIMEOUT_DEFAULT_MS;

/** What `resolveRecsysTimeoutMs` did, so the caller can log a clamp exactly once. */
export interface RecsysTimeout {
  timeoutMs: number;
  /** The raw env value, present only when it was rejected for being too small. */
  clampedFrom?: number;
}

/**
 * Resolve the per-call recsys timeout from the environment.
 *
 * `env` is injectable for the test only; production always passes
 * `process.env`. Anything that is not a positive finite number — unset, empty,
 * `abc`, `0`, negative — falls back to the default rather than producing a
 * timeout of `NaN`, which `setTimeout` would treat as 0 and abort every single
 * recsys call instantly. A misconfigured env var must never be worse than no
 * env var; see `postsPrefetchBudgetMs` for the same rule in the same words.
 */
export function resolveRecsysTimeoutMs(
  env: Record<string, string | undefined> = process.env
): RecsysTimeout {
  const raw = Number(env.RECSYS_FEED_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return { timeoutMs: RECSYS_FEED_TIMEOUT_DEFAULT_MS };
  if (raw < RECSYS_FEED_TIMEOUT_FLOOR_MS) {
    return { timeoutMs: RECSYS_FEED_TIMEOUT_FLOOR_MS, clampedFrom: raw };
  }
  return { timeoutMs: raw };
}
