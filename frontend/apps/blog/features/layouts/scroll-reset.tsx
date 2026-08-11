'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * ★★★ A NEW PAGE STARTS AT THE TOP (2026-08-10, fuckery list N-2).
 *
 * Measured: scroll the wallet page down, click Settings in the left rail, and
 * Settings opens part-way down its own content with the top of the page above
 * the viewport. Next's App Router only restores or resets scroll for navigations
 * it drives itself, and several of this app's rails and tab rows navigate with
 * `{ scroll: false }` or swap content under a stable route, so the offset from
 * the page you left survives into the page you arrived at.
 *
 * The per-post fix in `app/[param]/[p2]/[permlink]/content.tsx` proved the
 * pattern (land at the top of the article, keyed on the permlink). This is the
 * same idea for every route, in one place, so no future page has to remember.
 *
 * ★ TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 *  * It does not fire on the FIRST render. A deep link with a `#fragment`, and
 *    the browser's own restore on a hard reload, both land before this runs;
 *    yanking the reader to the top would undo them.
 *  * It does not fire on BACK or FORWARD. Returning to a feed you had scrolled
 *    halfway down and being dropped at the top is the single most annoying
 *    version of this bug, and it is the one case where the old offset is the
 *    right answer. `popstate` fires before React re-renders with the new
 *    pathname, so the flag is already set by the time the effect below runs.
 *
 * It keys on the PATHNAME only, never on the query string: the For You / Feed /
 * Predictions tabs switch by rewriting the query with `{ scroll: false }` and
 * are explicitly not navigations to a new page.
 */
export default function ScrollReset() {
  const pathname = usePathname();
  const isFirstRender = useRef(true);
  const isHistoryPop = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      isHistoryPop.current = true;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (isHistoryPop.current) {
      isHistoryPop.current = false;
      return;
    }
    // An in-page anchor is a destination too — honour it over "go to the top".
    if (window.location.hash) return;
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
