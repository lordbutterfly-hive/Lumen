'use client';

import { MutableRefObject, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { haptic } from '@/blog/lib/haptics';
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
    /* These three take the event so the release can be matched to the pointer
       that armed the hold — see `holdPointer` below. */
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    onKeyUp: (e: React.KeyboardEvent<HTMLElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLElement>) => void;
  };
}

/** Enter and Space both hold. Older engines still report Space as 'Spacebar'. */
const isHoldKey = (key: string): boolean => key === 'Enter' || key === ' ' || key === 'Spacebar';

/**
 * ★ THE HOLD GROUP (2026-09-04). The coin and the launch button both drive this
 * ONE machine but sit in different subtrees, so press-and-holding one moves
 * focus off the other and fires that other control's `blur`. Left unguarded,
 * the losing control's blur aborts the hold the winning control JUST started —
 * a dead first attempt with no feedback (QA #1). Both controls carry this
 * marker; a blur whose focus lands on any marked control is focus moving WITHIN
 * the group, not away from it, so it must not abort. Only a blur that leaves the
 * group aborts — the keyboard tab-away backstop `onBlur` exists for. Same
 * relatedTarget rule the post-card drawer uses for sibling controls.
 */
const HOLD_CONTROL_ATTR = 'data-meritum-hold-control';
/** Spread onto every element that drives the strike machine. */
export const HOLD_CONTROL_MARKER: Record<string, string> = { [HOLD_CONTROL_ATTR]: '' };

/**
 * ★ Which pointers are PHYSICALLY pressed on a hold control right now? This is
 * the signal that separates the two blurs that both land on a twin hold control:
 *   · pressing the coin/button focuses it and BLURS the other — that blur fires
 *     WHILE a pointer is down, and must NOT abort the hold just started (QA #1);
 *   · tabbing away from a keyboard hold onto the twin fires with NO pointer down,
 *     and MUST abort — the strike is a real fund action and must never complete
 *     behind the user's back (the backstop `onBlur` exists for).
 *
 * ★★ THE CLEAR COMES FROM THE WINDOW, NOT THE CONTROL (Fable review 2026-09-04,
 * F1). On a SUCCESSFUL strike the pointer is still physically down at the 1100ms
 * commit — the user cannot have released, or there'd be no strike — and the
 * launch flow unmounts the HoldAction at that instant (meritum-launch-flow.tsx's
 * `landing` swaps LaunchStepTerms out). So the control's own pointerup never
 * runs; a control-scoped clear would leak the pressed state forever, and since
 * this is module scope, for the whole session — silently degrading the
 * keyboard-abort backstop on a money write into a tab-order accident. A
 * capture-phase window listener sees every pointerup/cancel regardless of
 * target, unmount, hit-test or disabled state. Keyed by pointerId so two fingers
 * on the two controls never clear each other (F2). Armed lazily on the first
 * press, so it never touches `window` during SSR (this is a 'use client' module
 * but its top level still runs on the server).
 *
 * A plain module Set, not React state: it is read synchronously inside the blur
 * the same gesture's pointerdown just caused, and never rendered.
 */
const activeHoldPointers = new Set<number>();
let holdPointerWindowArmed = false;
const forgetHoldPointer = (e: PointerEvent): void => {
  activeHoldPointers.delete(e.pointerId);
};
const armHoldPointerWindow = (): void => {
  if (holdPointerWindowArmed || typeof window === 'undefined') return;
  window.addEventListener('pointerup', forgetHoldPointer, true);
  window.addEventListener('pointercancel', forgetHoldPointer, true);
  holdPointerWindowArmed = true;
};
/** A hold control's pointerdown. Pass the pointerId that armed it. */
export const noteHoldPointerDown = (pointerId: number): void => {
  armHoldPointerWindow();
  activeHoldPointers.add(pointerId);
};
/**
 * A hold control's own up/leave/cancel. A BELT on top of the window listener
 * (Fable R1, 2026-09-04): a MOUSE released OUTSIDE the browser window delivers no
 * pointerup to the page, so the window clear alone can leave a stale id. But
 * leaving the window means the pointer first left the control, firing its
 * pointerleave — so clearing here on leave closes that gap. Safe for twin-blur
 * suppression: the guard is read only during the pointerdown→blur sequence, which
 * precedes any leave. The window listener still OWNS the unmount path (F1), where
 * no control up/leave ever fires.
 */
export const noteHoldPointerUp = (pointerId: number): void => {
  activeHoldPointers.delete(pointerId);
};
/** Belt-and-braces clear-all, for the machine's unmount cleanup. */
export const resetHoldPointers = (): void => {
  activeHoldPointers.clear();
};
/**
 * True when a blur is focus moving to the twin hold control WHILE a pointer is
 * physically pressed on a hold control — the only case where a blur must not
 * abort. A keyboard tab-away has no pressed pointer, so it still aborts even when
 * it lands on a hold control.
 */
export const focusStaysInHoldGroup = (relatedTarget: EventTarget | null): boolean =>
  activeHoldPointers.size > 0 && relatedTarget instanceof Element && relatedTarget.closest(`[${HOLD_CONTROL_ATTR}]`) !== null;

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
    // Heavier, and it ends heavy: a creator token mints once, bound to one account,
    // forever. The last thing the hand feels is the longest pulse.
    haptic('strike');
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

  /**
   * The pointer that armed the current hold, or null when no pointer owns it
   * (idle, or a keyboard hold). Compared on every release — see the handlers.
   */
  const holdPointer = useRef<number | null>(null);

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

  /**
   * Release from a pointer gesture. Only the pointer that armed the hold can
   * end it; every other pointer's up/leave/cancel is ignored. The id is cleared
   * on a match so a duplicate event for the same pointer cannot abort a strike
   * that has since committed.
   */
  const releaseFor = useCallback(
    (pointerId: number) => {
      if (holdPointer.current !== pointerId) return;
      holdPointer.current = null;
      abort();
    },
    [abort]
  );

  const reset = useCallback(() => {
    holdPointer.current = null;
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
      // Belt-and-braces on the window clear: if the machine unmounts mid-press,
      // drop any pressed-pointer state so the twin-blur guard can't read stale.
      resetHoldPointers();
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
        noteHoldPointerDown(e.pointerId);
        holdPointer.current = e.pointerId;
        begin();
      },
      /*
       * ★ THE RELEASE MUST COME FROM THE POINTER THAT ARMED THE HOLD.
       *
       * `onPointerDown` filtered on `e.button !== 0`, but the three release
       * handlers took no event at all and aborted on ANY pointer. The gap is
       * not theoretical and it is asymmetric by construction:
       *
       *   · mouse — press and hold with the left button, then press and release
       *     the RIGHT button without moving. `pointerdown` was ignored (button
       *     1), `pointerup` was not, so the right-click cancels a strike the
       *     reader is still deliberately holding.
       *   · touch — hold with one finger, rest or lift a second anywhere on the
       *     coin. The second finger's `pointerup` kills the first one's charge.
       *
       * A strict `pointerId` match fixes both, and deliberately does NOT fall
       * back to "abort if we have no id": during a KEYBOARD hold `holdPointer`
       * is null, and a stray pointerup landing on the coin should not cancel a
       * hold the keyboard owns — `onKeyUp` is that gesture's release.
       *
       * `pointercancel` is still honoured for the matching pointer only; the
       * browser taking over the gesture (a scroll, a system gesture) is exactly
       * the case where a touch hold would otherwise charge with no way back.
       */
      // The pressed-pointer Set is cleared by the window listener for the
      // unmount path (see armHoldPointerWindow); these are the belt that also
      // clears when a mouse is released outside the window (Fable R1) — a leave
      // necessarily precedes leaving the window. They also release the hold.
      onPointerUp: (e) => {
        noteHoldPointerUp(e.pointerId);
        releaseFor(e.pointerId);
      },
      onPointerLeave: (e) => {
        noteHoldPointerUp(e.pointerId);
        releaseFor(e.pointerId);
      },
      onPointerCancel: (e) => {
        noteHoldPointerUp(e.pointerId);
        releaseFor(e.pointerId);
      },
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
      // hold would run to completion behind the user's back. But focus moving to
      // the TWIN hold control (coin <-> button) is not tabbing away — it is the
      // start of a hold on the other control — so that blur must not abort.
      onBlur: (e) => {
        if (focusStaysInHoldGroup(e.relatedTarget)) return;
        abort();
      }
    }),
    [begin, abort, releaseFor]
  );

  return { phase, holdId, reducedMotion, chargeProgress, lockedHeight, begin, abort, reset, handlers };
};

export default useHoldToStrike;
