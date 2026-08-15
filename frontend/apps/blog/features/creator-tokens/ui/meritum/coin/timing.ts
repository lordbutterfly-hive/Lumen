/**
 * MERITUM STRIKE — the timing and ring geometry contract.
 *
 * ★★★ THIS FILE IS THE ONLY PLACE THE HOLD DURATION IS WRITTEN IN JS.
 *
 * The handoff (`coin/strike.js`) records a failure mode that cost real
 * debugging time and that this module exists to make structurally impossible:
 *
 *   "DO NOT fire the strike from the ring's `animationend`. If anything
 *    re-renders the ring subtree mid-hold, the animation restarts from
 *    dashoffset 918 and `animationend` never fires. The hold then silently
 *    never completes."
 *
 * So the hold is driven by an explicit `setTimeout`. That leaves the second
 * half of the problem: a JS timer and a CSS `animation-duration` written in two
 * files WILL drift, and when they do the ring either closes early (the coin
 * strikes with the ring still visibly open) or closes late (the ring shuts and
 * nothing happens for 200ms). Both read as broken.
 *
 * ★ HOW THE DRIFT IS CLOSED HERE. The motion layer lives in
 *   `packages/tailwindcss/globals.css` — `.mt-charge-ring`, `.mt-gather`,
 *   `.mt-coin-tremble`, all written 1100ms — and that file is owned by another
 *   agent, so its keyframes cannot be made to read a custom property. Instead
 *   the three elements that must last exactly one charge carry
 *   `MERITUM_CHARGE_DURATION_STYLE` as an INLINE style. Inline `animation-duration`
 *   outranks the class in the cascade, so the number below is what actually
 *   runs, whatever the stylesheet says. One constant, in one language, and CSS
 *   cannot disagree with it.
 *
 *   (Reduced motion is the one thing that still overrides it, and correctly so:
 *   globals' `animation: none !important` beats any inline longhand. The hold
 *   still completes — it is this timer, not a keyframe.)
 */

import type { CSSProperties } from 'react';

/**
 * How long the user must hold.
 * MUST equal `.mt-charge-ring`'s duration — which it does by construction, see
 * `MERITUM_CHARGE_DURATION_STYLE` below.
 */
export const MERITUM_CHARGE_MS = 1100;

/**
 * The strike window: impact, shockwaves, foil, embers, then the reveal.
 *
 * Not any single animation's duration — the strike is several overlapping
 * sub-animations owned by globals.css. Their budget, longest last:
 *   flash   420ms · impact 1500ms · foil 1400 + 120ms · shock 1600ms
 *   emboss  1100 + 260ms · ember  max 1800 + 480ms = 2280ms
 * Every one finishes inside 2400ms. Shorten this constant and something will be
 * cut off mid-flight; the ember stagger in `geometry.ts` is the tightest.
 */
export const MERITUM_STRIKE_MS = 2400;

/**
 * How long after the reveal the frozen card height is released.
 * The struck panel is shorter than step 3; dropping the lock the instant the
 * panel swaps is exactly the jump the lock exists to prevent.
 */
export const MERITUM_HEIGHT_RELEASE_MS = 900;

/** Radius of the charge ring, in its own viewBox units. */
export const MERITUM_RING_RADIUS = 146;

/** Ring stroke. `stroke-linecap: round` means the cap overhangs by half of it. */
export const MERITUM_RING_STROKE = 3.5;

/**
 * Padding between the ring and the edge of its viewBox: room for the round
 * linecap and the glow bleed. `overflow: visible` on the svg makes this
 * generous rather than load-bearing.
 */
export const MERITUM_RING_PAD = 14;

/** Ring viewBox is square and sized off the radius, never typed twice. */
export const MERITUM_RING_BOX = (MERITUM_RING_RADIUS + MERITUM_RING_PAD) * 2;

/** Ring centre, in viewBox units. */
export const MERITUM_RING_CENTER = MERITUM_RING_BOX / 2;

/**
 * The true circumference, DERIVED — never the literal.
 * `2 x PI x 146 = 917.345...`, rounded up so the sweep is guaranteed to close
 * fully rather than stop a hair short.
 */
export const MERITUM_RING_CIRCUMFERENCE = Math.ceil(2 * Math.PI * MERITUM_RING_RADIUS);

/**
 * ★★★ WHY THE RADIUS CAN CHANGE WITHOUT BREAKING THE SWEEP.
 *
 * `@keyframes mt-charge-ring` in globals.css animates
 * `stroke-dashoffset: 918 -> 0`. 918 is `ceil(2 x PI x 146)`, i.e. it is the
 * circumference of THIS radius baked into a file this component does not own.
 * That is the handoff's magic number and the checklist flags it: "change the
 * radius and you must change this".
 *
 * Rather than mirror the coupling, the ring circle declares
 * `pathLength={MERITUM_RING_DASH_UNITS}`. `pathLength` re-scales every dash
 * calculation on that element into a unit space of your choosing, so
 * "dashoffset 918" means "the whole circle" REGARDLESS of the real geometry.
 * Change `MERITUM_RING_RADIUS` to anything and the sweep still starts fully
 * open and closes exactly on time — the one number that has to stay pinned is
 * this one, and it is pinned to the stylesheet it mirrors, not to the radius.
 *
 * `MERITUM_RING_CIRCUMFERENCE` above is what the two would have to agree on if
 * `pathLength` were unsupported; today they are both 918, which is why the
 * reference worked at all.
 */
export const MERITUM_RING_DASH_UNITS = 918;

/**
 * ★ Under reduced motion the ring does not sweep — globals.css disables
 * `.mt-charge-ring` along with everything else, deliberately, because state on
 * these screens must be readable from colour and fill alone. A hold with no
 * feedback at all is not an acceptable substitute, so the ring is filled in
 * discrete quarters by the JS timer instead: no animation, no transition, just
 * four static fill levels. Four is chosen to read unmistakably as a stepped
 * meter rather than as janky motion.
 */
export const MERITUM_REDUCED_MOTION_STEPS = 4;

/** The four states the strike moves through. Strictly forward, never skipping. */
export type MeritumStrikePhase = 'idle' | 'charging' | 'striking' | 'struck';

/**
 * A style object that may also carry CSS custom properties.
 * `CSSProperties` alone rejects `--foo` keys and the usual workaround is an
 * `as CSSProperties` cast, which this repo's lint discourages
 * (`@typescript-eslint/consistent-type-assertions`). The intersection types it
 * properly instead.
 */
export type MeritumCssVars = CSSProperties & Record<`--${string}`, string | number>;

/**
 * ★ THE BRIDGE. Put this on every element whose animation must last exactly one
 * charge — the ring, the gather glow, the tremble. Inline beats the class, so
 * `MERITUM_CHARGE_MS` is the duration that actually runs.
 */
export const MERITUM_CHARGE_DURATION_STYLE: CSSProperties = {
  animationDuration: `${MERITUM_CHARGE_MS}ms`
};
