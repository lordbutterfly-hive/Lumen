'use client';

import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

// Coinbase-style pool-odds line chart. Pure SVG, no deps. One line per outcome,
// y-axis 0-100¢ (the pool share), x-axis dates. Presentation-only: it renders
// whatever `series` it is handed.
//
// Real history now comes from the Magi indexer's lumen_pm_pool_history view,
// folded into per-outcome shares by lib/pool-series.ts. When that is
// unavailable — no indexer configured, unreachable, or a round with fewer than
// two blocks of bets — the caller passes a flat series at each bucket's live
// share AND sets `placeholder`, which is what labels it on screen. A flat line
// with no label would read as evidence that the odds held steady.

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
  // TRUE ⇒ the series is a flat stand-in, not history. Must be set by the caller
  // whenever it could not get real data; it drives the on-screen caption that
  // stops the chart being read as a record of how the odds moved.
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
            <text x={W + 8} y={toY(g) + 4} fontSize={12} fill="#9ca3af">
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
            fontSize={12}
            fill="#9ca3af"
            textAnchor={i === 0 ? 'start' : i === xLabels.length - 1 ? 'end' : 'middle'}
          >
            {d}
          </text>
        ))}
      </svg>
      {placeholder && (
        <p className={cn('mt-1 text-center text-[12px] leading-[18px] text-ink-14')}>{t('prediction_market.chart_caption')}</p>
      )}
    </div>
  );
}
