'use client';

import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
 * This is the middle: when a pointer has MOVED onto a link and then RESTED on
 * it for 80 ms (a sweep across a row of chips fires nothing), we prefetch
 * exactly that route, fully, at most once a minute per link, and never the page
 * we are already on. `kind: 'full'` because the topic page is dynamic and the
 * default "partial" prefetch would stop at the loading boundary. Ecency does the
 * same with its IntentLink.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (found in review, and one of them is an
 * owner ruling recorded in lib/feed/topic-warmer.ts): no data fetch on hover
 * (a cold tag would fire a live chain call for a tag nobody opens; the topic
 * warmer keeps the chips' data warm and the prefetched page carries it), no
 * prefetch on keyboard focus (a Tab sweep through the rail and the chips was
 * 13 renders in a second; the loading boundary already answers a keyboard
 * navigation on screen), no prefetch on touch (a finger starting to scroll the
 * mobile drawer is not intent).
 *
 * ★★★ PROFILE LINKS, AND WHAT THEY COST (2026-09-05, snappiness phase 4b).
 * Opening a profile nobody has opened before is the app's slowest navigation:
 * the render is an account read plus the first page of that account's posts,
 * measured on prod at ~200 ms + p50 540 ms, and a client-side navigation pays
 * all of it AFTER the click, with nothing moving on screen until it lands. The
 * feed byline, the reblog line, the navbar's own avatar and the links inside
 * the author popover now arm this hook, so a reader who rests on a name has the
 * page in hand by the time they press it.
 *
 * ★★ THIS IS NOT THE DATA FETCH THE OWNER RULED OUT, BUT IT IS NOT AS FREE AS
 * THE TOPIC CHIPS EITHER, AND THAT DIFFERENCE IS STATED HERE RATHER THAN
 * GLOSSED. The standing ruling (lib/feed/topic-warmer.ts) forbids fetching a
 * TAG's data on hover; a topic ROUTE prefetch was accepted because the topic
 * render reads the warmer's memo and makes no chain call at all. A profile has
 * no warmer, so a hovered profile route DOES reach the chain on a cold cache —
 * one render, exactly the work the click was about to ask for anyway. What
 * bounds it is that the two caches it fills are the ones the click reads:
 * `getAccountFullCached` (30 s TTL + 30 s stale) and `getAccountPostsCached`
 * (25 s + 25 s), so a prefetch and the click that follows it are ONE upstream
 * round trip, not two, and `REPEAT_MS` below is deliberately 60 s — the same
 * order as those lifetimes, so a re-hover inside the warm window fires nothing.
 * A hover that never becomes a click costs one render and warms the cache for
 * the next reader of that profile; it evicts nothing a reader needs (both caches
 * are sized well above their live working set — see lib/cached-api.ts).
 *
 * ★★★ THE CEILING IS THE PER-IP PAGE BUDGET, AND IT HAS NOW BEEN RAISED
 * (lib/request-budget.ts:60-68 ruled that router prefetches count as page
 * renders and named this exact moment: "when phase 4 turns hover prefetch on,
 * the per-IP client budget is the knob to raise"). It has been, 60 -> 90 per
 * minute per worker, with the arithmetic — and the per-worker dilution that
 * makes the real ceiling LUMEN_WORKERS times that — in that file. But a budget is the thing that
 * SAVES a reader from a mistake here, not the thing that makes the design
 * correct — a reader who trips it gets a 429 on their own next page. So this
 * module carries its own, tighter limiter below, and the server budget is the
 * backstop behind it rather than the first line of defence.
 */
const REST_MS = 80;
const REPEAT_MS = 60_000;

/**
 * ★★★ THE PAGE-WIDE LIMITER (2026-09-05, review of phase 4b). Everything above
 * is a per-LINK rule, and per-link rules do not add up to a bound: a 30-card
 * feed has 30 distinct profile hrefs in the byline column, so "once a minute
 * per href" permits 30 profile renders a minute from one reader, and profile
 * renders are the most expensive page this app serves. These three numbers are
 * the bound that does not depend on how many links happen to be on screen.
 *
 * ONE AT A TIME (`inFlight`). Two prefetches racing on one Node thread is the
 * shape that starved the event loop under crawler load (see
 * lib/feed/account-posts-seed-cache.ts's header for what that cost), and a
 * reader can only click one link next, so there is nothing to gain from a
 * second. HOW IT IS ENFORCED, HONESTLY: App Router's `router.prefetch()`
 * returns `void`, not a promise, so there is no completion signal to wait on
 * from here. "In flight" is therefore approximated as a fixed window after a
 * fire — the same `MIN_GAP_MS` below — which is the strongest claim the API
 * actually supports. Stated rather than implied, because a reader of this code
 * would otherwise assume a real handle on the request.
 *
 * A GAP BETWEEN FIRES (`MIN_GAP_MS`, 1.5 s). Long enough that a pointer
 * travelling down a column of bylines cannot chain one render per link, short
 * enough that a reader who genuinely changes their mind about which name to
 * open still gets the second one warmed before they reach it.
 *
 * A CEILING PER MINUTE (`MAX_PER_MINUTE`, 15). The honest reason for a number
 * and not a formula: 15 profile renders a minute is about four times what a
 * measured human hover rate produces and still a sixth of the raised per-worker
 * page budget (an eighteenth of what one IP can actually reach across the three
 * workers), so a reader who somehow saturates this limiter cannot come close to
 * 429-ing themselves. It is a rolling window (a timestamp ring pruned on
 * read), not a per-minute reset, so a burst cannot hide in a window boundary.
 */
const MIN_GAP_MS = 1_500;
const MAX_PER_MINUTE = 15;
const WINDOW_MS = 60_000;
/**
 * ★ AND THE per-href LEDGER IS BOUNDED TOO. `fired` used to grow for the life of
 * the tab: one entry per href ever hovered, never removed, on a surface built
 * for infinite scroll. 200 is far above the number of distinct links one page
 * can present between reloads, and eviction is by oldest FIRE (Map preserves
 * insertion order), which is also the entry whose 60 s repeat guard is most
 * likely already expired — so an eviction almost never resurrects a real
 * prefetch, and the page-wide limiter above bounds it even when it does.
 */
const FIRED_MAX = 200;

const fired = new Map<string, number>();
const recentFires: number[] = [];
let lastFireAt = 0;
let inFlight = false;
let inFlightTimer: ReturnType<typeof setTimeout> | null = null;

function rememberFire(href: string, now: number): void {
  fired.delete(href);
  fired.set(href, now);
  while (fired.size > FIRED_MAX) {
    const oldest = fired.keys().next().value;
    if (oldest === undefined) break;
    fired.delete(oldest);
  }
  lastFireAt = now;
  recentFires.push(now);
  inFlight = true;
  if (inFlightTimer) clearTimeout(inFlightTimer);
  inFlightTimer = setTimeout(() => {
    inFlight = false;
    inFlightTimer = null;
  }, MIN_GAP_MS);
}

/** Checked at FIRE time, not at arm time: 80 ms of rest is long enough for the
 *  answer to change, and a timer that was allowed to start is not a promise
 *  that it may fire. */
function limiterAllows(now: number): boolean {
  if (inFlight) return false;
  if (now - lastFireAt < MIN_GAP_MS) return false;
  while (recentFires.length > 0 && now - recentFires[0] >= WINDOW_MS) recentFires.shift();
  return recentFires.length < MAX_PER_MINUTE;
}

/**
 * ★ A COARSE POINTER HAS NO HOVER, SO IT MUST NOT PREFETCH. On a phone or a
 * tablet a tap fires `pointerenter` immediately before `click`, so the 80 ms
 * rest above is not a signal of intent there — it is the click itself, arriving
 * a moment early, and the prefetch it would fire is a second render of a page
 * the navigation is already fetching. Same rule the header states for touch,
 * enforced at the device rather than at the event: `(pointer: coarse)` asks
 * about the PRIMARY pointing device, so a touchscreen laptop driven by a mouse
 * still prefetches and a phone never does.
 *
 * ★ KNOWN LIMITATION, ACCEPTED: iPadOS reports `(pointer: coarse)` even when a
 * trackpad or mouse is attached and a real hover cursor is on screen, so those
 * readers get no intent prefetch at all. Left as-is deliberately — the failure
 * mode is a missed optimisation for a small population, while the alternative
 * (trusting `(any-pointer: fine)`, which every touchscreen laptop and many
 * tablets also report) would re-open tap-fires-prefetch on the whole touch
 * population. Do not "fix" this by loosening the query.
 *
 * A browser with no `matchMedia` is treated as a hovering one: that is the
 * desktop case, and the failure mode of guessing wrong there is a prefetch we
 * would have made anyway, not a wasted one.
 */
function pointerCanHover(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return true;
  try {
    return !window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return true;
  }
}

export interface IntentPrefetch {
  onPointerEnter: (event: ReactPointerEvent<Element>) => void;
  onPointerMove: (event: ReactPointerEvent<Element>) => void;
  onPointerLeave: () => void;
}

export function useIntentPrefetch(href: string): IntentPrefetch {
  const router = useRouter();
  const pathname = usePathname();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the pointer was when it entered — see `onPointerMove` below. */
  const entryPoint = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    entryPoint.current = null;
  }, []);

  /**
   * ★★★ AN ENTER IS NOT A MOVE, AND THE DIFFERENCE IS A SCROLL STORM
   * (2026-09-05, review of phase 4b).
   *
   * This used to arm on `pointerenter`. Consider the actual reading posture
   * this feature is for: a reader wheel-scrolls the feed with the cursor parked
   * wherever they last left it, which on a byline-heavy card is very often the
   * byline column itself. Every card that scrolls under that stationary cursor
   * fires its own `pointerenter`, and each one then sits under the cursor for
   * far longer than 80 ms while the reader reads — so a single flick of the
   * wheel armed and fired a profile prefetch per card passed. Nothing about
   * that is intent: the pointer never moved, the CONTENT did.
   *
   * ★ THE STORM IS MEASURED, NOT ASSUMED, and so is the fix. Instrument:
   * headless Chromium 1148 driven by Playwright against the live home feed,
   * cursor parked on a byline link (`:hover` confirmed on it), then scrolled
   * with the mouse never touched again. A programmatic `scrollBy(0, 900)` fired
   * 1 `pointerenter` + 1 `pointerover`; a real wheel scroll of the same distance
   * fired 3 `pointerenter` + 1 `pointerover`; `:hover` left the link both times.
   * `pointermove` fired ZERO times in both. So the enter-armed version really
   * did arm on scrolling alone, and requiring a move really is sufficient to
   * stop it on this engine.
   *
   * So the rest timer starts on a `pointermove` INSIDE the element, not on
   * entering it. Two details:
   *
   * ★ THE COORDINATE COMPARISON IS BELT AND BRACES, AND IS LABELLED AS SUCH.
   * The measurement above says a bare event count would have been enough for
   * Chrome. It was NOT measured on WebKit or Gecko, and an engine that updates
   * hover after a scroll by dispatching a move at the unchanged position would
   * defeat a bare count — so a move only counts when its client coordinates
   * differ from where the pointer entered. That costs nothing when the move is
   * real (a mouse crossing into an element emits several), and it is the one
   * part of this heuristic that is defensive rather than evidenced. If it ever
   * needs removing, the thing to measure first is Safari.
   *
   * ★ LATER MOVES DO NOT RESTART THE 80 ms. "Rest" here keeps meaning "80 ms
   * since the pointer arrived under its own power", not "80 ms of absolute
   * stillness" — restarting on every move would mean a reader with an unsteady
   * hand, or a trackpad that emits micro-moves, never prefetches anything at
   * all, which is a worse failure than the one being fixed.
   *
   * The cost of getting this wrong in the OTHER direction is small and bounded:
   * a pointer that teleports into an element and freezes (a window switch, a
   * script-driven scroll that lands the cursor mid-element) never arms, and the
   * reader pays the ordinary un-prefetched click they pay today. The page-wide
   * limiter above is the hard backstop for everything this heuristic misses.
   */
  const onPointerEnter = useCallback((event: ReactPointerEvent<Element>) => {
    cancel();
    entryPoint.current = { x: event.clientX, y: event.clientY };
  }, [cancel]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (timer.current) return; // already armed; later moves do not restart it
      const entry = entryPoint.current;
      if (!entry) return; // a move with no enter (Radix re-parenting, a stale ref)
      if (event.clientX === entry.x && event.clientY === entry.y) return; // the content moved, not the pointer
      if (!href || href === pathname) return;
      if (!pointerCanHover()) return;
      const last = fired.get(href);
      if (last !== undefined && Date.now() - last < REPEAT_MS) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const now = Date.now();
        // Re-checked here, not just at arm time: 80 ms is long enough for
        // another link's prefetch to have taken the slot.
        const stillDue = fired.get(href);
        if (stillDue !== undefined && now - stillDue < REPEAT_MS) return;
        if (!limiterAllows(now)) return;
        rememberFire(href, now);
        try {
          // `kind` is typed as an enum Next does not export from a public path;
          // the wire value is the string.
          router.prefetch(href, { kind: 'full' as never });
        } catch {
          // A failed prefetch costs nothing: the click fetches as before.
        }
      }, REST_MS);
    },
    [href, pathname, router]
  );

  return { onPointerEnter, onPointerMove, onPointerLeave: cancel };
}
