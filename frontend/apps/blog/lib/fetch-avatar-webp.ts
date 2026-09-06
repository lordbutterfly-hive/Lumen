import { withRetry } from '@transaction/lib/retry';

/**
 * ★ WEBP RESOLVER (2026-09-04, T1b perf). `shortcutUrl` is Hive's own
 * `/u/<name>/avatar/<size>` redirect — it ignores every format param on the request
 * (verified) and always 302s to a plain, source-format `/p/<hash>?width=&height=` URL.
 * That resolved URL DOES honour `format`, so this follows the ONE redirect itself
 * (`redirect: 'manual'`, which — unlike a browser's cross-origin fetch — gives a real
 * status/Location here since this runs server-side with no CORS restriction) and
 * re-requests it with `format=webp` set.
 *
 * Falls back to exactly the un-modified resolved URL — i.e. today's PNG behaviour —
 * if the WebP-forced request fails, so a source the proxy can't transcode still
 * resolves to a real picture instead of a broken avatar. If `shortcutUrl` doesn't
 * redirect at all (missing account, upstream error), the probe response is handed
 * back untouched so the caller's existing `!response.ok` fallback logic runs exactly
 * as it did before this change.
 *
 * ★ Pulled out of `app/api/avatar/route.ts` into its own `lib/` module (2026-09-07,
 * same fix that added the timeout below) purely so it can be unit-tested with a
 * mocked `fetch` — a Next.js Route Handler file may only export the HTTP-verb
 * functions Next recognises (`GET`, etc.); anything else risks the App Router's own
 * generated route types rejecting the file. `route.ts`'s `GET` calls this exactly as
 * it called the function that used to live inline here; behaviour is unchanged.
 *
 * ★★★ PER-HOP TIMEOUT + TOTAL BUDGET (2026-09-07, fix for unbounded avatar hangs).
 *
 * None of the three hops above ever carried an `AbortSignal`, and `withRetry`
 * (`@transaction/lib/retry`) only bounds the SLEEP between attempts, not an
 * in-flight `fn()` call — see that module's own doc comment, corrected the same
 * day this was found. So a hop that never got a response never gave up.
 * Production logged exactly this three times in the retained log window —
 * ALL of them this function's probe hop, ALL of them the total population of
 * such failures on the box (`/var/log/lumen.log*`, grepped for `avatar(...)`):
 *   "avatar(new-orden)-probe: fetch failed (gave up after 28735ms)"
 *   "avatar(hicmaster)-probe: fetch failed (gave up after 54998ms)"
 *   "avatar(magicmonk)-probe: fetch failed (gave up after 59564ms)"
 * Each of those is `withRetry`'s OWN attempts summing up, because every attempt
 * itself was free to hang — not evidence of one 28-59s stall, but of up to three
 * unbounded attempts on the SAME hop.
 *
 * The numbers below come from measuring the honest case, not guessing it: 84
 * direct timings against images.hive.blog FROM THE PRODUCTION BOX (28 accounts x
 * the probe, webp and PNG-fallback hop shapes, 2026-09-07) gave min 48ms, median
 * 104ms, p90 330ms, p99 596ms, max 653ms.
 *
 *   HOP_TIMEOUT_MS = 2000 — >3x the measured max (653ms) and >3x the p99
 *   (596ms), so nothing in the honest distribution ever gets near it, while it
 *   is nowhere close to the 28.7-59.6s hangs actually logged.
 *   TOTAL_BUDGET_MS = 3000 — shared across every hop AND every retry attempt on
 *   every hop (each hop's own `AbortSignal` and its own `withRetry.budgetMs` are
 *   both recomputed from the REMAINING budget on every call), so three 2s hops
 *   cannot add up to 6s: the worst case for the whole function is 3s, not
 *   3 x 2s, and it shrinks to 0 the instant the deadline passes rather than
 *   letting a spent hop start a fresh one.
 *
 * ★ WHAT HAPPENS WHEN THE BUDGET IS SPENT. An avatar is decoration, and the
 * existing `!response.ok` branch in `route.ts`'s `GET` already turns "no image"
 * into the generated initial-letter fallback — the ONLY reason that branch was
 * not already reached on a hang is that `withRetry` REJECTS on final failure,
 * and an unhandled rejection out of this function propagated straight to
 * `GET`'s own `catch` and returned a 500 (confirmed: the three log lines above
 * are printed by that exact `catch`'s `console.error`). So this also fixes a
 * second, real bug: a hard failure here was never hitting the fallback avatar,
 * it was 500ing. The `try/catch` below now turns ANY failure or timeout from
 * ANY hop into a not-ok, bodyless `Response`, which the caller's existing
 * fallback logic already knows how to turn into `initialAvatar()` — so a
 * timeout now degrades exactly like a 404 always did, never like a 500.
 */
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Per-attempt ceiling — see the measurement above. */
export const HOP_TIMEOUT_MS = 2000;
/** Ceiling on the WHOLE multi-hop call, shared across every hop and every retry. */
export const TOTAL_BUDGET_MS = 3000;

/**
 * A signal that aborts at whichever comes first: `HOP_TIMEOUT_MS` from now, or
 * `deadline`. Computed fresh on every call (never memoized into a `fn` closure
 * that `withRetry` reuses across attempts) so a second attempt on the same hop
 * gets a shrinking window, not the first attempt's already-ticking clock.
 */
export function hopSignal(deadline: number): AbortSignal {
  const remainingMs = Math.max(0, Math.min(HOP_TIMEOUT_MS, deadline - Date.now()));
  return AbortSignal.timeout(remainingMs);
}

/**
 * A synthetic not-ok Response for "the budget ran out" — deliberately the same
 * shape `!response.ok` already branches on, so no caller needs a new case.
 */
export function budgetExhausted(): Response {
  return new Response(null, { status: 504, statusText: 'avatar-fetch-budget-exhausted' });
}

export async function fetchAsWebp(shortcutUrl: string, label: string): Promise<Response> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  try {
    const probe = await withRetry(
      () => fetch(shortcutUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: hopSignal(deadline) }),
      { label: `${label}-probe`, budgetMs: Math.max(0, deadline - Date.now()) }
    );

    const location = probe.headers.get('location');
    if (!REDIRECT_STATUSES.has(probe.status) || !location) {
      return probe;
    }

    const original = new URL(location, shortcutUrl);
    const asWebp = new URL(original);
    asWebp.searchParams.set('format', 'webp');

    if (Date.now() >= deadline) return budgetExhausted();

    const webp = await withRetry(
      () => fetch(asWebp.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: hopSignal(deadline) }),
      { label, budgetMs: Math.max(0, deadline - Date.now()) }
    );
    if (webp.ok && webp.body) {
      return webp;
    }

    if (Date.now() >= deadline) return budgetExhausted();

    return await withRetry(
      () => fetch(original.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: hopSignal(deadline) }),
      { label: `${label}-fallback`, budgetMs: Math.max(0, deadline - Date.now()) }
    );
  } catch (error) {
    // Any hop that timed out or failed after exhausting its retries lands here
    // instead of rejecting past this function — see the doc comment above for
    // why that rejecting-past-here was itself the second bug (a 500 instead of
    // the fallback avatar).
    console.error(`${label}: avatar fetch timed out or failed, serving fallback:`, error);
    return budgetExhausted();
  }
}
