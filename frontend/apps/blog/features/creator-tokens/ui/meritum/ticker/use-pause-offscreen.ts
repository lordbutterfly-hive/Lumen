'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Pause an element's CSS animation while it is off screen.
 *
 * React port of `handoff_meritum_onboarding/ticker/ticker-pause-offscreen.js`,
 * which the package README calls "the one optimisation worth shipping" and
 * "matters more on a long feed page than anything else in this folder".
 *
 * WHY IT MATTERS. The tape is a 58-second `infinite` translate. A compositor
 * animation does not stop because it scrolled out of view — the browser keeps
 * ticking the layer and keeps producing frames for something nobody can see.
 * On a Hive feed page, where the intro card can sit thousands of pixels above
 * the reader, that is pure battery burn. One IntersectionObserver takes the
 * cost to zero.
 *
 * WHY A RAW OBSERVER AND NOT `react-intersection-observer` (which this app
 * already has as a dependency): `useInView` reports visibility as React state,
 * so every scroll past the tape would re-render this subtree just to arrive at
 * the same DOM. Writing `animationPlayState` straight onto the node is a
 * single style mutation, no render, no reconciliation — and there is no state
 * here that any other part of the tree needs to read.
 *
 * The three things that have to be right:
 *  1. `observer.disconnect()` on unmount. An observer that outlives its node
 *     holds a strong reference to it and keeps the whole subtree alive.
 *  2. The play state is cleared on cleanup, so a node that is torn down while
 *     PAUSED cannot come back (StrictMode double-mount, a toggled `enabled`,
 *     a fast-refresh) with a dead `paused` still written inline.
 *  3. Guard `IntersectionObserver` being absent — this runs during SSR and in
 *     any environment without the API. Absent means "leave the animation
 *     alone", which degrades to today's behaviour rather than a broken tape.
 *
 * Reduced motion needs no handling here: the stylesheet sets `animation: none`
 * for those users, and setting a play state on an element with no animation is
 * a no-op.
 *
 * @param enabled Set false to leave the animation running unconditionally.
 * @returns A ref to attach to the ANIMATED element (the one carrying the
 *          `animation` shorthand), not to a wrapper.
 */
export function usePauseAnimationOffscreen<T extends HTMLElement>(
  enabled = true,
  userPaused = false
): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;

    // ★ THE USER'S PAUSE OUTRANKS VISIBILITY (WCAG 2.2.2, added 2026-08-15).
    // Without an observer we cannot know whether the tape is on screen, but we
    // can still honour an explicit pause — failing open to "running" here would
    // make the control silently dead on any engine lacking IntersectionObserver.
    if (typeof IntersectionObserver === 'undefined') {
      node.style.animationPlayState = userPaused ? 'paused' : '';
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // `entry.target` is typed `Element` and has no `.style`; the captured
          // `node` is the same element and is typed, so use that.
          //
          // Two independent reasons to be paused, ANDed rather than racing: the
          // tape is off screen (an optimisation), or the reader asked it to stop
          // (a conformance requirement). Whichever is true wins. Because this
          // effect lists `userPaused` as a dependency, toggling the control
          // rebuilds the observer, which fires immediately with the current
          // intersection and re-applies the play state — so the button takes
          // effect at once instead of waiting for the next scroll.
          node.style.animationPlayState = entry.isIntersecting && !userPaused ? 'running' : 'paused';
        }
      },
      // Any sliver on screen counts as visible. A larger threshold would pause
      // the tape while part of it is still being read.
      { threshold: 0 }
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
      node.style.animationPlayState = '';
    };
  }, [enabled, userPaused]);

  return ref;
}
