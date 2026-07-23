'use client';

import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

// Coinbase-style pool-odds line chart. Pure SVG, no deps. One line per outcome,
// y-axis 0-100¢ (the pool share), x-axis dates. Presentation-only: it renders
// whatever `series` it is handed. `readRound()` currently has no historical
// series, so the caller passes a flat placeholder and sets `placeholder` — see
// TODO(series) below for wiring real history once an indexer exposes it.

export interface ChartSeries {
  label: string;
  color: string;
  points: number[]; // each 0..100 (¢ = pool share)
  end: number; // latest value, drawn as an endpoint dot
}

const GRIDLINES = [0, 25, 50, 75, 100];
const W = 620;
const H = 240;
const MAX_Y = 100;

const toX = (i: number, n: number): number => (n <= 1 ? 0 : (i / (n - 1)) * W);
const toY = (v: number): number => H - (Math.max(0, Math.min(MAX_Y, v)) / MAX_Y) * H;

function linePath(points: number[]): string {
  return points.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i, points.length)},${toY(v)}`).join(' ');
}

function areaPath(points: number[]): string {
  const last = toX(points.length - 1, points.length);
  return `${linePath(points)} L${last},${H} L0,${H} Z`;
}

export default function PriceChart({
  series,
  xLabels = [],
  placeholder = false,
  className
}: {
  series: ChartSeries[];
  xLabels?: string[];
  // TODO(series): flip to false and pass real per-outcome history once the
  // indexer exposes a time series; the caller currently builds a flat line at
  // each outcome's live share.
  placeholder?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('common_blog');

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${W + 44} ${H + 28}`}
        className="h-[250px] w-full overflow-visible"
        role="img"
        aria-label={t('prediction_market.chart_aria_label')}
      >
        {GRIDLINES.map((g) => (
          <g key={g}>
            <line x1={0} y1={toY(g)} x2={W} y2={toY(g)} stroke="#f2f2f2" strokeWidth={1} />
            <text x={W + 8} y={toY(g) + 4} fontSize={10.5} fill="#9ca3af">
              {g}¢
            </text>
          </g>
        ))}

        {series.map((s) => (
          <g key={s.label}>
            <path d={areaPath(s.points)} fill={s.color} opacity={0.05} />
            <path
              d={linePath(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle cx={toX(s.points.length - 1, s.points.length)} cy={toY(s.end)} r={3.5} fill="#fff" stroke={s.color} strokeWidth={2.5} />
          </g>
        ))}

        {xLabels.map((d, i) => (
          <text
            key={d}
            x={toX(i, xLabels.length)}
            y={H + 20}
            fontSize={10.5}
            fill="#9ca3af"
            textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
          >
            {d}
          </text>
        ))}
      </svg>
      {placeholder && (
        <p className={cn('mt-1 text-center text-[11px] text-[#9ca3af]')}>{t('prediction_market.chart_caption')}</p>
      )}
    </div>
  );
}
