'use client';

import { ForwardRefRenderFunction, forwardRef, useImperativeHandle } from 'react';
import MeritumCoin, { MeritumCoinProps } from './meritum-coin';
import styles from './meritum-coin.module.css';
import { HoldToStrikeApi, UseHoldToStrikeOptions, useHoldToStrike } from './use-hold-to-strike';
import {
  MERITUM_CHARGE_DURATION_STYLE,
  MERITUM_RING_BOX,
  MERITUM_RING_CENTER,
  MERITUM_RING_DASH_UNITS,
  MERITUM_RING_RADIUS,
  MERITUM_RING_STROKE,
  MeritumStrikePhase
} from './timing';

/**
 * HOLD TO STRIKE — the coin, made strikeable.
 *
 * A press target wrapped round `<MeritumCoin>`, with the charge overlay (the
 * gather glow and the progress ring) as a SIBLING of the coin rather than a
 * descendant, so it can be re-keyed per hold without disturbing the coin's own
 * subtree. All timing and every guard lives in `useHoldToStrike`; this file is
 * markup.
 *
 * ★ WHAT THE LAUNCH FLOW HAS TO WIRE
 *   - `heightLockRef` -> the launch CARD. Without it nothing is frozen and the
 *     page collapses when the struck panel (shorter than step 3) swaps in.
 *   - `onCharged`     -> the real launch write. Fires at 1100ms with 2400ms of
 *     animation still to run, so the network has the whole strike to land.
 *   - `onStruck`      -> the reveal. The coin is oxblood; show the struck panel.
 *   - `ref.reset()`   -> call this if the write fails. The coin must not sit
 *     there struck describing a market that does not exist.
 *
 * Keyboard: the coin is a real `<button>`, so it is tabbable, and Enter or
 * Space holds it exactly as a pointer does. Releasing the key, Escape, or
 * tabbing away all abort cleanly. See `useHoldToStrike` for why each of those
 * is bound.
 */

export interface HoldToStrikeHandle {
  phase: MeritumStrikePhase;
  begin: () => void;
  abort: () => void;
  reset: () => void;
}

export interface HoldToStrikeProps extends Omit<MeritumCoinProps, 'phase' | 'alt'>, UseHoldToStrikeOptions {
  /** Accessible name for the press target. USER-FACING COPY — pass a translated string. */
  holdLabel?: string;
  /**
   * What the live region announces at each phase. USER-FACING COPY. Defaults
   * are the handoff's English so the component works standalone.
   */
  statusLabels?: Partial<Record<MeritumStrikePhase, string>>;
}

const DEFAULT_STATUS: Record<MeritumStrikePhase, string> = {
  idle: '',
  charging: 'Holding. Let go before the ring closes and nothing happens.',
  striking: 'Striking. Hold still.',
  struck: 'Struck. Your token is live.'
};

const HoldToStrikeInner: ForwardRefRenderFunction<HoldToStrikeHandle, HoldToStrikeProps> = (
  {
    onCharged,
    onStruck,
    onAbort,
    disabled = false,
    heightLockRef,
    holdLabel = 'Hold to strike your token',
    statusLabels,
    ...coinProps
  },
  ref
) => {
  const strike = useHoldToStrike({ onCharged, onStruck, onAbort, disabled, heightLockRef });
  const { phase, holdId, reducedMotion, chargeProgress, handlers } = strike;

  useImperativeHandle(
    ref,
    (): HoldToStrikeHandle => ({
      phase,
      begin: strike.begin,
      abort: strike.abort,
      reset: strike.reset
    }),
    [phase, strike.begin, strike.abort, strike.reset]
  );

  const status = statusLabels?.[phase] ?? DEFAULT_STATUS[phase];

  /**
   * ★ THE OVERLAY OUTLASTS THE HOLD UNDER REDUCED MOTION, AND ONLY THEN.
   *
   * Normally it is unmounted at impact, as in the reference — the strike has
   * its own flash, shockwaves and embers to carry it. With motion disabled the
   * strike has NONE of those, so unmounting here would leave a reduced-motion
   * reader looking at 2.4 seconds of a completely inert coin between the ring
   * closing and the metal turning over. Keeping the wash up with the ring
   * closed is the still-frame version of the same information: charged, and
   * working. It clears at the reveal, when the oxblood takes over as the cue.
   */
  const showOverlay = phase === 'charging' || (reducedMotion && phase === 'striking');

  return (
    <span className={styles.holdRoot}>
      {showOverlay ? (
        /* ★ KEYED ON `holdId`. React then keeps ONE node for the whole hold, so
           a parent re-render mid-charge cannot restart the sweep — and a fresh
           hold gets a genuinely fresh animation rather than a resumed one. The
           strike does not depend on this (it is on a timer), but a ring that
           visibly jumps back to full is its own bug. */
        <span className={styles.overlay} key={holdId} aria-hidden="true">
          <span className={`${styles.glow} mt-gather`} style={MERITUM_CHARGE_DURATION_STYLE} />
          <svg
            className={styles.ring}
            width={MERITUM_RING_BOX}
            height={MERITUM_RING_BOX}
            viewBox={`0 0 ${MERITUM_RING_BOX} ${MERITUM_RING_BOX}`}
            focusable="false"
          >
            <circle
              className={styles.ringTrack}
              cx={MERITUM_RING_CENTER}
              cy={MERITUM_RING_CENTER}
              r={MERITUM_RING_RADIUS}
              strokeWidth={MERITUM_RING_STROKE}
            />
            {/*
              `pathLength` normalises this circle's dash arithmetic into the
              same unit space `@keyframes mt-charge-ring` animates in, so the
              sweep stays correct if the radius ever changes. See `timing.ts`.

              Two ways to fill it, one clock:
                - normally, the CSS sweep, with its duration pinned inline to
                  MERITUM_CHARGE_MS so it cannot drift from the timer;
                - under reduced motion, four static fill levels written straight
                  onto stroke-dashoffset by that same timer. No animation, no
                  transition, but the reader can still see how far in they are.
            */}
            <circle
              className={reducedMotion ? styles.ringSweep : `${styles.ringSweep} mt-charge-ring`}
              cx={MERITUM_RING_CENTER}
              cy={MERITUM_RING_CENTER}
              r={MERITUM_RING_RADIUS}
              strokeWidth={MERITUM_RING_STROKE}
              pathLength={MERITUM_RING_DASH_UNITS}
              strokeDasharray={MERITUM_RING_DASH_UNITS}
              strokeDashoffset={MERITUM_RING_DASH_UNITS}
              style={
                reducedMotion
                  ? { strokeDashoffset: MERITUM_RING_DASH_UNITS * (1 - chargeProgress) }
                  : MERITUM_CHARGE_DURATION_STYLE
              }
            />
          </svg>
        </span>
      ) : null}

      <button
        type="button"
        className={styles.coin}
        aria-label={holdLabel}
        disabled={disabled}
        onPointerDown={handlers.onPointerDown}
        onPointerUp={handlers.onPointerUp}
        onPointerLeave={handlers.onPointerLeave}
        onPointerCancel={handlers.onPointerCancel}
        onKeyDown={handlers.onKeyDown}
        onKeyUp={handlers.onKeyUp}
        onBlur={handlers.onBlur}
      >
        {/* `alt=""` because the button already carries the accessible name;
            announcing the coin as an image too would say it twice. */}
        <MeritumCoin {...coinProps} phase={phase} alt="" />
      </button>

      {/* State is never carried by motion alone: the coin's own colour and fill
          say it visually, and this says it to a screen reader. */}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {status}
      </span>
    </span>
  );
};

const HoldToStrike = forwardRef(HoldToStrikeInner);
HoldToStrike.displayName = 'HoldToStrike';

export default HoldToStrike;
export type { HoldToStrikeApi };
