/**
 * Detects a webpack/Next.js ChunkLoadError and reloads the tab to pick up the
 * new deploy's chunk manifest — the fix for "ChunkLoadError: Loading chunk
 * app/layout failed", which in production means: this tab loaded before the
 * last deploy, and the chunk it now needs was purged along with the old
 * build. The chunk is not coming back; only a fresh document load (which
 * fetches the CURRENT build's HTML and manifest) can recover.
 *
 * ★★★ THIS IS ONE OF TWO LAYERS, NOT THE WHOLE FIX (2026-08-11).
 *
 * This module is used by `app/error.tsx` and `app/global-error.tsx` — but
 * measured in this repo: when the failing chunk is `app/layout.js` itself,
 * `app/error.js` and `app/global-error.js` are typically purged in the SAME
 * deploy and fail to load too, so there is no guarantee any React error
 * boundary's own code ever executes to catch anything. `app/layout.tsx` also
 * carries a plain inline `<script>` with the same detection+reload logic
 * duplicated in vanilla JS, because an inline script embedded directly in the
 * HTML document has no chunk of its own to fail loading. That script is the
 * one that actually saves the worst case; these exports cover the case where
 * React itself is still able to catch the error (a lazy-loaded route chunk
 * failing during a client-side navigation on an already-hydrated page, where
 * error.tsx's own code is already resident in memory).
 *
 * Keep `RELOAD_STORAGE_KEY` and the cooldown value here in sync with the
 * inline script in `app/layout.tsx` — they share the same sessionStorage key
 * so the two layers cannot double-reload each other into a loop.
 */

const RELOAD_STORAGE_KEY = 'lumen:chunk-reload-at';

// Long enough that a genuine repeat failure (the origin is actually down, not
// just serving a stale manifest) does not reload the tab forever — a reload
// loop is a worse experience than the blank page this exists to prevent.
const RELOAD_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Webpack throws an `Error` with `name === 'ChunkLoadError'` for both JS and
 * CSS chunk failures ("Loading chunk N failed", "Loading CSS chunk N
 * failed"). Matched by name first — what webpack actually sets — and by
 * message as a fallback, in case something in Next's own error-digest
 * plumbing re-wraps the error and drops the custom name.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /Loading (chunk|CSS chunk) [\w./-]+ failed/i.test(error.message);
}

/**
 * Reload the tab once to pick up the new deploy — but never more than once
 * per `RELOAD_COOLDOWN_MS`. Storage failures (private browsing, storage
 * disabled) fall through to a best-effort single reload rather than getting
 * stuck: without the guard available there is no way to remember a previous
 * attempt, so doing the reload anyway is the safer default over doing
 * nothing.
 */
export function reloadOnceForChunkError(): void {
  if (typeof window === 'undefined') return;
  // ★★★ NEVER RELOAD WITH NO NETWORK (2026-08-13) — the same rule, from the same
  // measurement, as the inline copy of this logic in `app/layout.tsx`: offline, a
  // reload is a document request that cannot come back, so it replaces the whole
  // app with the browser's network-error page. Reproduced there with one
  // synthetic 'Loading chunk 917 failed' on a fully working page: the tab ended
  // on `chrome-error://chromewebdata/`, no click anywhere. Offline the chunk is
  // not PURGED (the case this module exists for), only unreachable — it loads
  // when the connection does. The cooldown key is deliberately NOT written here:
  // this attempt never happened, and a genuine stale-manifest failure after
  // reconnecting must still be allowed its one reload.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  let last = 0;
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_STORAGE_KEY)) || 0;
  } catch {
    // Fall through — see comment above.
  }
  const now = Date.now();
  if (now - last < RELOAD_COOLDOWN_MS) return;
  try {
    window.sessionStorage.setItem(RELOAD_STORAGE_KEY, String(now));
  } catch {
    // Fall through — see comment above.
  }
  window.location.reload();
}
