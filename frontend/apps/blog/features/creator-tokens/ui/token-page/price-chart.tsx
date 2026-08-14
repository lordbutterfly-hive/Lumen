'use client';

import { FC } from 'react';

/** Calm line chart (no candlesticks/order-book/depth — per design). */
const PriceChart: FC<{ points: number[] }> = ({ points }) => {
  const w = 380;
  const h = 190;
  if (points.length < 2) {
    return <div className="flex h-[190px] items-center justify-center text-[13px] leading-[20px] text-ink-14">No price history yet.</div>;
  }
  const min = Math.min(...points) * 0.98;
  const max = Math.max(...points) * 1.02;
  const y = (v: number) => h - ((v - min) / (max - min)) * h;
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${y(v)}`).join(' ');
  const up = points[points.length - 1] >= points[0];
  // ★ `rgb(var(--line-brand-10))`, not `#c0392b` (2026-08-14): an SVG `stroke`/
  // `fill` attribute is a real CSS value, so the custom property resolves the
  // same as `text-line-brand-10` would, and picks up the dark-mode lift the
  // literal never did. `line-brand-10` (not `surface-brand-12`) because this
  // variable's primary use below is `stroke` — a drawn LINE, not a card fill.
  const stroke = up ? '#2f7d4f' : 'rgb(var(--line-brand-10))';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[190px] w-full overflow-visible">
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1="0" y1={h * g} x2={w} y2={h * g} stroke="#f0f0f0" strokeWidth="1" />
      ))}
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={stroke} opacity="0.07" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={y(points[points.length - 1])} r="4" fill={stroke} />
    </svg>
  );
};

export default PriceChart;
