'use client';

import { FC } from 'react';
import type { LiveTokenMarket } from '../../live/adapt';
import { usdPrice } from '../../market/format';
import { priceChangeLabel } from '../../market/price-change';
import { chartGeometry } from '../token-page/price-chart-geometry';
import { MERITUM_PAGE_COPY as COPY } from './meritum-copy';

const W = 386;
const H = 118;

/**
 * The curve panel on the hero (handoff §1 "Market"): the price at the curve's
 * price, the change since the first recorded point, and the sparkline drawn
 * from the REAL series — the same `chart` array the change is derived from
 * (`live/adapt.ts`), so the number and the picture cannot disagree.
 *
 * ★ NEVER PAYOUT GREEN. The token page's chart turns green when the line
 * goes up; the handoff (§7) reserves green for money the creator received,
 * so here up is ink, down is brand, and the line is always brand. Colour is
 * not the only signal either way: the label carries a glyph and a sentence.
 *
 * ★ ONE TRADE DRAWS ONE POINT, not a flat line claiming the price held.
 * `chartGeometry` returns null below two readable points; the single-point
 * case is drawn here as the dot alone.
 */
const CurvePanel: FC<{ market: LiveTokenMarket; historyUnavailable: boolean }> = ({ market, historyUnavailable }) => {
  const change = priceChangeLabel(market.priceChange);
  const points = market.chart;
  const g = chartGeometry(points, W, H);
  const trades = market.chartTrades ?? points?.length ?? 0;
  const single = !g && points && points.length === 1 && Number.isFinite(points[0]);

  return (
    <div className="rounded-panel border border-line-9 bg-surface-1 px-[22px] pb-4 pt-5 shadow-[0_2px_10px_rgba(26,22,18,0.05)]" data-testid="meritum-curve-panel">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[40px] leading-[44px] tracking-[-0.02em] text-ink-2 font-num" data-testid="meritum-price">
          {usdPrice(market.priceUsd)}
        </span>
        {change ? (
          <span
            className={`inline-flex items-baseline gap-1 text-[14px] leading-[22px] font-num ${
              change.direction === 'up' ? 'text-ink-2' : change.direction === 'down' ? 'text-ink-brand-6' : 'text-ink-10'
            }`}
            data-testid="meritum-price-change"
          >
            <span aria-hidden="true">
              {change.mark ? `${change.mark} ` : ''}
              {change.text}
            </span>
            <span className="sr-only">{change.aria}</span>
          </span>
        ) : null}
        <span className="ml-auto font-ui text-[11.5px] font-medium uppercase tracking-[0.12em] text-ink-14">{COPY.bondingCurve}</span>
      </div>
      {g ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 block h-[118px] w-full" fill="none" aria-hidden="true" data-testid="meritum-sparkline">
          <defs>
            <linearGradient id="meritum-curve-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgb(var(--line-brand-10))" stopOpacity="0.2" />
              <stop offset="1" stopColor="rgb(var(--line-brand-10))" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={g.area} fill="url(#meritum-curve-fill)" />
          <path d={g.line} stroke="rgb(var(--line-brand-10))" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={g.lastX} cy={g.lastY} r="4.5" fill="rgb(var(--line-brand-10))" />
        </svg>
      ) : single ? (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 block h-[118px] w-full" fill="none" aria-hidden="true" data-testid="meritum-sparkline-single">
          <circle cx={W - 6} cy={H / 2} r="4.5" fill="rgb(var(--line-brand-10))" />
        </svg>
      ) : null}
      <p className="mt-2 font-ui text-caption text-ink-14">
        {points && trades > 0 ? (
          <>
            <span className="font-num">{trades}</span> {trades === 1 ? 'trade' : 'trades'} · {COPY.curveNote}
          </>
        ) : historyUnavailable ? (
          COPY.historyUnavailable
        ) : (
          <>
            {COPY.curveNote} {COPY.noHistory}
          </>
        )}
      </p>
    </div>
  );
};

export default CurvePanel;
