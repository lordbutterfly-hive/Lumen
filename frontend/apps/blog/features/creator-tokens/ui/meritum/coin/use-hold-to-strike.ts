'use client';

import { MutableRefObject, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MERITUM_CHARGE_MS,
  MERITUM_HEIGHT_RELEASE_MS,
  MERITUM_REDUCED_MOTION_STEPS,
  MERITUM_STRIKE_MS,
  MeritumStrikePhase
} from './timing';

/**
 * ============================================================================
 * HOLD TO STRIKE — the state machine.
 * ============================================================================
 *
 *   idle --hold--> charging --1100ms--> striking --2400ms--> struck
 *                     |
 *                     +--release / blur / Escape--> idle   (clean abort)
 *
 * ---------------------------------------------------------------------------
 * THE TWO FAILURE MODES THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 *
 * 1. THE HOLD THAT SILENTLY NEVER COMPLETES. The handoff records it:
 *    "DO NOT fire the strike from the ring's `animationend`. If anything
 *     re-renders the ring subtree mid-hold, the animation restarts from
 *     dashoffset 918 and `animationend` never fires."
 *    Nothing in this file listens to an animation event. The hold is a
 *    `setTimeout` for `MERITUM_CHARGE_MS`, and the ring's `animation-duration`
 *    is set inline from that same constant, so the two cannot drift (see
 *    `timing.ts`). The ring is also keyed on `holdId` so React keeps one DOM
 *    node for the whole hold and a re-render cannot restart it anyway — belt as
 *    well as braces, because a visibly restarting ring is its own bug even when
 *    the timer underneath is safe.
 *
 * 2. THE PAGE THAT COLLAPSES MID-STRIKE. The struck panel is shorter than
 *    step 3, so the card must be frozen at its step-3 height for the duration
 *    or the whole thing jumps under the user's finger at the exact moment they
 *    are watching it. Measured on hold start, released 900ms after the reveal.
 *
 * ★ ONE BUG IN THE HANDOFF, DELIBERATELY NOT REPRODUCED.
 *   `strike.js`'s `cancel()` is bound to `pointerup` AND `pointerleave` and
 *   unconditionally clears `card.style.minHeight`. Both fire during the 2400ms
 *   strike — lifting your finger the instant the ring closes is the normal way
 *   to use it — so the lock is released at the START of the strike rather than
 *   after the reveal, and the freeze does nothing in the common case. Here
 *   `abort()` is a no-op unless the machine is still `charging`: once the
 *   strike is committed it runs to the reveal, and only the reveal unlocks.
 *
 * ★ AND THE REDUCED-MOTION HOLD STILL SHOWS PROGRESS. globals.css disables
 *   `.mt-charge-ring` with everything else, on the rule that state must be
 *   readable from colour and fill alone. Left there, a reduced-motion reader
 *   would hold a button for 1.1s with no feedback whatsoever. So when the media
 *   query matches, this hook fills the ring in four discrete steps from the
 *   same timer — static fill levels, no animation, no transition — and the
 *   component paints them straight onto `stroke-dashoffset`.
 */

export interface UseHoldToStrikeOptions {
  /**
   * Fired the moment the hold completes and the strike begins — 1100ms in, with
   * 2400ms of animation still to run. THIS is where the real launch write
   * belongs: it gives the network the whole strike window to land, so the
   * reveal arrives on a result instead of on a spinner.
   */
  onCharged?: () => void;
  /** Fired at the reveal, when the coin turns oxblood. */
  onStruck?: () => void;
  /** Fired when a hold is released before it completes. */
  onAbort?: () => void;
  /** No hold can start while true. A hold already running is aborted. */
  disabled?: boolean;
  /**
   * ★ THE REVEAL GATE. Leave undefined and the coin reveals on the timer, which
   * is right for a decorative coin and WRONG for one standing in for a chain
   * write. Pass `false` while the write is still in flight and the coin holds
   * at `striking`; flip it to `true` and it reveals immediately.
   *
   * WHY THIS EXISTS (2026-08-15, adversarial council). `HoldToStrikeProps`
   * omits `phase`, so a caller had NO way to hold the coin back — the oxblood
   * turn, the embossed legend, the engraved price and the `aria-live`
   * announcement "Struck. Your token is live." all fired `MERITUM_STRIKE_MS`
   * after the hold, no matter what the chain said. The launch flow's TEXT panel
   * was correctly gated on `write === 'ok'`, so at the same instant the caption
   * read "Landing · waiting for the chain to answer" while the coin above it
   * and the screen reader both declared the token live. A signature prompt left
   * unanswered outlasts 2400ms as a matter of course, so this was the ordinary
   * path, not an edge case — and `meritum-launch-flow.tsx`'s own header says
   * this screen must never produce it.
   *
   * A rejected write should still call `reset()`; this gate only withholds the
   * claim, it does not retract one.
   */
  revealWhen?: boolean;
  /**
   * The element to freeze. Point this at the launch CARD, not at the coin — the
   * coin does not change height, the panel underneath it does.
   */
  heightLockRef?: RefObject<HTMLElement | null>;
}

export interface HoldToStrikeApi {
  phase: MeritumStrikePhase;
  /** Increments on every hold. Key the ring on it so each hold gets a fresh sweep. */
  holdId: number;
  /** True when the user has asked for reduced motion. The component swaps the
   *  swept ring for a stepped one; nothing about the timing changes. */
  reducedMotion: boolean;
  /** 0..1, quantised to `MERITUM_REDUCED_MOTION_STEPS`. Only moves under
   *  reduced motion; otherwise the CSS animation owns the sweep. */
  chargeProgress: number;
  /** The frozen height in px while the lock is on, else null. For consumers
   *  that would rather render `min-height` than have it written to their node. */
  lockedHeight: number | null;
  /** Start a hold. Ignored unless idle and enabled. */
  begin: () => void;
  /** Release early. Ignored unless charging — a committed strike is not abortable. */
  abort: () => void;
  /** Force back to idle, dropping every timer and the height lock. For the flow
   *  to call when the launch write fails and the coin must not stay struck. */
  reset: () => void;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    onKeyUp: (e: React.KeyboardEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
}

/** Enter and Space both hold. Older engines still report Space as 'Spacebar'. */
const isHoldKey = (key: string): boolean => key === 'Enter' || key === ' ' || key === 'Spacebar';

type Timer = ReturnType<typeof setTimeout> | null;
type Ticker = ReturnType<typeof setInterval> | null;

export const useHoldToStrike = (options: UseHoldToStrikeOptions = {}): HoldToStrikeApi => {
  const { disabled = false } = options;

  const [phase, setPhase] = useState<MeritumStrikePhase>('idle');
  const [holdId, setHoldId] = useState(0);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const [chargeProgress, setChargeProgress] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  /**
   * The phase is mirrored into a ref because every guard below runs from a
   * timer or a DOM event, where the value captured at render time may be a tick
   * stale. The ref is the machine's real position; the state exists to paint it.
   */
  const phaseRef = useRef<MeritumStrikePhase>('idle');
  const chargeTimer = useRef<Timer>(null);
  const strikeTimer = useRef<Timer>(null);
  const releaseTimer = useRef<Timer>(null);
  /**
   * Set when the strike animation finished but `revealWhen` was false — i.e. the
   * coin is holding at `striking` waiting on a result. Cleared by reset/abort so
   * a later `revealWhen: true` cannot resurrect a hold the user walked away from.
   */
  const pendingReveal = useRef(false);
  const stepTicker = useRef<Ticker>(null);
  const mounted = useRef(true);
  const reducedMotionRef = useRef(false);

  /**
   * Callbacks and the lock target go through a ref so the handlers below stay
   * referentially stable across renders. An `onPointerDown` identity that
   * changes every render is what makes a parent re-render remount a child, and
   * a remounted ring is failure mode 1 wearing a different hat.
   */
  const optsRef = useRef(options);
  optsRef.current = options;

  const clearTimer = (t: MutableRefObject<Timer>): void => {
    if (t.current !== null) {
      clearTimeout(t.current);
      t.current = null;
    }
  };

  const clearTicker = (): void => {
    if (stepTicker.current !== null) {
      clearInterval(stepTicker.current);
      stepTicker.current = null;
    }
  };

  const setPhaseSafe = useCallback((next: MeritumStrikePhase) => {
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }, []);

  /** Watch the media query rather than reading it once: a reader can flip the
   *  OS setting with the launch flow already open. */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => {
      reducedMotionRef.current = query.matches;
      setReducedMotion(query.matches);
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const releaseHeight = useCallback(() => {
    const el = optsRef.current.heightLockRef?.current;
    if (el) el.style.minHeight = '';
    if (mounted.current) setLockedHeight(null);
  }, []);

  const lockHeight = useCallback(() => {
    const el = optsRef.current.heightLockRef?.current;
    if (!el) return;
    const height = Math.ceil(el.getBoundingClientRect().height);
    // A zero measurement means the node is not laid out (display:none, or still
    // detached). Writing `min-height: 0px` would be worse than not locking, so
    // don't — and leave `lockedHeight` null so nobody thinks a lock is on.
    if (height <= 0) return;
    el.style.minHeight = `${height}px`;
    if (mounted.current) setLockedHeight(height);
  }, []);

  /** The reveal: oxblood, callback, then let the card breathe again. */
  const reveal = useCallback(() => {
    clearTimer(strikeTimer);
    setPhaseSafe('struck');
    optsRef.current.onStruck?.();
    releaseTimer.current = setTimeout(releaseHeight, MERITUM_HEIGHT_RELEASE_MS);
  }, [releaseHeight, setPhaseSafe]);

  /**
   * The strike animation has run its length. Reveal ONLY if the caller says the
   * result is in — otherwise stay at `striking` and let `revealWhen` release it.
   * See `revealWhen` in the options for why this gate exists.
   */
  const revealIfAllowed = useCallback(() => {
    clearTimer(strikeTimer);
    if (optsRef.current.revealWhen === false) {
      pendingReveal.current = true;
      return;
    }
    reveal();
  }, [reveal]);

  /**
   * The write landed after the strike animation had already finished, so the
   * coin has been sitting at `striking` waiting. Release it now.
   *
   * Deliberately keyed on the OPTION, not on a ref: this must re-run the moment
   * the caller flips `revealWhen`, and a ref read would not schedule anything.
   * `pendingReveal` is cleared by both `reset()` and `abort()`, so a hold the
   * user walked away from cannot be resurrected by a late `true`.
   */
  useEffect(() => {
    if (options.revealWhen !== true) return;
    if (!pendingReveal.current) return;
    if (phaseRef.current !== 'striking') return;
    pendingReveal.current = false;
    reveal();
  }, [options.revealWhen, reveal]);

  /** The hold has run its full length. Commit. */
  const fire = useCallback(() => {
    clearTimer(chargeTimer);
    clearTicker();
    if (phaseRef.current !== 'charging') return;
    if (mounted.current) setChargeProgress(1);
    setPhaseSafe('striking');
    // ★ onCharged BEFORE the strike timer, and wrapped. A synchronous throw here
    // used to skip the line below entirely, wedging the coin in `striking` with
    // the height lock held and no path back except a page reload. The write's
    // own failure handling belongs to the caller; our job is to keep the machine
    // alive so it can be reset.
    try {
      optsRef.current.onCharged?.();
    } catch (error) {
      pendingReveal.current = false;
      if (typeof console !== 'undefined') console.error('meritum: onCharged threw', error);
    }
    strikeTimer.current = setTimeout(revealIfAllowed, MERITUM_STRIKE_MS);
  }, [revealIfAllowed, setPhaseSafe]);

  const begin = useCallback(() => {
    if (optsRef.current.disabled) return;
    // Re-entrancy guard. Enter auto-repeats, and a stray pointerdown during the
    // strike must not re-arm anything.
    if (phaseRef.current !== 'idle') return;
    lockHeight();
    setPhaseSafe('charging');
    if (mounted.current) {
      setHoldId((n) => n + 1);
      setChargeProgress(0);
    }
    chargeTimer.current = setTimeout(fire, MERITUM_CHARGE_MS);

    // The motion-free progress cue. Same clock, four static fill levels.
    if (reducedMotionRef.current) {
      let tick = 0;
      stepTicker.current = setInterval(() => {
        tick += 1;
        if (mounted.current) setChargeProgress(Math.min(1, tick / MERITUM_REDUCED_MOTION_STEPS));
        if (tick >= MERITUM_REDUCED_MOTION_STEPS) clearTicker();
      }, MERITUM_CHARGE_MS / MERITUM_REDUCED_MOTION_STEPS);
    }
  }, [fire, lockHeight, setPhaseSafe]);

  const abort = useCallback(() => {
    // ★ A COMMITTED STRIKE IS NOT ABORTABLE. Lifting the finger the instant the
    //   ring closes is the normal way to use this control; treating that as a
    //   cancel is the handoff's height-lock bug.
    if (phaseRef.current !== 'charging') return;
    clearTimer(chargeTimer);
    clearTicker();
    releaseHeight();
    pendingReveal.current = false;
    if (mounted.current) setChargeProgress(0);
    setPhaseSafe('idle');
    optsRef.current.onAbort?.();
  }, [releaseHeight, setPhaseSafe]);

  const reset = useCallback(() => {
    clearTimer(chargeTimer);
    clearTimer(strikeTimer);
    clearTimer(releaseTimer);
    clearTicker();
    pendingReveal.current = false;
    releaseHeight();
    if (mounted.current) setChargeProgress(0);
    setPhaseSafe('idle');
  }, [releaseHeight, setPhaseSafe]);

  /**
   * ★ EVERY TIMER DIES WITH THE COMPONENT. Because all four are cleared here, no
   * queued callback can survive unmount, so there is no path to a setState on a
   * dead component; `mounted` is a second belt on top of that. The height lock
   * is dropped too — it is written straight onto a node this component does not
   * own, and leaving a frozen `min-height` on the caller's card after the coin
   * has gone would be a permanent layout bug with no visible cause.
   */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer(chargeTimer);
      clearTimer(strikeTimer);
      clearTimer(releaseTimer);
      clearTicker();
      const el = optsRef.current.heightLockRef?.current;
      if (el) el.style.minHeight = '';
    };
  }, []);

  /** A control that becomes disabled mid-hold must not keep charging. */
  useEffect(() => {
    if (disabled) abort();
  }, [disabled, abort]);

  /**
   * Stable for the life of the component: every dependency is a `useCallback`
   * with a stable dependency list of its own, so this object's identity never
   * changes and binding it to the coin cannot cause a remount.
   */
  const handlers = useMemo<HoldToStrikeApi['handlers']>(
    () => ({
      onPointerDown: (e) => {
        // Primary button only; a right-click must not arm the strike.
        if (e.button !== 0) return;
        begin();
      },
      onPointerUp: abort,
      onPointerLeave: abort,
      // Fires when the browser takes the gesture over (a scroll, a system
      // gesture). Without it a touch hold can be left charging with no way back.
      onPointerCancel: abort,
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          abort();
          return;
        }
        if (!isHoldKey(e.key)) return;
        // Space would scroll the page and both keys would synthesise a click on
        // a <button>; neither belongs in a hold gesture.
        e.preventDefault();
        if (e.repeat) return;
        begin();
      },
      onKeyUp: (e) => {
        if (!isHoldKey(e.key)) return;
        e.preventDefault();
        abort();
      },
      // Tabbing away mid-hold leaves no key-up to arrive, so without this the
      // hold would run to completion behind the user's back.
      onBlur: abort
    }),
    [begin, abort]
  );

  return { phase, holdId, reducedMotion, chargeProgress, lockedHeight, begin, abort, reset, handlers };
};

export default useHoldToStrike;
