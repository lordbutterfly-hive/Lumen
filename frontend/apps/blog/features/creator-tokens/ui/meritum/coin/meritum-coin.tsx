'use client';

import { FC, useId } from 'react';
import styles from './meritum-coin.module.css';
import { MERITUM_CHARGE_DURATION_STYLE, MeritumCssVars, MeritumStrikePhase } from './timing';
import {
  COIN_BEADS,
  COIN_DENTICLES,
  COIN_DIVIDER_HALF,
  COIN_DIVIDER_Y,
  COIN_EMBERS,
  COIN_FIELD_PX,
  COIN_HAIRLINE_R,
  COIN_LEGEND_PATH,
  MeritumCoinFlowState,
  coinDeviceFontSize,
  coinDeviceName,
  deriveCoinDetail
} from './geometry';

/**
 * THE MERITUM COIN — display only. No interaction, no timers, no state.
 *
 * Three stacked layers of CSS metal (`.edge` reeded band -> `.rim` raised rim ->
 * `.field` sunken face) with one inline SVG stamped into the field. Inline SVG
 * plus CSS gradients means ZERO added network requests, which is a hard rule on
 * these screens.
 *
 * ★ THE COIN EARNS ITS DETAIL. It is not a before/after swap. Which rungs are
 * lit is decided by `deriveCoinDetail` in `geometry.ts` from REAL flow state:
 * the bound handle, the number of offers that actually carry a price, the step
 * reached. A stud lighting for an offer the user has not priced would be a lie
 * in the UI, so there is no per-step lookup table anywhere in this file.
 *
 * ★ EVERY ANIMATION CLASS HERE IS A GLOBAL. `mt-coin-idle`, `mt-coin-tremble`,
 * `mt-impact`, `mt-flash`, `mt-foil`, `mt-shock`, `mt-ember` and `mt-emboss`
 * live in `packages/tailwindcss/globals.css`, outside `@layer` so they survive
 * purge even though they are applied at runtime. The module supplies structure
 * and colour; it owns no keyframes.
 *
 * Wrap this in `<HoldToStrike>` when the coin needs to be strikeable. Render it
 * bare at steps 1 and 2, where it is a picture and not a control.
 */

export interface MeritumCoinProps extends MeritumCoinFlowState {
  /** Where the strike has got to. Drives the oxblood swap and forces full detail. */
  phase?: MeritumStrikePhase;
  /**
   * Exergue text before the strike. USER-FACING COPY — pass a translated
   * string. The default is the handoff's English so the component renders
   * standalone.
   */
  blankLabel?: string;
  /** Shown in place of the handle when nothing is bound yet. Also copy. */
  unboundLabel?: string;
  /** The wordmark round the rim. A brand mark, not translated. */
  legendLabel?: string;
  /**
   * Accessible description of the coin as an image. Pass a translated string.
   * Set to `''` when a parent already labels the coin (as `HoldToStrike` does),
   * which marks the graphic decorative rather than announcing it twice.
   */
  alt?: string;
  className?: string;
}

/** One global class per phase. Never two — they all animate `transform`. */
const MOTION_CLASS: Record<MeritumStrikePhase, string> = {
  idle: 'mt-coin-idle',
  charging: 'mt-coin-tremble',
  striking: 'mt-impact',
  struck: 'mt-coin-idle'
};

const MeritumCoin: FC<MeritumCoinProps> = ({
  handle,
  offersPriced,
  step,
  openingPrice,
  phase = 'idle',
  blankLabel = 'unstruck',
  unboundLabel = '@you',
  legendLabel = 'LUMEN MERITUM',
  alt = 'Your Meritum coin',
  className
}) => {
  /**
   * `useId` gives a per-instance id, so two coins on one page cannot both own
   * `#arc` and steal each other's legend. The colons React puts in it are legal
   * in an id but awkward in a URL fragment, so they come out.
   */
  const arcId = `mt-arc-${useId().replace(/:/g, '')}`;

  const detail = deriveCoinDetail({ handle, offersPriced, step }, phase);
  const name = coinDeviceName(handle, unboundLabel);
  const exergue = detail.struck ? openingPrice || blankLabel : blankLabel;
  const striking = phase === 'striking';

  const wrapClass = [
    styles.wrap,
    detail.reeded ? styles.reeded : '',
    detail.legible ? styles.legible : '',
    detail.struck ? styles.struck : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={wrapClass}>
      {/* The transform layer. Exactly one animation ever lands on it. */}
      <span
        className={`${styles.motion} ${MOTION_CLASS[phase]}`}
        // ★ The tremble must last exactly one charge. Inline beats the class,
        //   so MERITUM_CHARGE_MS is what runs whatever globals.css says.
        style={phase === 'charging' ? MERITUM_CHARGE_DURATION_STYLE : undefined}
      >
        {/* 1. reeded edge band + the thickness of the coin */}
        <span className={styles.edge}>
          {/* 2. raised rim, shaded round the turn */}
          <span className={styles.rim}>
            {/* 3. sunken field, hard inner bevel */}
            <span className={styles.field}>
              <svg
                className={styles.engraving}
                width="100%"
                height="100%"
                viewBox={`0 0 ${COIN_FIELD_PX} ${COIN_FIELD_PX}`}
                role={alt ? 'img' : 'presentation'}
                aria-label={alt || undefined}
                aria-hidden={alt ? undefined : true}
                focusable="false"
              >
                <defs>
                  <path id={arcId} d={COIN_LEGEND_PATH} fill="none" />
                </defs>

                {/* the tooth ring — cut at step 2 */}
                {COIN_DENTICLES.map((d, i) => (
                  <line key={`d${i}`} className={styles.denticle} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} />
                ))}

                <circle className={styles.hairline} cx={COIN_FIELD_PX / 2} cy={COIN_FIELD_PX / 2} r={COIN_HAIRLINE_R} />

                {/* the beaded border — one stud cuts deeper per offer priced */}
                {COIN_BEADS.map((b, i) => {
                  const lit = b.stud >= 0 && b.stud < detail.studsLit;
                  return (
                    <circle
                      key={`b${i}`}
                      className={lit ? `${styles.bead} ${styles.stud}` : styles.bead}
                      cx={b.cx}
                      cy={b.cy}
                      r={lit ? 4.6 : 2.1}
                    />
                  );
                })}

                <text className={`${styles.legend}${detail.struck ? ' mt-emboss' : ''}`}>
                  <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
                    {legendLabel}
                  </textPath>
                </text>

                <line
                  className={styles.divider}
                  x1={COIN_FIELD_PX / 2 - COIN_DIVIDER_HALF}
                  y1={COIN_DIVIDER_Y}
                  x2={COIN_FIELD_PX / 2 + COIN_DIVIDER_HALF}
                  y2={COIN_DIVIDER_Y}
                />
              </svg>

              {/* the device: handle dead centre, exergue under the rule */}
              <span className={styles.device} aria-hidden="true">
                <span className={styles.deviceName} style={{ fontSize: coinDeviceFontSize(name) }}>
                  {name}
                </span>
                <span className={styles.deviceExergue}>{exergue}</span>
              </span>

              {/* strike only: the sheen crossing the face, clipped by the field */}
              {striking ? <span className={`${styles.foil} mt-foil`} /> : null}
              {/* strike only: one frame of white at the moment of contact */}
              {striking ? <span className={`${styles.flash} mt-flash`} /> : null}
            </span>
          </span>
        </span>
      </span>

      {/* strike only: shockwaves off the rim, and embers */}
      {striking ? (
        <span className={styles.overlay} aria-hidden="true">
          <span className={`${styles.shock} mt-shock`} />
          <span className={`${styles.shock} ${styles.shockLate} mt-shock`} />
          {COIN_EMBERS.map((e, i) => {
            /* `--dx` / `--dy` are the names `@keyframes mt-ember` reads;
               `--mt-ember-ms` / `--mt-ember-delay` are the class's own knobs. */
            const emberStyle: MeritumCssVars = {
              '--dx': `${e.dx}px`,
              '--dy': `${e.dy}px`,
              '--mt-ember-size': `${e.size}px`,
              '--mt-ember-delay': `${e.delayMs}ms`,
              '--mt-ember-ms': `${e.durationMs}ms`
            };
            return <span key={`e${i}`} className={`${styles.ember} mt-ember`} style={emberStyle} />;
          })}
        </span>
      ) : null}
    </span>
  );
};

export default MeritumCoin;
