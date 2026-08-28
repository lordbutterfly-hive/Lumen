/**
 * THE PRICE CHART'S GEOMETRY, as a pure function.
 *
 * ★ WHY IT IS OUT HERE. `price-chart.tsx` is a `'use client'` component, and a
 * path computed inside it is a path no test can read. Same reason
 * `disclosure-copy.ts` and `sell-empty-state.ts` exist, and the same shape
 * `ui/meritum/coin/geometry.ts` already uses for its own drawing maths. The
 * component now renders what this returns and computes nothing of its own, so
 * the two cannot drift.
 *
 * ★★★ THE ALL-ZERO SERIES DIVIDED BY ZERO AND DREW NOTHING, SILENTLY
 * (2026-08-27, replicated offline against the exact previous expressions).
 *
 * The old body was:
 *
 *     const min = Math.min(...points) * 0.98;
 *     const max = Math.max(...points) * 1.02;
 *     const y = (v) => h - ((v - min) / (max - min)) * h;
 *
 * The 0.98/1.02 padding rescues the flat case for any NON-ZERO value: a flat
 * 1.4 series gives min 1.372 and max 1.428, and every point lands at y=95, a
 * centred flat line, which is correct. An ALL-ZERO series gives min 0 and max
 * 0, so `(v - min) / (max - min)` is 0/0 = NaN, and the path came out
 * `M0,NaN L190,NaN L380,NaN`. No exception, no error boundary: an invisible
 * line and a `<circle cy="NaN">` on a page that otherwise looked fine.
 *
 * ★ AND IT IS REACHABLE, NOT THEORETICAL. Price is a pure function of supply
 * through the curve, and the spot rate at supply 0 is 0 BY DESIGN (curve.go
 * records no observation for an empty market; the same zero produced the
 * "Price after your buy: ~$0.00" bug fixed 2026-08-21, documented in
 * `market/curve.ts`'s zero branch). A `lumen_ct_price_history` row stores
 * `supply_after`, and a sell that empties a market writes `supply_after = 0`.
 * A market whose recorded points are all at supply 0 is a market this chart
 * rendered blank.
 *
 * ★ THE FIX GUARDS THE SPAN, NOT THE ZERO. `span > 0` covers every degenerate
 * case at once (all-zero, all-equal, and any future arithmetic that collapses
 * the range) and maps every point to the vertical middle, which is exactly what
 * the non-zero flat case already produced correctly. It deliberately does NOT
 * fall back to the "no price history" placeholder: a real series of real points
 * is not an absence of history, and saying so would be a different lie.
 */

/** The drawing box. Exported so the component and the test agree on one pair of numbers. */
export const CHART_WIDTH = 380;
export const CHART_HEIGHT = 190;

export interface ChartGeometry {
  /** The `d` of the line path, oldest point at x=0. */
  line: string;
  /** The same path closed to the baseline, for the tint underneath. */
  area: string;
  /** Where the end marker sits. */
  lastX: number;
  lastY: number;
  /** Last point at or above the first. Drives the single up/down colour choice. */
  up: boolean;
  /**
   * TRUE only for the DEGENERATE case: the padded span collapsed to zero, which
   * is the all-zero series, and every point is placed on the vertical middle by
   * the guard rather than by the arithmetic.
   *
   * ★ It is FALSE for a flat NON-zero series, and that is not a wart. A flat 1.4
   * series pads to min 1.372 / max 1.428, a real span of 0.056, and every point
   * lands at 95 through ordinary division. The two look identical and are
   * arithmetically different, and only one of them was ever broken.
   */
  flat: boolean;
}

/**
 * Can these points be drawn at all?
 *
 * Two points is the floor, and it is the SAME floor `live/adapt.ts` puts on the
 * chart data itself: one point drawn as a line claims a price held steady when
 * only one moment is known. A non-finite point cannot be positioned, and a
 * series carrying one is not partially drawable — `Math.min` of any array
 * containing NaN is NaN, so a single bad value poisons the whole range.
 */
export function isDrawableSeries(points: readonly number[] | null | undefined): points is readonly number[] {
  return Array.isArray(points) && points.length >= 2 && points.every((p) => Number.isFinite(p));
}

/**
 * Points -> the SVG geometry, or null when the series cannot be drawn.
 *
 * Null rather than an empty path: an empty `d` is a silent no-op that renders as
 * a blank box, which is how the all-zero series failed in the first place. A
 * null forces the caller to choose what absence looks like.
 */
export function chartGeometry(
  points: readonly number[] | null | undefined,
  w: number = CHART_WIDTH,
  h: number = CHART_HEIGHT
): ChartGeometry | null {
  if (!isDrawableSeries(points)) return null;

  // The 0.98/1.02 padding is unchanged: it keeps the line off the top and
  // bottom edges, and it is what makes a flat non-zero series centre itself.
  const min = Math.min(...points) * 0.98;
  const max = Math.max(...points) * 1.02;
  const span = max - min;
  // ★ THE GUARD. `span > 0` is false for 0, for a negative span and for NaN, so
  // one condition covers every way the range can collapse.
  const y = (v: number): number => (span > 0 ? h - ((v - min) / span) * h : h / 2);

  const x = (i: number): number => (i / (points.length - 1)) * w;
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const last = points[points.length - 1];
  return {
    line,
    area: `${line} L${w},${h} L0,${h} Z`,
    lastX: w,
    lastY: y(last),
    up: last >= points[0],
    flat: !(span > 0)
  };
}
