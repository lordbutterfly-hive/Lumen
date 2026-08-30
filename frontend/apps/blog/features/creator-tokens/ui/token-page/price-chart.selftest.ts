/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE PRICE CHART ACTUALLY DRAWS, AND WHAT IT DOES WHEN IT CANNOT.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/ui/token-page/price-chart.selftest.ts
 *
 * WHY THIS EXISTS. Nobody had ever seen this chart with data. It is fed by
 * `lumen_ct_price_history` through `live/adapt.ts`, which refuses to pass fewer
 * than two points, and no market on the testnet has traded twice, so every
 * render anyone had witnessed was the "No price history yet" placeholder. A
 * component whose only exercised branch is its empty state is a component nobody
 * has tested.
 *
 * ★★★ AND THERE WAS A REAL DEFECT IN THE BRANCH NOBODY HAD SEEN. An all-zero
 * series divided by zero:
 *
 *     min = Math.min(...points) * 0.98   ->  0
 *     max = Math.max(...points) * 1.02   ->  0
 *     y   = h - ((v - min) / (max - min)) * h   ->  0/0  ->  NaN
 *
 * producing `d="M0,NaN L190,NaN L380,NaN"`. No exception, no error boundary: an
 * invisible line and a `<circle cy="NaN">` on a page that otherwise looked fine.
 * It is REACHABLE: the spot rate at supply 0 is 0 by design (curve.go records no
 * observation for an empty market, the same zero behind the "Price after your
 * buy: ~$0.00" bug fixed 2026-08-21), and a sell that empties a market writes a
 * `supply_after = 0` row. Section 2 pins that case, and section 5 replicates the
 * OLD expression to prove the vectors here really do reach the defect.
 *
 * ★ SECTION 4 RENDERS THE REAL COMPONENT. Asserting on the extracted geometry
 * proves the maths; it does not prove the component uses it. Section 4 puts
 * `PriceChart` through `react-dom/server` and reads the actual SVG, so the path
 * being asserted is the path a browser would receive.
 */

import * as React from 'react';
// tsx transpiles JSX with the CLASSIC runtime and does not inject an import, so
// every module in this graph, including price-chart.tsx, resolves a bare
// `React`. Setting it before the component is imported is what makes section 4
// possible at all; without it the render throws "React is not defined".
(globalThis as unknown as { React: typeof React }).React = React;

import { renderToStaticMarkup } from 'react-dom/server';
import { CHART_HEIGHT, CHART_WIDTH, chartGeometry, isDrawableSeries } from './price-chart-geometry';
import PriceChart from './price-chart';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

/** Every y in a path `d`, in order. Returns [] when the path names none, which is itself a failure signal. */
function ysOf(d: string): string[] {
  return Array.from(d.matchAll(/[ML]-?[\d.]+,(-?[\d.eE+]+|NaN)/g)).map((m) => m[1]);
}

const near = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;

console.log('\n── 1. A REAL SERIES PRODUCES A REAL PATH.\n');
{
  const g = chartGeometry([1.0, 1.2, 1.5, 1.9]);
  check('a rising series is drawable', g !== null);
  check('the box is the one the component uses', CHART_WIDTH === 380 && CHART_HEIGHT === 190);

  const ys = g ? ysOf(g.line) : [];
  check('★ the path has one point per price, and every one is a number', ys.length === 4 && ys.every((y) => Number.isFinite(Number(y))), g?.line);
  // The exact values the padding arithmetic gives: min 0.98, max 1.938, span 0.958.
  check('★ the first point sits near the bottom, at the measured y', near(Number(ys[0]), 186.0334), `got ${ys[0]}`);
  check('★ …and the last near the top', near(Number(ys[3]), 7.5365), `got ${ys[3]}`);
  check('x spans the full width, oldest at 0', g !== null && g.line.startsWith('M0,') && g.line.includes('L380,'));
  check('the area path closes to the baseline', g !== null && g.area.endsWith(`L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`));
  check('the end marker sits on the last point', g !== null && near(g.lastY, Number(ys[3])) && g.lastX === CHART_WIDTH);
  check('a rising series is "up", which is the only thing that picks the colour', g?.up === true);
  check('…and a falling one is not', chartGeometry([2, 1])?.up === false);
  check('a series is not flagged flat when it has range', g?.flat === false);

  // Two points is the minimum a chart is allowed to draw, and it must work.
  const two = chartGeometry([1, 2]);
  check('★ TWO points draw, because that is exactly the bound adapt.ts allows through', two !== null && ysOf(two.line).length === 2 && ysOf(two.line).every((y) => Number.isFinite(Number(y))));

  // A range of seven orders of magnitude must not lose the small end.
  const huge = chartGeometry([0.001, 26932.03]);
  check('a huge range still produces finite coordinates', huge !== null && ysOf(huge.line).every((y) => Number.isFinite(Number(y))), huge?.line);
}

console.log('\n── 2. THE DEGENERATE SPAN. This is the divide-by-zero.\n');
{
  const zero = chartGeometry([0, 0, 0]);
  check('★★★ AN ALL-ZERO SERIES DRAWS, and does not produce NaN', zero !== null && !zero.line.includes('NaN'), zero?.line);
  check('★ …every point on the vertical middle, which is what a flat line means', zero?.line === 'M0,95 L190,95 L380,95', `got: ${zero?.line}`);
  check('★ …and the end marker is a number too, not cy="NaN"', zero !== null && Number.isFinite(zero.lastY) && zero.lastY === 95);
  check('…the series is flagged flat, so a caller can tell', zero?.flat === true);

  // ★ THE CONTROL THAT MUST KEEP WORKING. The 0.98/1.02 padding already handled
  //   a flat NON-zero series correctly; the fix must not change it.
  const flat = chartGeometry([1.4, 1.4, 1.4, 1.4]);
  check('★ CONTROL: a flat non-zero series still centres at 95, exactly as before', flat !== null && ysOf(flat.line).every((y) => Number(y) === 95), flat?.line);
  check(
    '★ …and it is NOT flagged degenerate, because its span is real (1.372 to 1.428)',
    flat?.flat === false,
    'the two cases look identical on screen and are arithmetically different; only the all-zero one was ever broken'
  );
  check('★ …which is exactly why the guard tests the SPAN and not the value zero', zero?.flat === true && flat?.flat === false);

  // Zero at one end only: the span is real, so nothing degenerate happens.
  const fromZero = chartGeometry([0, 1.0, 2.0]);
  check('★ zero as the FIRST point is not degenerate: max > min, so it draws normally', fromZero !== null && !fromZero.line.includes('NaN') && fromZero.flat === false, fromZero?.line);
  check('…and the zero point lands at the bottom of the box', fromZero !== null && Number(ysOf(fromZero.line)[0]) > 180, fromZero?.line);
}

console.log('\n── 3. WHAT IS NOT DRAWABLE IS NOT DRAWN.\n');
{
  check('no series', chartGeometry(null) === null && chartGeometry(undefined) === null);
  check('an empty series', chartGeometry([]) === null);
  check('★ ONE point: a flat line from one moment claims a steadiness we do not know', chartGeometry([1.4]) === null);
  check('★ a NaN anywhere refuses the whole series, because Math.min of it is NaN', chartGeometry([1, Number.NaN, 2]) === null);
  check('…as does an infinity', chartGeometry([1, Number.POSITIVE_INFINITY]) === null);
  check('the predicate agrees with the geometry, in both directions', isDrawableSeries([1, 2]) && !isDrawableSeries([1]) && !isDrawableSeries([1, Number.NaN]));

  // ★ NEGATIVE CONTROL. A `chartGeometry` that returned null unconditionally
  //   would satisfy every assertion in this section.
  check('★ NEGATIVE CONTROL: the function really does draw something for a good series', chartGeometry([1, 2]) !== null);
}

console.log('\n── 4. THE COMPONENT ITSELF, RENDERED. Not the helper: the SVG a browser gets.\n');
{
  const rising = renderToStaticMarkup(React.createElement(PriceChart, { points: [1.0, 1.2, 1.5, 1.9] }));
  // ── Non-vacuity. A render that produced nothing must FAIL, never pass.
  check('the render produced markup', rising.length > 400, `${rising.length} bytes`);
  check('★ it is an <svg> with the drawing box, not a placeholder', rising.startsWith('<svg viewBox="0 0 380 190"') && !rising.includes('No price history yet'));
  check('★ the SVG carries a real path, generated from the points', rising.includes('d="M0,186.03340292275573 L126.66666666666666,146.36743215031316 L253.33333333333331,86.86847599164928 L380,7.536534446764108"'), rising.slice(0, 400));
  check('★ …and no NaN anywhere in it', !rising.includes('NaN'));
  check('the end marker is on the last point', rising.includes('<circle cx="380" cy="7.536534446764108"'));
  check('a rising series draws in the up colour', rising.includes('stroke="#2f7d4f"'));

  const falling = renderToStaticMarkup(React.createElement(PriceChart, { points: [2, 1] }));
  check('a falling series draws in the tokenised down colour, not a hex literal', falling.includes('stroke="rgb(var(--line-brand-10))"'));

  const zero = renderToStaticMarkup(React.createElement(PriceChart, { points: [0, 0, 0] }));
  check('★★★ THE ALL-ZERO SERIES RENDERS A REAL SVG, not d="M0,NaN"', zero.includes('d="M0,95 L190,95 L380,95"') && !zero.includes('NaN'), zero.slice(0, 400));
  check('★ …and its end marker has a numeric cy', zero.includes('<circle cx="380" cy="95"'));

  const flat = renderToStaticMarkup(React.createElement(PriceChart, { points: [1.4, 1.4, 1.4, 1.4] }));
  check('★ CONTROL: the flat non-zero render is unchanged, centred at 95', flat.includes('d="M0,95 L126.66666666666666,95 L253.33333333333331,95 L380,95"'), flat.slice(0, 400));

  const one = renderToStaticMarkup(React.createElement(PriceChart, { points: [1.4] }));
  check('one point renders the placeholder, not a chart', one.includes('No price history yet.') && !one.includes('<svg'));
  const none = renderToStaticMarkup(React.createElement(PriceChart, { points: [] }));
  check('…so does an empty series', none.includes('No price history yet.'));
  const nan = renderToStaticMarkup(React.createElement(PriceChart, { points: [1, Number.NaN] }));
  check('★ …and so does an unreadable one, rather than a broken path', nan.includes('No price history yet.') && !nan.includes('NaN'));
}

console.log('\n── 5. THE DEFECT IS REAL. The old expression, replicated, against the same vectors.\n');
{
  /**
   * ★ THIS IS THE VACUOUS-PASS GUARD FOR SECTION 2. Section 2 asserts the fixed
   * behaviour; on its own it cannot show the fix was needed. This replicates the
   * PREVIOUS body of price-chart.tsx exactly and runs the same vectors through
   * it, so the assertions below fail the moment the guard is removed and the old
   * arithmetic comes back.
   */
  const oldY = (points: number[]): number[] => {
    const h = 190;
    const min = Math.min(...points) * 0.98;
    const max = Math.max(...points) * 1.02;
    return points.map((v) => h - ((v - min) / (max - min)) * h);
  };

  const nowZero = chartGeometry([0, 0, 0]);
  const nowFlat = chartGeometry([1.4, 1.4, 1.4, 1.4]);
  const nowRising = chartGeometry([1.0, 1.2, 1.5, 1.9]);
  check('the three comparison series all draw under the new code', nowZero !== null && nowFlat !== null && nowRising !== null);

  check('★ the OLD code produced NaN for [0,0,0] — the defect this file pins', oldY([0, 0, 0]).every((y) => Number.isNaN(y)));
  check('★ …and the NEW code does not, for the same input', nowZero !== null && nowZero.line.includes('95') && !nowZero.line.includes('NaN'));
  check('★ the OLD code was already correct for the flat NON-zero case, so the fix is not a rewrite', oldY([1.4, 1.4, 1.4, 1.4]).every((y) => y === 95));
  check('★ …and the new code agrees with it there, to the digit', nowFlat !== null && ysOf(nowFlat.line).map(Number).every((y) => y === 95));
  check('★ the OLD code was correct for a rising series, and the new one matches it exactly', nowRising !== null && oldY([1.0, 1.2, 1.5, 1.9]).map(String).join('|') === ysOf(nowRising.line).join('|'));
}

console.log('\n── 6. WIRING. The component computes nothing of its own any more.\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  const src = readFileSync(join(__dirname, 'price-chart.tsx'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('the scan read price-chart.tsx', src.length > 900, `${src.length} bytes`);
  check('comment stripping left the code behind', stripped.length > 500, `${stripped.length} bytes after stripping`);
  check('★ the divide is gone from the component', !stripped.includes('(max - min)'));
  check('★ …and so is the range arithmetic it came from', !stripped.includes('Math.min(...points)') && !stripped.includes('Math.max(...points)'));
  check('★ the component renders the shared geometry', stripped.includes('chartGeometry(points, w, h)') && stripped.includes('d={g.line}') && stripped.includes('d={g.area}'));
  check('★ …and takes its absence as the placeholder condition, so a bad series cannot fall through', stripped.includes('if (!g)') && !stripped.includes('points.length < 2'));

  // The token page must still be the thing that renders it.
  const viewSrc = readFileSync(join(__dirname, 'token-market-view.tsx'), 'utf8');
  check('the scan read token-market-view.tsx', viewSrc.length > 20_000, `${viewSrc.length} bytes`);
  // ★ 2026-08-30: the caption's number moved from `chart.length` to
  // `chartTrades` when `readPriceHistory` began prepending the market's OPENING
  // price. The chart still draws the same array the indicator reads; only the
  // BASIS the caption states changed, because points and trades stopped being
  // the same count. See ../../lib/vsc-data-source.ts's readPriceHistory.
  check('★ the page renders the chart from the same array the change indicator uses', viewSrc.includes('<PriceChart points={market.chart} />') && viewSrc.includes('market.chartTrades ?? market.chart.length'));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
