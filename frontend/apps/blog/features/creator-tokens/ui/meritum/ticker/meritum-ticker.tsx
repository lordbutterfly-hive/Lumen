'use client';

import clsx from 'clsx';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import styles from './meritum-ticker.module.css';
import {
  MERITUM_TICKER_COPIES,
  MERITUM_TICKER_ITEMS,
  meritumTickerDurationSeconds,
  type MeritumTickerItem
} from './meritum-ticker-items';
import { usePauseAnimationOffscreen } from './use-pause-offscreen';

/**
 * THE MERITUM TICKER — the name crawl that sits directly under the intro
 * headline. No box, no border (see `visuals/01-intro.png`).
 *
 * React port of `handoff_meritum_onboarding/ticker/`. Responsibility is split
 * three ways and this file is the thinnest of them:
 *
 *   - the copy, and the two numbers derived from it → `meritum-ticker-items.ts`
 *   - the geometry, the mask, reduced-motion layout → `meritum-ticker.module.css`
 *   - the motion (`mt-tape`, `mt-dot`) and the colour tokens (`--meritum-*`,
 *     used here as Tailwind utilities) → `packages/tailwindcss/`, owned by the
 *     foundation agent. Nothing in this feature redefines either.
 *
 * ★ EVERY COLOUR IS A `meritum-*` UTILITY, PICKED BY CSS PROPERTY. `#c0392b`
 * exists three times in the palette on purpose — as ink, as a line and as a
 * fill — because those roles need three different dark values. The figures are
 * text, so they take `text-meritum-ink-brand`; the LIVE dot is a fill, so it
 * takes `bg-meritum-surface-brand`. Collapsing the two is how a red label
 * becomes unreadable the day dark mode reaches this screen.
 */

/**
 * `CSSProperties` already types `animationDuration`, so no custom-property
 * escape hatch and no `as` assertion is needed here.
 */
type TapeStyle = Pick<CSSProperties, 'animationDuration'>;

export interface MeritumTickerProps {
  className?: string;
  /**
   * Defaults to the 13 owner-fixed items. Overridable so the tape can be
   * exercised in isolation — but note the constraint in
   * `MERITUM_TICKER_COPIES`: two copies of the list must together be wider
   * than the viewport, or the wrap shows as a gap. A three-item tape breaks.
   */
  items?: readonly MeritumTickerItem[];
  /** The LIVE badge on the left. */
  showLive?: boolean;
  /**
   * ★ PASS A TRANSLATED STRING. This is the one piece of user-facing text in
   * the component that is chrome rather than owner-fixed copy, so it must not
   * be hardcoded English at the call site either — the page should pass
   * a translated string. The default exists only so the tape renders standalone.
   */
  liveLabel?: string;
  /**
   * Labels for the pause control. USER-FACING COPY — pass translated strings.
   * The control is required by WCAG 2.2.2 (Pause, Stop, Hide): the tape moves
   * automatically for 58s on a loop, well past the 5s threshold, and
   * `prefers-reduced-motion` satisfies a DIFFERENT criterion — it is an OS
   * setting, not something the reader can operate on the page.
   */
  /**
   * Retained on the type, unused since the pause control was removed
   * (2026-08-16, owner). Kept so restoring that button is a JSX change rather
   * than a signature change. See the WCAG note at the live badge.
   */
  pauseLabel?: string;
  resumeLabel?: string;
}

/** Rendered once per item, purely decorative — the text beside it carries the meaning. */
const ITEM_GLYPH = '◈';

/**
 * Read aloud and copied, never seen. Ends each item so the tape linearises as
 * sentences instead of one fused string. A full stop plus a space, because a
 * space alone still lets some screen readers run the words together.
 */
const ITEM_SEPARATOR = '. ';

export function MeritumTicker({
  className,
  items = MERITUM_TICKER_ITEMS,
  showLive = true,
  liveLabel = 'Live'
}: MeritumTickerProps) {
  /**
   * The ref goes on the TRACK, not the window: the track is the element
   * carrying `.mt-tape`, and `animationPlayState` only means anything on the
   * animated element itself.
   */
  // Only the VALUE is read now that the pause button is gone (see the note in the
  // live badge below). Restoring the control means re-adding the setter here and
  // the <button> there; the `.paused` styling it drives is still wired.
  const [userPaused] = useState(false);
  const trackRef = usePauseAnimationOffscreen<HTMLDivElement>(true, userPaused);

  /**
   * ★ THE SPEED IS DERIVED FROM THE ITEM COUNT, NOT INHERITED FROM `.mt-tape`.
   * The shared class says 58s, which is right for 13 items and wrong for any
   * other number; an inline longhand beats the class's shorthand, so the tape
   * holds its visual speed if the list ever changes length. Reduced motion
   * still wins over this — `globals.css` kills `.mt-tape` with `animation: none
   * !important`, and an `!important` shorthand outranks a non-important inline
   * longhand. Read the long note on `meritumTickerDurationSeconds`.
   */
  const tapeStyle: TapeStyle = {
    animationDuration: `${meritumTickerDurationSeconds(items.length)}s`
  };

  return (
    <div className={clsx(styles.ticker, className)}>
      {showLive ? (
        <div className={styles.live}>
          <span className={clsx(styles.dot, 'mt-dot bg-meritum-surface-brand')} aria-hidden="true" />
          <span className="font-sans text-12 font-bold uppercase tracking-meritum-eyebrow text-meritum-ink-brand">
            {liveLabel}
          </span>
          {/*
            ★ THE PAUSE CONTROL IS REMOVED (2026-08-16, owner's direct call).
            ★★★ THIS IS A KNOWN WCAG 2.2.2 (Pause, Stop, Hide) LEVEL A REGRESSION,
            recorded here rather than quietly dropped.
            It was added by the 2026-08-15 accessibility pass for exactly this
            reason: content that moves automatically and runs longer than 5s must
            offer the reader a mechanism to stop it, and this tape runs ~58s. The
            offscreen IntersectionObserver is a performance optimisation and
            `prefers-reduced-motion` is an OS-level preference, so neither one
            satisfies the criterion for a reader who has not set it.
            The `userPaused` state and the `.paused` styling are deliberately
            KEPT below, so restoring the button is re-adding this element only.
          */}
        </div>
      ) : null}

      {/* `paused` turns the tape into a scrollable strip so the frame it stops
          on is readable rather than clipped by the edge mask — see the note in
          the stylesheet. */}
      <div className={clsx(styles.window, userPaused && styles.paused)}>
        {/* `mt-tape` is the shared keyframe class from packages/tailwindcss/globals.css.
            It sits outside @layer there, so the JIT cannot purge it, and it is already
            listed in that file's prefers-reduced-motion block. */}
        <div ref={trackRef} className={clsx(styles.track, 'mt-tape')} style={tapeStyle}>
          {Array.from({ length: MERITUM_TICKER_COPIES }, (_unused, copyIndex) => (
            <div
              key={copyIndex}
              className={clsx(styles.copy, copyIndex > 0 && styles.copyDuplicate)}
              /**
               * Only the first copy is real content. The others exist so the
               * loop can wrap invisibly, and announcing the same 13 lines twice
               * to a screen reader would be a bug, not social proof.
               */
              aria-hidden={copyIndex > 0 || undefined}
            >
              {items.map((item, itemIndex) => (
                /**
                 * ★ THESE SPANS MUST NOT BE SEPARATED BY A JSX TEXT NODE. The
                 * spacing between the parts lives INSIDE the strings, and each
                 * span is a flex item, so an added literal space between two
                 * tags would render as a second, doubled gap. The formatting
                 * below is safe because JSX discards whitespace runs that
                 * contain a newline; writing them on one line separated by a
                 * space would not be.
                 *
                 * ★ PLAIN SPANS, NOT THE HANDOFF'S `b`/`i`/`em`. The handoff
                 * marks the sentence with `<i>` and then sets `font-style:
                 * normal` on it, and marks the figure with `<em>` — neither is
                 * an alternate voice and neither is emphasis, so both are false
                 * semantics that some screen readers will announce. The
                 * utilities carry the roles instead. The picture is identical.
                 *
                 * The key pairs the handle with its index: handles happen to be
                 * unique today, but the index alone would be unstable if the
                 * list were ever reordered, and this list is never filtered.
                 */
                <span className={clsx(styles.item, 'font-sans text-18')} key={`${item.handle}-${itemIndex}`}>
                  <span className={clsx(styles.glyph, 'text-meritum-ink-faint')} aria-hidden="true">
                    {ITEM_GLYPH}
                  </span>
                  <span className="font-bold text-meritum-ink">{item.handle}</span>
                  <span className="font-medium text-meritum-ink-muted">{item.sentence}</span>
                  {/* ★ The figure sits HERE, mid-sentence, because that is where it was
                      written. Item 4 ("has 12 holders on day one") and item 7 ("launched
                      in 5 seconds flat") are ungrammatical if it is moved to the end. */}
                  <span className="font-bold tabular-nums text-meritum-ink-brand">{item.figure}</span>
                  {item.trailing ? (
                    <span className="font-medium text-meritum-ink-muted">{item.trailing}</span>
                  ) : null}
                  {/*
                    ★ A REAL CHARACTER BETWEEN ITEMS. The visual gap is
                    `.item`'s padding and the "◈" is aria-hidden, so without
                    this there is nothing separating one item's last word from
                    the next item's handle — a screen reader and a copy/paste
                    both produce "4 seconds ago@biggusdickus". Hidden visually,
                    present in the accessibility tree and the clipboard.
                  */}
                  <span className={styles.srOnly}>{ITEM_SEPARATOR}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
