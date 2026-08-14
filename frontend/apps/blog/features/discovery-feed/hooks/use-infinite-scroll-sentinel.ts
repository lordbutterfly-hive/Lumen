'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';

/**
 * ★★★ ONE SCROLL GESTURE WAS BUYING TWO PAGES (2026-08-13) — MEASURED FIRST.
 *
 * Every infinite list in this app auto-paged with the same four lines:
 *
 *     const { ref, inView } = useInView();
 *     useEffect(() => {
 *       if (inView && hasNextPage && !isFetching) fetchNextPage();
 *     }, [inView, hasNextPage, isFetching, fetchNextPage]);
 *
 * and every one of them fetched TWICE per gesture. Measured on the reference
 * build (:3000, `.next-final2`) with a probe that scrolls to the bottom exactly
 * once and then sits still for twenty seconds:
 *
 *   /                     one scroll -> 2 requests (t+19081ms, t+22436ms)
 *   /@lordbutterfly       one scroll -> 2 requests (t+21548ms, t+23675ms)
 *   /@lordbutterfly/comments  one scroll -> 2 requests (t+21259ms, t+21790ms)
 *
 * The reader asked for one page and got two, every time — which is the audit's
 * "`/api/feed/for-you` fired 1 -> 2 -> 4 -> 5 -> 7 times" doubling, and it is
 * also why the DOM, the image count and the heap all grew twice as fast as the
 * scrolling justified.
 *
 * WHY. `inView` is not a live reading of the sentinel's position. It is a
 * boolean React state that `IntersectionObserver` updates from a callback
 * delivered in a LATER task. So the sequence is:
 *
 *   1. sentinel enters view          -> inView: true  -> effect fires, page N requested
 *   2. page N lands, 30 cards render -> the sentinel is now ~12,000px BELOW the
 *                                       viewport, but no observer callback has
 *                                       been delivered yet, so `inView` is STILL true
 *   3. `isFetching` flips false      -> the effect re-runs on that dep change,
 *                                       reads the stale `inView: true`, and fires
 *                                       AGAIN for page N+1
 *   4. only now does the observer report false — one page too late
 *
 * The guard was never wrong about "am I already fetching"; it was wrong about
 * "is the sentinel actually on screen", and no boolean that arrives a task late
 * can answer that at the moment the decision is made.
 *
 * THE FIX is to stop trusting the cached boolean at the point of decision and
 * read the geometry, which is synchronous and cannot be stale. `inView` still
 * does what it is good at — waking the effect up — and `getBoundingClientRect()`
 * decides. At step 3 above, the sentinel's real `top` is 12,000px, the effect
 * returns, and the second request never happens.
 *
 * ★★★ AND THE WAKE-UP CANNOT BE THE OBSERVER ALONE (found by measurement, same
 * day, BEFORE shipping). With the geometry gate in and the observer as the only
 * waker, a fast scroll stalled: forty scroll-to-bottom gestures at 550ms apart
 * paged twice and then stopped, with `hasNextPage` still true and the sentinel
 * on screen. `IntersectionObserver` reports CROSSINGS, and React coalesces the
 * state updates — a false->true->false pair landing inside one batch nets to no
 * change, so the effect never runs and paging dead-ends until the reader
 * scrolls again. This is not a new hazard: `features/witnesses/witnesses-table.tsx`
 * documents the identical "STUCK AT 120/250" stall for the same reason.
 *
 * So the decision is now LEVEL-triggered from two independent wakers — the
 * observer (which covers the cases with no scrolling at all: a first page
 * shorter than the viewport, a page every post of which was filtered away) and
 * a passive, rAF-throttled `scroll`/`resize` listener (which cannot be
 * coalesced away, because it re-reads position on the frames the reader is
 * actually moving). Both funnel into the same geometry check, so neither can
 * fetch for a sentinel that is not on screen.
 *
 * ★ THIS DELIBERATELY PRESERVES THE FX3 FIX (2026-08-12) that mounted these
 * sentinels on `hasNextPage` alone: if a page renders NOTHING (every post on it
 * removed by NSFW-hide or by the reader's block list) the sentinel really is
 * still on screen after it lands, the geometry check agrees, and paging
 * continues until real content appears. An edge-triggered "only fire on a fresh
 * false->true transition" fix would have re-broken exactly that dead end, which
 * is why this is a level check against live geometry and not an edge latch.
 *
 * ★ AND IT BOUNDS THE LIST. See `autoPageCap`.
 */

interface Options {
  /** React Query's `hasNextPage`. */
  hasNextPage: boolean | undefined;
  /** Any fetch in flight for this query — `isFetching` or `isFetchingNextPage`. */
  isFetching: boolean;
  fetchNextPage: () => unknown;
  /** True when the last attempt failed: never refire into a failure. */
  isError?: boolean;
  /**
   * How far ahead of the viewport paging should start, in px. 0 means "when the
   * sentinel is actually visible". The profile and tag lists page 1500px early
   * on purpose; passing it here keeps the observer and the geometry check
   * measuring the same thing.
   */
  rootMarginPx?: number;
  /** `data.pages.length` — how many pages are currently held. */
  pagesLoaded: number;
  /**
   * Stop auto-paging once this many pages are held, and let the caller offer a
   * "Load more" instead. Each `loadMore()` grants another window of the same
   * size, so the list only ever grows on a deliberate act.
   */
  autoPageCap?: number;
}

export interface InfiniteScrollSentinel {
  /** Put this on the element that marks the end of the list. */
  ref: (node?: Element | null) => void;
  /** Auto-paging has stopped because the cap was reached and more pages exist. */
  atPageCap: boolean;
  /** Grant another window of pages. */
  loadMore: () => void;
  /** Send the reader back to the top of a long list. */
  backToTop: () => void;
  /** Ask for the failed page again, bypassing the auto-paging guards. */
  retry: () => void;
}

/**
 * ★★★ THE CEILING (2026-08-13). Measured on :3000 before any change: forty
 * scroll-to-bottom gestures on `/` left the reader holding 250,227px of
 * document, 47,236 DOM elements, 1,649 images and 345MB of JS heap — from 30
 * posts, 1,972 elements and 48MB at rest. `/topics/*` was worse on heap (1.06GB).
 * Nothing was ever released and nothing ever stopped.
 *
 * Five pages is 150 posts on the feed and 100 on a profile — roughly 45,000px
 * of column, which is far more than anyone reads in a sitting, and it is a
 * CEILING ON PASSIVE SCROLLING only: the reader who genuinely wants more clicks
 * once and gets another five. Nothing is hidden, no ordering changes, and the
 * end of the list is still reachable.
 *
 * ★ WHY A CAP AND NOT WINDOWING. There is no virtualisation library anywhere in
 * this workspace (checked every `package.json` in `apps/` and `packages/`: the
 * only list-adjacent dependency is `react-intersection-observer`), and adding
 * one was ruled out. Hand-rolling windowing over variable-height post cards —
 * which is what unmounting off-screen cards means without a library — needs
 * measured heights, placeholder spacers and scroll-anchoring, and it fights the
 * two sticky rails and the browser's own anchoring on every list this touches.
 * A cap gets most of the same bound for none of that risk.
 */
export const FEED_AUTO_PAGE_CAP = 5;

export function useInfiniteScrollSentinel({
  hasNextPage,
  isFetching,
  fetchNextPage,
  isError = false,
  rootMarginPx = 0,
  pagesLoaded,
  autoPageCap
}: Options): InfiniteScrollSentinel {
  const { ref: inViewRef, inView } = useInView({ rootMargin: `${rootMarginPx}px 0px` });
  // The sentinel's own node, so the effect can ask where it IS rather than
  // where the observer last said it was.
  const nodeRef = useRef<Element | null>(null);
  const ref = useCallback(
    (node?: Element | null) => {
      nodeRef.current = node ?? null;
      inViewRef(node ?? null);
    },
    [inViewRef]
  );

  /** Extra windows the reader has explicitly asked for. */
  const [grantedWindows, setGrantedWindows] = useState(0);
  const cap = autoPageCap ? autoPageCap * (grantedWindows + 1) : Number.POSITIVE_INFINITY;
  const atPageCap = Boolean(hasNextPage) && pagesLoaded >= cap;

  // The scroll listener below runs outside React's render, so it needs the
  // CURRENT guards, not the ones captured when it was attached. Written during
  // render on purpose and idempotent — the same previous-value-ref pattern
  // `feed-tabs.tsx` already uses for `lastRendered`.
  const latest = useRef({ hasNextPage, isFetching, isError, atPageCap, rootMarginPx, pagesLoaded, fetchNextPage });
  latest.current = { hasNextPage, isFetching, isError, atPageCap, rootMarginPx, pagesLoaded, fetchNextPage };

  /**
   * ★★★ `isFetching` IS A RENDER BEHIND, SO IT CANNOT BE THE ONLY IN-FLIGHT
   * GUARD (measured 2026-08-13, after the geometry fix was already in).
   *
   * Clicking "Load more" produced TWO requests and one of them was a
   * byte-identical duplicate of the other — the exact fault the audit reported
   * and the geometry gate alone did not close. Both wakers can run inside a
   * single frame, before React Query has committed `isFetching: true`, so both
   * read false and both call `fetchNextPage()`. React Query v4 answers a second
   * `fetchNextPage` during an in-flight one by CANCELLING the first and
   * re-issuing it — with the same cursor — and because these `queryFn`s do not
   * wire the abort signal, the cancelled request still completes on the wire.
   * Two identical requests, one discarded response.
   *
   * Remembering which page count we already asked for closes that window
   * synchronously, with no dependency on when React re-renders.
   */
  const requestedForPages = useRef(-1);
  const wasFetching = useRef(false);
  useEffect(() => {
    // A fetch settled (either way). Re-arm, so a page that legitimately needs
    // another one — a fully NSFW-filtered page, say — is not locked out.
    if (wasFetching.current && !isFetching) requestedForPages.current = -1;
    wasFetching.current = isFetching;
  }, [isFetching]);

  /** The one decision, from live position. Safe to call as often as you like. */
  const maybeFetch = useCallback(() => {
    const s = latest.current;
    if (!s.hasNextPage || s.isFetching || s.isError || s.atPageCap) return;
    if (requestedForPages.current === s.pagesLoaded) return;
    const node = nodeRef.current;
    // No sentinel in the DOM means no end-of-list to page from. Never guess.
    if (!node || typeof window === 'undefined') return;
    const rect = node.getBoundingClientRect();
    // Below the (margin-extended) viewport: the page that just landed pushed
    // the sentinel off screen and `inView` has not caught up. This is the
    // second fetch, and this is where it dies.
    if (rect.top > window.innerHeight + s.rootMarginPx) return;
    // Entirely above it: the reader scrolled back up past the end of the list,
    // which is not a request for more.
    if (rect.bottom < -s.rootMarginPx) return;
    requestedForPages.current = s.pagesLoaded;
    s.fetchNextPage();
  }, []);

  /**
   * A manual retry, deliberately outside the latch and the geometry check: the
   * reader pressed a button, which is an instruction, not an inference.
   */
  const retry = useCallback(() => {
    requestedForPages.current = -1;
    latest.current.fetchNextPage();
  }, []);

  // Waker 1 — the observer. `inView` is only a reason to LOOK; `maybeFetch`
  // decides. Running it on every dep change (not only when `inView` is true)
  // is what keeps a fully-filtered page advancing: that page lands, `isFetching`
  // flips, the sentinel genuinely has not moved, and the geometry agrees.
  useEffect(() => {
    maybeFetch();
  }, [inView, hasNextPage, isFetching, isError, atPageCap, maybeFetch]);

  // Waker 2 — actual scrolling. rAF-throttled to one geometry read per frame.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        maybeFetch();
      });
    };
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove, { passive: true });
    return () => {
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [maybeFetch]);

  // Raising the ceiling is all `loadMore` does. The sentinel is by definition on
  // screen when the reader clicks it, so flipping `atPageCap` re-runs the effect
  // above and it pages exactly once — calling `fetchNextPage()` here as well
  // would be the double fetch this hook exists to remove.
  const loadMore = useCallback(() => setGrantedWindows((n) => n + 1), []);
  const backToTop = useCallback(() => {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return { ref, atPageCap, loadMore, backToTop, retry };
}
