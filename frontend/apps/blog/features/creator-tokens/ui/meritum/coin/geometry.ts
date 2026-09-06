/**
 * MERITUM COIN — engraving geometry, and the ladder of detail the coin earns.
 *
 * Pure arithmetic, no React, no DOM. Everything the face draws is generated
 * from a handful of radii so the engraving cannot drift out of register with
 * the metal underneath it. Numbers match the handoff's live component
 * (`reference/LaunchToken.dc.html`, `buildMedal`), which is what produced the
 * reference screenshots.
 *
 * THE THREE STACKED LAYERS (see `coin/coin.html`) are CSS, not SVG:
 *   1. reeded edge band  — 120-groove `repeating-conic-gradient`
 *   2. raised rim        — `conic-gradient`, light at 212deg, dark at 188deg
 *   3. sunken field      — radial face + a hard inner bevel
 * This file only describes what is STAMPED INTO layer 3.
 */

/** Outer diameter of the reeded edge band, in px. */
export const COIN_EDGE_PX = 268;

/** Edge band thickness (the milled reeding you can see from the side). */
export const COIN_EDGE_PAD = 9;

/** Raised rim thickness, inside the edge band. */
export const COIN_RIM_PAD = 10;

/**
 * The flat inner face, derived — the engraving viewBox.
 * 268 - 2*(9 + 10) = 230, which is the field diameter the handoff SVGs use.
 */
export const COIN_FIELD_PX = COIN_EDGE_PX - 2 * (COIN_EDGE_PAD + COIN_RIM_PAD);

/** Centre of the field viewBox. */
const CENTRE = COIN_FIELD_PX / 2;

/** Denticles ("the rim reeding"): a tooth ring just inside the raised rim. */
const DENTICLE_COUNT = 48;
const DENTICLE_INNER_R = 100;
const DENTICLE_OUTER_R = 110;

/** The hairline that closes the legend band. */
export const COIN_HAIRLINE_R = 94;

/** Beaded border. Three of the beads are studs — one per offer priced. */
const BEAD_COUNT = 36;
const BEAD_R = 85;

/**
 * How big a bead is, and how big a STUD is — a bead cut deeper for an offer that
 * carries a price. Exported because two other things now have to agree with
 * them: the component that draws the circles, and the laurel below, whose whole
 * bottom clearance is measured off the stud due south. A stud is more than twice
 * a bead's radius, so a mark placed against `BEAD_R` alone would clear the
 * three-offer coin by 2px less than it thinks it does.
 */
export const COIN_BEAD_R = 2.1;
export const COIN_STUD_R = 4.6;

/** One stud per offer. Three offers, three studs. */
export const MERITUM_STUD_COUNT = 3;

/**
 * Beads sit every 10deg starting due north, so every ninth bead is a cardinal
 * point. Skipping index 0 (north, which the legend crosses) leaves exactly
 * three: east, south, west — lit clockwise as offers 1, 2, 3.
 */
const BEAD_PER_STUD = BEAD_COUNT / (MERITUM_STUD_COUNT + 1);

/** Radius of the arc the legend is set on, and the sweep it occupies. */
const LEGEND_R = 74;
const LEGEND_FROM_DEG = 190;
const LEGEND_TO_DEG = 350;

/** The exergue line, and the two baselines either side of it. */
export const COIN_DIVIDER_HALF = 36;
export const COIN_DIVIDER_Y = CENTRE + 34;

/** Keeps the generated `d`/`x`/`y` strings short and byte-identical every render. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

const px = (r: number, deg: number): { x: number; y: number } => {
  const a = (deg * Math.PI) / 180;
  return { x: round(CENTRE + Math.cos(a) * r), y: round(CENTRE + Math.sin(a) * r) };
};

export interface CoinDenticle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CoinBead {
  cx: number;
  cy: number;
  /** -1 for a plain bead; otherwise the zero-based offer this stud belongs to. */
  stud: number;
}

/** The tooth ring. Cut at step 2, faint before that — never absent, so the
 *  blank coin still reads as a coin rather than a washer. */
export const COIN_DENTICLES: CoinDenticle[] = Array.from({ length: DENTICLE_COUNT }, (_unused, i) => {
  const deg = (i / DENTICLE_COUNT) * 360;
  const inner = px(DENTICLE_INNER_R, deg);
  const outer = px(DENTICLE_OUTER_R, deg);
  return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
});

/** The beaded border, with the three studs flagged. */
export const COIN_BEADS: CoinBead[] = Array.from({ length: BEAD_COUNT }, (_unused, i) => {
  // -90deg so index 0 is due north.
  const { x, y } = px(BEAD_R, (i / BEAD_COUNT) * 360 - 90);
  const cardinal = i % BEAD_PER_STUD === 0 && i !== 0;
  return { cx: x, cy: y, stud: cardinal ? i / BEAD_PER_STUD - 1 : -1 };
});

/** The path `LUMEN MERITUM` is set on: upper field, left to right over the top. */
export const COIN_LEGEND_PATH: string = (() => {
  const from = px(LEGEND_R, LEGEND_FROM_DEG);
  const to = px(LEGEND_R, LEGEND_TO_DEG);
  return `M ${from.x},${from.y} A ${LEGEND_R},${LEGEND_R} 0 0 1 ${to.x},${to.y}`;
})();

/**
 * ★★★ THE WREATH IN THE EXERGUE — placed by arithmetic, not by eye.
 *
 * The owner's laurel (`ui/creator-token-laurel.tsx`, one traced path in a 24-unit
 * box) is stamped into the empty crescent BELOW the exergue rule. That is the
 * only region of the face where a mark of any size can go without touching type:
 * the legend occupies r 74..85 over the top, the device runs the FULL width of
 * the field at 27px (145px wide for a 9-character handle, 179px for the 16
 * character maximum) and the exergue sits on the rule under it. A wreath big
 * enough to encircle the device would have to be ~390px across for its opening
 * alone to clear that name — nearly twice the 230px field — so it would cross
 * every letter. The crescent under the rule is the honest place for it.
 *
 * ★ THE TWO NUMBERS THE SCALE IS DERIVED FROM, so it cannot drift out of
 * register when either edge of that crescent moves:
 *   top    — the exergue rule, plus 4.5 of clearance. The mark's own topmost ink
 *            is its two leaf tips, at x = CENTRE +/- ~8, i.e. directly under the
 *            price, so the rule (and the price sitting on it) is what it has to
 *            clear, not the wider field.
 *   bottom — the beaded border's inner edge measured off the STUD radius, not
 *            the bead radius, less 2.5 of air. The bead due south is the one the
 *            stems come down on, and on the coin that actually gets struck it is
 *            a STUD (all three offers priced), more than twice as deep. Measured
 *            against the plain bead the stems closed to 2.0 on the launch coin;
 *            against the stud they hold 3.8, which is what the rendered exergue
 *            reads as separated rather than resting on it.
 *
 * ★ MEASURED, NOT ASSUMED: the traced path does not fill its 24-unit box. Its
 * ink runs y 1.4300..22.6565 and is centred on x 12.0011, so scaling by
 * `size / 24` would leave the wreath floating high and a hair off-centre. These
 * four numbers come from `getBBox()` on the shipped path; re-measure them if the
 * trace is ever regenerated.
 */
const LAUREL_INK = { cx: 12.0011, top: 1.43, bottom: 22.6565 };
const LAUREL_TOP_Y = COIN_DIVIDER_Y + 4.5;
const LAUREL_BOTTOM_Y = CENTRE + BEAD_R - COIN_STUD_R - 2.5;

/** How far the 24-unit mark is scaled to span that crescent. ~1.974 today. */
export const COIN_LAUREL_SCALE = round((LAUREL_BOTTOM_Y - LAUREL_TOP_Y) / (LAUREL_INK.bottom - LAUREL_INK.top));

/** Ready to drop straight onto `transform`. Rounded, so SSR and the client agree. */
export const COIN_LAUREL_TRANSFORM = `translate(${round(CENTRE - LAUREL_INK.cx * COIN_LAUREL_SCALE)} ${round(
  LAUREL_TOP_Y - LAUREL_INK.top * COIN_LAUREL_SCALE
)}) scale(${COIN_LAUREL_SCALE})`;

/**
 * The darker edge round the leaves, in the MARK's own units, so it lands at a
 * constant 0.65 field units however the scale above comes out. Written here
 * rather than in the stylesheet because it is geometry: `vector-effect:
 * non-scaling-stroke` would have held it steady against the coin's own idle and
 * impact scaling too, which is exactly the wrong thing for a line that is meant
 * to be part of the metal.
 */
export const COIN_LAUREL_EDGE = round(0.65 / COIN_LAUREL_SCALE);

/**
 * ★ ONE LINE, ALWAYS. A Hive account name runs to 16 characters and the device
 * can never be allowed to wrap off the field or spill over the beaded border,
 * so the size is computed from the length rather than fixed. Same curve as the
 * handoff: 240/len, clamped to 19..40px.
 */
export const coinDeviceFontSize = (name: string): number =>
  Math.max(19, Math.min(40, Math.round(240 / Math.max(name.length, 4))));

/** Accepts `hbd-temp` or `@hbd-temp`; always renders as `@hbd-temp`. */
export const coinDeviceName = (handle: string | undefined, fallback: string): string => {
  const trimmed = (handle ?? '').trim().replace(/^@+/, '');
  return trimmed ? `@${trimmed}` : fallback;
};

/** Embers thrown off the rim at impact. */
export interface CoinEmber {
  dx: number;
  dy: number;
  size: number;
  delayMs: number;
  durationMs: number;
}

const EMBER_COUNT = 16;
/** A 148deg fan opening upward, centred on due north. */
const EMBER_FAN_DEG = 148;

/**
 * ★ COMPUTED FROM A FORMULA, NEVER `Math.random()`.
 *
 * This array is rendered inside a Next.js app that server-renders the launch
 * flow. A random scatter would produce different `--mt-ember-dx` values on the
 * server and on the client and hydration would mismatch on sixteen nodes at
 * once. The fan is deterministic, so both halves agree.
 */
export const COIN_EMBERS: CoinEmber[] = Array.from({ length: EMBER_COUNT }, (_unused, i) => {
  const deg = -90 - EMBER_FAN_DEG / 2 + (EMBER_FAN_DEG / (EMBER_COUNT - 1)) * i;
  const a = (deg * Math.PI) / 180;
  const distance = 120 + (i % 4) * 26;
  return {
    dx: round(Math.cos(a) * distance),
    // Lifted, so they drift up and out rather than radiating flat.
    dy: round(Math.sin(a) * distance - 26),
    size: i % 3 ? 3.5 : 5,
    // ★ THE WHOLE FAN MUST LAND INSIDE THE 2400ms STRIKE WINDOW, or the last
    //   embers are still in the air when the coin turns oxblood. Worst case is
    //   i=15: 480ms delay + 1800ms flight = 2280ms. The handoff's own numbers
    //   (1500 + i*58, delay 90 + i*26) run to 2850ms and would have been cut.
    delayMs: 90 + i * 26,
    durationMs: 1200 + i * 40
  };
});

/**
 * ★★★ THE LADDER — what is engraved, and when.
 *
 * The checklist is explicit that this is NOT a single before/after swap:
 * "The coin earns detail as you go: handle engraves at step 1, rim reeding
 * fills at step 2, one stud lights per offer priced."
 *
 * Every rung is driven by real flow state — the bound handle, the count of
 * offers that actually carry a price, the step reached. Nothing here is a
 * hardcoded per-step lookup, because a coin that shows a stud for an offer the
 * user has not priced is a lie in the UI.
 */
export interface MeritumCoinFlowState {
  /** Bound at step 1. Engraves the device. */
  handle?: string;
  /** How many of the three offers carry a price. Clamped to 0..3. */
  offersPriced?: number;
  /**
   * The furthest step the flow has reached (1 | 2 | 3). Pass the high-water
   * mark, not the currently-visible step, or walking back to step 1 un-cuts
   * reeding the user has already earned.
   */
  step?: number;
  /** Formatted opening price, e.g. `$1.00`. Shown in the exergue once struck. */
  openingPrice?: string;
}

export interface MeritumCoinDetail {
  /** Denticles cut, beaded border up. */
  reeded: boolean;
  /** Legend and exergue rule at full weight. */
  legible: boolean;
  /** How many studs are lit. Never more than the user has actually priced. */
  studsLit: number;
  /** The oxblood face. */
  struck: boolean;
}

/**
 * `striking` and `struck` both force the complete face: by the moment of
 * impact the coin must already carry everything it earned, whatever the flow's
 * step counter happens to say.
 */
export const deriveCoinDetail = (
  state: MeritumCoinFlowState,
  phase: 'idle' | 'charging' | 'striking' | 'struck'
): MeritumCoinDetail => {
  const complete = phase === 'striking' || phase === 'struck';
  const step = state.step ?? 1;
  const reeded = complete || step >= 2;
  const priced = Math.max(0, Math.min(MERITUM_STUD_COUNT, Math.floor(state.offersPriced ?? 0)));
  return {
    reeded,
    legible: complete || step >= 3,
    // A stud only lights once the reeding it sits in has been cut.
    studsLit: reeded ? priced : 0,
    struck: phase === 'struck'
  };
};
