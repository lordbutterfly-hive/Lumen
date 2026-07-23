'use client';

import { FC, useMemo, useState } from 'react';
import { Link } from '@hive/ui';
import type { PortfolioAsk, TokenHolding } from '../../market/portfolio';
import { MOCK_ASKS, MOCK_HOLDINGS, portfolioTotals } from '../../market/portfolio';
import { usdPrice } from '../../market/format';
import TokenShell from '../token-shell';

const tok = (n: number) => n.toFixed(1);
const changeColor = (n: number) => (n >= 0 ? 'text-[#2f7d4f]' : 'text-[#c0392b]');
const arrow = (n: number) => (n >= 0 ? '▲' : '▼');

const Spark: FC<{ points: number[]; up: boolean }> = ({ points, up }) => {
  const w = 64;
  const h = 22;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[22px] w-16">
      <path d={path} fill="none" stroke={up ? '#2f7d4f' : '#c0392b'} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const HoldingRow: FC<{ h: TokenHolding }> = ({ h }) => (
  <div className="flex flex-wrap items-center gap-4 rounded-[16px] border border-[#ebebeb] bg-white px-5 py-4">
    <span className="h-11 w-11 flex-shrink-0 rounded-[12px]" style={{ background: h.avatarColor }} />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <Link href={`/creators/${h.handle}`} className="text-[15px] font-bold text-[#161511] hover:text-[#c0392b]">
          @{h.handle}
        </Link>
        {h.windingDown ? <span className="h-2 w-2 rounded-full bg-[#b45309]" title="Winding down — you can still sell/reclaim" /> : null}
      </div>
      <div className="font-serif text-[13px] text-[#4b5563]">{h.what}</div>
    </div>
    <Spark points={h.spark} up={h.changePctWeek >= 0} />
    <div className="text-right tabular-nums">
      <div className="text-[15px] font-bold text-[#161511]">
        {tok(h.tokens)} tokens · {usdPrice(h.valueUsd)}
      </div>
      <div className="text-[12px] text-[#9ca3af]">
        {usdPrice(h.priceUsd)}/token · floor {usdPrice(h.floorValueUsd)}{' '}
        <span className={`font-semibold ${changeColor(h.changePctWeek)}`}>
          {arrow(h.changePctWeek)} {Math.abs(h.changePctWeek)}%
        </span>
      </div>
    </div>
    <div className="flex gap-2">
      {['Buy', 'Sell', 'Spend', 'Send'].map((label) => (
        <Link
          key={label}
          href={`/creators/${h.handle}`}
          className="rounded-[9px] border border-[#e4e6e9] bg-white px-3 py-2 text-[12.5px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5]"
        >
          {label}
        </Link>
      ))}
    </div>
  </div>
);

const askStyle: Record<PortfolioAsk['state'], { label: string; cls: string }> = {
  awaiting: { label: 'Awaiting', cls: 'text-[#b45309]' },
  answered: { label: 'Answered', cls: 'text-[#2f7d4f]' },
  reclaimable: { label: 'Reclaimable', cls: 'text-[#b45309]' },
  reclaimed: { label: 'Reclaimed', cls: 'text-[#9ca3af]' }
};

const AskCard: FC<{ a: PortfolioAsk }> = ({ a }) => {
  const s = askStyle[a.state];
  const reclaimable = a.state === 'reclaimable';
  return (
    <div className={`rounded-[16px] border bg-white px-5 py-4 ${reclaimable ? 'border-[#f6e2c4] bg-[#fdf6ec]' : 'border-[#ebebeb]'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14.5px] font-semibold text-[#161511]">
          {a.service} · <span className="text-[#4b5563]">@{a.handle}</span>
        </div>
        <div className={`text-[12.5px] font-bold ${s.cls}`}>{s.label}</div>
      </div>
      <div className="mt-1 text-[12.5px] tabular-nums text-[#6b7280]">
        {usdPrice(a.costUsd)} · {a.tokens.toFixed(2)} tokens {a.state === 'answered' ? 'paid to the creator' : a.state === 'reclaimed' ? 'returned' : 'in escrow'}
        {a.dueLabel ? ` · ${a.dueLabel}` : ''}
      </div>
      {a.state === 'answered' && a.answer ? (
        <p className="mt-2.5 rounded-[10px] bg-[#f6f7f8] px-3.5 py-3 font-serif text-[13.5px] leading-[1.55] text-[#2a2822]">{a.answer}</p>
      ) : null}
      {reclaimable ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[13px] text-[#8a5a20]">You get {a.tokens.toFixed(2)} tokens back to your balance — in full.</div>
          <button className="rounded-[10px] bg-[#b45309] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#8a4207]">Get your tokens back</button>
        </div>
      ) : null}
    </div>
  );
};

const YourTokensView: FC = () => {
  const [tab, setTab] = useState<'holdings' | 'asks'>('holdings');
  const totals = useMemo(() => portfolioTotals(MOCK_HOLDINGS), []);
  const weekChange = 4.1;
  const reclaimable = MOCK_ASKS.filter((a) => a.state === 'reclaimable').length;

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-1.5 font-serif text-lg font-semibold text-[#161511]">Find more creators</div>
        <p className="mb-4 font-serif text-[13.5px] leading-[1.5] text-[#6b7280]">Hold their token, spend it on their work.</p>
        <Link href="/creators" className="block rounded-[11px] bg-[#c0392b] py-3 text-center text-sm font-semibold text-white hover:bg-[#a5301f]">
          Discover creators →
        </Link>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      <h1 className="font-serif text-[32px] font-semibold tracking-[-0.015em] text-[#161511]">Your tokens</h1>

      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-1">
        <div className="text-[38px] font-extrabold tabular-nums text-[#161511]">{usdPrice(totals.valueUsd)}</div>
        <div className={`pb-1.5 text-[15px] font-bold ${changeColor(weekChange)}`}>
          {arrow(weekChange)} {weekChange}% this week
        </div>
        <div className="pb-1.5 text-[15px] tabular-nums text-[#6b7280]">Floor value {usdPrice(totals.floorUsd)}</div>
      </div>
      <p className="mt-1 text-[13.5px] text-[#6b7280]">You hold tokens from {totals.creators} creators.</p>

      {reclaimable > 0 ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3">
          <span className="text-[13.5px] font-semibold text-[#b45309]">You have {reclaimable} ask{reclaimable > 1 ? 's' : ''} with tokens to reclaim.</span>
          <button onClick={() => setTab('asks')} className="text-[13px] font-semibold text-[#b45309] underline">
            View
          </button>
        </div>
      ) : null}

      <div className="mb-4 mt-5 inline-flex gap-1.5 rounded-xl border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
        {(['holdings', 'asks'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-[18px] py-2 text-[13.5px] font-semibold capitalize ${
              tab === t ? 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08)]' : 'text-[#6b7280]'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'holdings' ? (
        <>
          <div className="flex flex-col gap-2.5">
            {MOCK_HOLDINGS.map((h) => (
              <HoldingRow key={h.handle} h={h} />
            ))}
          </div>
          <p className="mt-4 font-serif text-[12.5px] leading-[1.55] text-[#9ca3af]">
            Token prices float — the floor value is the least you’re guaranteed back. Selling and reclaiming work in every market state.
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-2.5">
          {MOCK_ASKS.map((a) => (
            <AskCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </TokenShell>
  );
};

export default YourTokensView;
