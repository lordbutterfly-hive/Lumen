'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import styles from './vote-control.module.css';

/**
 * The Blade mark and the split tallies from the owner's vote-control handoff.
 *
 * Presentational only — every decision about WHICH control renders (signed in,
 * tier known, percentage picker vs one-shot, already voted) stays in
 * `votes-component.tsx`, which is where that logic already lives and is already
 * tested.
 */

/**
 * ★ ONE PATH, ROTATED — NEVER A SECOND PATH. The handoff is explicit that the
 * downvote is this exact path turned 180° about its centre, so the pair cannot
 * drift out of agreement when one of them is edited. The rotation is applied in
 * CSS (`.down svg`), not by a second `d` string.
 */
const BLADE_PATH =
  'M12 3.1c3 3.8 5.4 7.4 7.2 10.8-2.3-1.4-4.7-2.1-7.2-2.1s-4.9.7-7.2 2.1C6.6 10.5 9 6.9 12 3.1z';

export type VoteSize = 'default' | 'sm';

/**
 * The glyph. `filled` is the cast state; the fill is `currentColor` so the
 * button's own colour rule is the single source of truth for both stroke and
 * fill, and greyscale still separates cast from un-cast by fill alone.
 */
export function Blade() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={BLADE_PATH} />
    </svg>
  );
}

/**
 * Wraps the glyph so the cast "pop" (a scale) and the down side's rotation never
 * contend for the same `transform`. See the long note in vote-control.module.css.
 */
export function BladeGlyph() {
  return (
    <span className={styles.glyph}>
      <Blade />
    </span>
  );
}

/**
 * The commit ring. Self-unmounting on `animationend` — the handoff asks for it to
 * be added on the click that casts and removed when it finishes, and doing that
 * from the element's own event keeps it off any timer that could outlive the
 * component.
 *
 * `key` on the caller's side restarts it for a second cast.
 */
export function CommitRing({ onDone }: { onDone: () => void }) {
  return <span className={styles.ring} onAnimationEnd={onDone} />;
}

/**
 * `true` for as long as one cast animation should be showing. Returns to false
 * by itself, so a component can render the ring without owning a timer.
 */
export function useCommitRing(): [boolean, () => void, () => void] {
  const [on, setOn] = useState(false);
  // A cast that never fires `animationend` (element unmounted mid-flight, or a
  // browser that skips the animation entirely under reduced motion) must not
  // leave the ring latched on forever.
  useEffect(() => {
    if (!on) return;
    const id = setTimeout(() => setOn(false), 1200);
    return () => clearTimeout(id);
  }, [on]);
  return [on, () => setOn(true), () => setOn(false)];
}

/**
 * A tally. `mine` only ever changes the UP tally's colour — the down tally is
 * slate whether or not I cast it, because the design records disagreement
 * rather than celebrating it.
 *
 * ★ The live region is on the TALLY, not on the button (handoff, Accessibility).
 * A screen reader announces the number that changed, rather than re-reading the
 * control the user just operated.
 */
export function VoteTally({
  value,
  side,
  mine,
  testId
}: {
  value: number;
  side: 'up' | 'down';
  mine: boolean;
  testId?: string;
}) {
  /**
   * ★★★ THE ROLL MUST NOT PLAY ON MOUNT (2026-08-14 — measured, then fixed).
   *
   * The roll was originally just `.n { animation: … }`, which CSS runs the
   * moment the element enters the document. On a 30-card feed that is 30
   * tally animations firing during page load: measured on :4000 with a
   * `PerformanceObserver` on `animationstart` — 30 × `lm-vote-count-up` all
   * firing together at t=1411ms, none of them signalling anything, because no
   * number had changed. The owner's constraint on this work was "there is a
   * cool animation … make sure that doesn't fuck up loading", and an animation
   * that fires 30 times on load for no reason is the thing that constraint is
   * about. (It cost no long task — it is transform/opacity — but it is still
   * motion the reader did not cause.)
   *
   * So the roll is opt-in per instance, and only after this tally has actually
   * moved at least once. A ref, updated during render rather than in an effect,
   * because an effect lands AFTER paint — the keyed span would already have
   * mounted without the class and the first real change would not animate.
   */
  const lastValue = useRef(value);
  const hasEverChanged = useRef(false);
  if (lastValue.current !== value) {
    lastValue.current = value;
    hasEverChanged.current = true;
  }

  return (
    <span
      className={clsx(styles.tally, side === 'up' ? styles.tallyUp : styles.tallyDown, {
        [styles.mine]: mine && side === 'up'
      })}
      data-testid={testId}
      aria-live="polite"
    >
      {/* Keyed on the value so the roll replays only when the number actually
          changes, not on every unrelated re-render of the card. */}
      <span key={value} className={clsx(styles.n, { [styles.rolling]: hasEverChanged.current })}>
        {value}
      </span>
    </span>
  );
}

export { styles as voteStyles };
