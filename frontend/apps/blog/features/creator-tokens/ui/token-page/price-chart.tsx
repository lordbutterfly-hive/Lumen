'use client';

import { FC } from 'react';
import { CHART_HEIGHT, CHART_WIDTH, chartGeometry } from './price-chart-geometry';

/**
 * Calm line chart (no candlesticks/order-book/depth — per design).
 *
 * ★ THE MATHS MOVED OUT (2026-08-27), to `price-chart-geometry.ts`, and it is
 * not a tidy-up: the path was computed inside this `'use client'` component, so
 * nothing could assert on it, and an all-zero series had been dividing by zero
 * and rendering `d="M0,NaN L190,NaN"` silently. See that module's header for the
 * defect, the replication and the guard. This file now decides only what the
 * chart LOOKS like; it computes nothing.
 */
const PriceChart: FC<{ points: number[] }> = ({ points }) => {
  const w = CHART_WIDTH;
  const h = CHART_HEIGHT;
  const g = chartGeometry(points, w, h);
  // Fewer than two points, or a point we cannot read. Unchanged behaviour, now
  // stated by one predicate instead of a bare `length < 2` that let a NaN
  // through into the range arithmetic.
  if (!g) {
    return <div className="flex h-[190px] items-center justify-center text-caption italic text-ink-14">No price history yet.</div>;
  }
  // ★ `rgb(var(--line-brand-10))`, not `#c0392b` (2026-08-14): an SVG `stroke`/
  // `fill` attribute is a real CSS value, so the custom property resolves the
  // same as `text-line-brand-10` would, and picks up the dark-mode lift the
  // literal never did. `line-brand-10` (not `surface-brand-12`) because this
  // variable's primary use below is `stroke` — a drawn LINE, not a card fill.
  const stroke = g.up ? '#2f7d4f' : 'rgb(var(--line-brand-10))';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[190px] w-full overflow-visible">
      {[0, 0.5, 1].map((gl) => (
        <line key={gl} x1="0" y1={h * gl} x2={w} y2={h * gl} stroke="#f0f0f0" strokeWidth="1" />
      ))}
      <path d={g.area} fill={stroke} opacity="0.07" />
      <path d={g.line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={g.lastX} cy={g.lastY} r="4" fill={stroke} />
    </svg>
  );
};

export default PriceChart;
