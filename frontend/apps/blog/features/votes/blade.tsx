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

/**
 * `default` = post page (28px glyph / 53x53 target / 18px tally).
 * `sm`      = feed density (22px / 38x38 / 14.5px).
 * `quote`   = the post card's top-comment drawer (18px / 24x24 / 14px), added
 *             2026-08-20 for the card-expansion spec §7. It is DELIBERATELY the
 *             smallest: "The vote is subordinate to the post's. The post's blade
 *             is 22px, the comment's is 18px. With the drawer open the two arrows
 *             sit about 113px apart with the same icon and different meaning,
 *             which is a mis-click risk. The smaller one has to read as belonging
 *             to the quote, not as a peer of the post's vote."
 */
export type VoteSize = 'default' | 'sm' | 'quote';

/**
 * The glyph. `filled` is the cast state; the fill is `currentColor` so the
 * button's own colour rule is the single source of truth for both stroke and
 * fill, and greyscale still separates cast from un-cast by fill alone.
 */
export function Blade() {
  return (
    <svg
      /**
       * ★★★ CENTRED ARTWORK, NOT A CENTRED BOX (2026-08-18, owner: "the upvote
       * blade is not level with everything else on cards").
       *
       * The blade's ink occupies y 3.10-13.90 of a 0-24 box, so its visual
       * centre is 8.50 while the BOX centre is 12.00 — the drawing sits 3.5
       * units, or 4.1px at the 28px render size, ABOVE the middle of the element
       * every neighbour aligns to. Flexbox centred the box perfectly and the
       * blade still floated.
       *
       * The down side had the mirror of the same fault: `.down svg` rotates
       * 180deg about the BOX centre, so its ink landed 3.5 units too LOW.
       *
       * Shifting the viewBox window up by 3.5 moves the artwork down into the
       * true centre, which fixes both directions at once and needs no transform
       * — deliberately, because `.glyph` already owns scale and the svg owns
       * rotation (see vote-control.module.css), and a third transform here
       * would contend with the cast animation.
       */
      viewBox="0 -3.5 24 24"
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
  rollOnMount,
  testId
}: {
  value: number;
  side: 'up' | 'down';
  mine: boolean;
  /**
   * ★★★ THE DOWN-SIDE ROLL WAS STRUCTURALLY UNREACHABLE WITHOUT THIS
   * (2026-08-14 — measured, and it is the reason this prop exists).
   *
   * The roll is gated on `hasEverChanged` below, which is correct for the UP
   * tally: that element is always in the DOM, so a change is always a change
   * on a live element. The DOWN tally is not. The handoff requires it to be
   * ABSENT at zero — "not an empty span, not visibility: hidden" — so the
   * overwhelmingly common way a down tally appears is `absent -> 1`, i.e. a
   * FRESH MOUNT, where `hasEverChanged` is false by construction and the
   * number therefore pops in with no animation at all.
   *
   * Which means the whole down-side half of "the tally rolls from BELOW on the
   * up side and from ABOVE on the down side" was unreachable in the case that
   * matters most: the first downvote on a post. Measured on the new build,
   * driving a real `up -> down` move on a card with no existing down tally:
   * the up tally rolled (`lm-vote-count-up`), the down tally fired NO
   * animation while going absent -> 1. The CSS was right the whole time; the
   * element it was written for never lived long enough to hear about it.
   *
   * The obvious fix — always roll on mount — is the defect this gate was added
   * to fix, pointed at a different element: 11 of the 20 cards on
   * `/@lordbutterfly` carry a down tally, so every one of them would animate on
   * page load, having signalled nothing.
   *
   * So the caller passes the one fact that separates the two: did THIS READER
   * just cast this vote. That is the same fact the commit ring is driven from
   * (`upRing` / `downRing` in votes-component.tsx), which is set only by an
   * observed, reader-initiated transition after mount — never by learning about
   * an existing vote, and never on load.
   */
  rollOnMount?: boolean;
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
      <span
        key={value}
        className={clsx(styles.n, { [styles.rolling]: hasEverChanged.current || !!rollOnMount })}
      >
        {value}
      </span>
    </span>
  );
}

export { styles as voteStyles };
