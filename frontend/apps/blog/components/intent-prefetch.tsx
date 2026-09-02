'use client';

import { useCallback, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/**
 * ★★ PREFETCH ON INTENT, NOT ON SIGHT (snappiness phase 4, 2026-09-03).
 *
 * Every Link in this app has `prefetch={false}` (packages/ui/components/link.tsx,
 * inherited from Denser) because prefetching every link in the viewport turned
 * a home page into dozens of server renders. The cost of that choice was
 * measured: a first click on a topic paid the route payload, THEN the route's
 * code, THEN the data, three serial round trips, ~0.9 s to the first card.
 *
 * This is the middle: when a pointer has RESTED on a link for 80 ms (a sweep
 * across a row of chips fires nothing), we prefetch exactly that route, fully,
 * at most once a minute per link, and never the page we are already on.
 * `kind: 'full'` because the topic page is dynamic and the default "partial"
 * prefetch would stop at the loading boundary. Ecency does the same with its
 * IntentLink.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (found in review, and one of them is an
 * owner ruling recorded in lib/feed/topic-warmer.ts): no data fetch on hover
 * (a cold tag would fire a live chain call for a tag nobody opens; the topic
 * warmer keeps the chips' data warm and the prefetched page carries it), no
 * prefetch on keyboard focus (a Tab sweep through the rail and the chips was
 * 13 renders in a second; the loading boundary already answers a keyboard
 * navigation on screen), no prefetch on touch (a finger starting to scroll the
 * mobile drawer is not intent).
 */
const REST_MS = 80;
const REPEAT_MS = 60_000;
const fired = new Map<string, number>();

export interface IntentPrefetch {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function useIntentPrefetch(href: string): IntentPrefetch {
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const arm = useCallback(() => {
    if (!href || href === pathname) return;
    const last = fired.get(href);
    const now = Date.now();
    if (last !== undefined && now - last < REPEAT_MS) return;
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      fired.set(href, Date.now());
      try {
        // `kind` is typed as an enum Next does not export from a public path;
        // the wire value is the string.
        router.prefetch(href, { kind: 'full' as never });
      } catch {
        // A failed prefetch costs nothing: the click fetches as before.
      }
    }, REST_MS);
  }, [href, pathname, router, cancel]);
  return { onPointerEnter: arm, onPointerLeave: cancel };
}
