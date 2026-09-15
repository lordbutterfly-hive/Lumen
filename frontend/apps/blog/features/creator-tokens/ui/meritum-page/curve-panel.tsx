'use client';

import { FC } from 'react';
import type { LiveTokenMarket } from '../../live/adapt';
import { usdPrice } from '../../market/format';
import { priceChangeLabel } from '../../market/price-change';
import { pctMoveLabel } from '../../market/format';
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
 * ★ UP IS PAYOUT GREEN (owner, 2026-09-15: "+2.4% increase in the chart put
 * that number always green like the green from payouts. same color green").
 * The change figure uses the same `--ink-payout` token as a post's payout;
 * down stays brand, flat stays muted, and the line itself stays brand. Colour
 * is not the only signal either way: the label carries a sign and a sentence.
 * (This overrides the handoff §7 rule that reserved green for money received.)
 *
 * ★ ONE TRADE DRAWS ONE POINT, not a flat line claiming the price held.
 * `chartGeometry` returns null below two readable points; the single-point
 * case is drawn here as the dot alone.
 */
const CurvePanel: FC<{ market: LiveTokenMarket; historyUnavailable: boolean }> = ({ market, historyUnavailable }) => {
  const change = priceChangeLabel(market.priceChange);
  const magnitude = market.priceChange ? pctMoveLabel(market.priceChange.pct) : null;
  const changeText = !change ? null : change.direction === 'flat' ? '0%' : change.direction === 'up' ? `+${magnitude ?? ''}` : `−${magnitude ?? ''}`;
  const points = market.chart;
  const g = chartGeometry(points, W, H);
  const trades = market.chartTrades ?? points?.length ?? 0;
  const single = !g && points && points.length === 1 && Number.isFinite(points[0]);

  return (
    <div className="rounded-panel border border-line-9 bg-surface-1 px-[22px] pb-4 pt-5 shadow-[0_2px_10px_rgba(26,22,18,0.05)]" data-testid="meritum-curve-panel">
      {/* Price and change on ONE baseline: both spans are plain inline text
          with `leading-none`, so the flex row's baseline alignment has nothing
          to fight (owner, 2026-09-15: "the price and unchanged over 2 trades is
          completely shittily aligned"). The change is a signed percentage —
          "+0.9%", "−1.2%", or "0%" when flat (owner: "unchanged over trades
          should just be 0%"); the sentence stays for screen readers. No
          "BONDING CURVE" label: this is a price chart (owner). */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[40px] leading-none tracking-[-0.02em] text-ink-2 font-num" data-testid="meritum-price">
          {usdPrice(market.priceUsd)}
        </span>
        {change && changeText ? (
          <span
            className={`text-[15px] leading-none font-medium font-num ${change.direction === 'up' ? 'text-[color:rgb(var(--ink-payout))]' : change.direction === 'down' ? 'text-ink-brand-6' : 'text-ink-10'}`}
            data-testid="meritum-price-change"
          >
            <span aria-hidden="true">{changeText}</span>
            <span className="sr-only">{change.aria}</span>
          </span>
        ) : null}
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
