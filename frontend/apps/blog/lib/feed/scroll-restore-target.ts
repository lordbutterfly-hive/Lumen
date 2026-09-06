/**
 * ★★★ WHERE TO RESTORE SCROLL TO, AFTER THE SSR REVEAL (2026-09-06,
 * coordinator review #2 on SIGNED-IN-HOME-BUILD-MAP-2026-09-06.md item 2).
 * Pure decision, no I/O, unit-tested next door — `ForYouFeed`'s layout
 * effects read `performance.getEntriesByType('navigation')` and
 * `sessionStorage` themselves and hand this function only the two facts that
 * decide anything, so the decision itself has a test that needs no DOM, no
 * `window`, and no browser APIs at all.
 *
 * ONLY a reload or a back/forward navigation restores anything. A fresh
 * visit, a plain link click, or a soft client-side navigation should land at
 * the top exactly as they always have — restoring scroll into a feed the
 * reader is opening for the first time would be a new bug, not a fix for the
 * one this exists to close.
 *
 * `savedPosition` must be a positive, finite number to be honoured: `null`
 * (a first-ever visit to this browser, or the tab closed before the scroll
 * keeper ever wrote anything), a non-finite value (a corrupted
 * `sessionStorage` entry) and `0`/negative (the reader was already at the
 * top when it was saved) all mean "do nothing" — `window.scrollTo(0, 0)` is
 * indistinguishable from never calling it, and calling it anyway is pure
 * risk for zero benefit.
 */
export function computeScrollRestoreTarget(
  navigationType: string | undefined,
  savedPosition: number | null
): number | null {
  if (navigationType !== 'reload' && navigationType !== 'back_forward') return null;
  if (savedPosition === null || !Number.isFinite(savedPosition) || savedPosition <= 0) return null;
  return savedPosition;
}
