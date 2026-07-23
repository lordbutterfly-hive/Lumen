'use client';

import { FC, useEffect, useState } from 'react';
import type { Service, TokenMarketDetail } from '../../market/token-detail';
import { serviceTokens } from '../../market/curve';
import { usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';
import PriceChart from './price-chart';
import TokenModals, { type TokenDialog } from './token-modals';

const RANGES = ['1D', '1W', '1M', 'All'];
const tok = (n: number) => n.toFixed(2);

const TokenMarketView: FC<{ market: TokenMarketDetail }> = ({ market }) => {
  const [dialog, setDialog] = useState<TokenDialog>(null);
  const [service, setService] = useState<Service | null>(null);
  const [range, setRange] = useState('1W');
  const d = market.delivery;
  const supplyPct = Math.round((market.supply / market.cap) * 100);
  const up = market.changePctWeek >= 0;

  // Market interstitial — first view per creator, per session.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = `lumen-token-inter-${market.handle}`;
    if (!window.sessionStorage.getItem(key)) {
      setDialog('inter');
      window.sessionStorage.setItem(key, '1');
    }
  }, [market.handle]);

  const openAsk = (sv: Service) => {
    setService(sv);
    setDialog('ask');
  };

  const rightRail = (
    <div className="flex flex-col gap-5 pt-[26px]">
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-3 text-[14.5px] font-bold text-[#161511]">How this works</div>
        <div className="flex flex-col gap-3.5">
          {[
            'Buy the creator’s token — the price rises as more is bought.',
            'Spend tokens on their work — a question, a code review, a day of building — priced in dollars.',
            'As more people buy in, the token can appreciate; the floor is the least you’re guaranteed back.'
          ].map((line, i) => (
            <div key={i} className="flex gap-3">
              <span className="font-serif font-bold text-[#c0392b]">{i + 1}</span>
              <span className="text-[13px] leading-[1.5] text-[#3f4650]">{line}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-[18px] border border-[#ebebeb] bg-white p-5">
        <div className="mb-1.5 text-xs text-[#6b7280]">Reserve backing</div>
        <div className="mb-0.5 text-[20px] font-bold tabular-nums text-[#161511]">{usdWhole(market.reserveUsd)}</div>
        <p className="font-serif text-[12.5px] leading-[1.5] text-[#9ca3af]">Held in reserve behind every token — the source of the floor.</p>
      </div>
    </div>
  );

  return (
    <TokenShell rightRail={rightRail}>
      {/* 1. Creator header */}
      <div className="mb-5 flex items-center gap-4">
        <span className="h-[60px] w-[60px] flex-shrink-0 rounded-2xl" style={{ background: market.avatarColor }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="text-xl font-bold text-[#161511]">@{market.handle}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f1f3f5] px-2 py-0.5 text-[11.5px] font-semibold text-[#4b5563]">
              Rep {market.reputation}
            </span>
          </div>
          <p className="mt-0.5 font-serif text-[14.5px] text-[#4b5563]">{market.what}</p>
        </div>
        <button className="rounded-[11px] border border-[#e4e6e9] bg-white px-5 py-2.5 text-sm font-semibold text-[#3f4650] hover:bg-[#f6f7f8]">
          Follow
        </button>
      </div>

      {/* 2. Token market — centerpiece */}
      <div className="mb-4 rounded-[20px] border border-[#ebebeb] bg-white p-[26px] shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-[18px] flex items-center gap-2.5">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-[7px] text-[12px] font-extrabold text-white"
            style={{ background: market.avatarColor }}
          >
            ◆
          </span>
          <span className="text-[15px] font-bold text-[#161511]">@{market.handle} token</span>
        </div>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-[44px] font-extrabold tabular-nums tracking-[-0.02em] text-[#161511]">{usdPrice(market.priceUsd)}</span>
              <span className={`inline-flex items-center gap-1 text-[15px] font-bold ${up ? 'text-[#2f7d4f]' : 'text-[#c0392b]'}`}>
                {up ? '▲' : '▼'} {Math.abs(market.changePctWeek)}% this week
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-[18px]">
              <div>
                <div className="mb-0.5 text-xs text-[#6b7280]">Market cap</div>
                <div className="text-[19px] font-bold tabular-nums text-[#161511]">{usdWhole(market.marketCapUsd)}</div>
              </div>
              <div className="h-[34px] w-px bg-[#ececec]" />
              <div>
                <div className="mb-0.5 flex items-center gap-1.5 text-xs text-[#6b7280]">
                  Floor
                  <span
                    title="The least you'd get back if the market wound down — the reserve behind each token. Your honest downside."
                    className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-[#f1f3f5] text-[9px] text-[#9ca3af]"
                  >
                    ?
                  </span>
                </div>
                {/* Floor beside price, equal size, muted — never colored. */}
                <div className="text-[19px] font-bold tabular-nums text-[#6b7280]">{usdPrice(market.floorUsd)}</div>
              </div>
            </div>
            <div className="mt-[18px]">
              <div className="mb-1.5 flex justify-between text-xs tabular-nums text-[#6b7280]">
                <span>
                  {market.supply.toLocaleString('en-US')} of {market.cap.toLocaleString('en-US')} tokens issued
                </span>
                <span>{supplyPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-md bg-[#f1f3f5]">
                <div className="h-full bg-[#3a5a80]" style={{ width: `${supplyPct}%` }} />
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setDialog('buy')}
                disabled={market.windingDown}
                className="flex-1 rounded-xl bg-[#c0392b] py-3.5 text-[15px] font-bold text-white hover:bg-[#a5301f] disabled:opacity-50"
              >
                Buy
              </button>
              <button
                onClick={() => setDialog('sell')}
                className="flex-1 rounded-xl border border-[#e4e6e9] bg-white py-3.5 text-[15px] font-semibold text-[#3f4650] hover:bg-[#f6f7f8]"
              >
                Sell
              </button>
            </div>
          </div>
          <div>
            <PriceChart points={market.chart} />
            <div className="mt-2.5 flex justify-center gap-1.5">
              {RANGES.map((r) => {
                const on = range === r;
                return (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={`rounded-lg px-3.5 py-1.5 text-xs font-semibold ${on ? 'bg-[#f1f3f5] text-[#161511]' : 'text-[#9ca3af]'}`}
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Trust record */}
      <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-3.5 font-serif text-[19px] font-semibold text-[#161511]">Delivery record</div>
        {d.available ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {d.marks.map((answered, i) => (
                <span key={i} className={`h-[18px] w-[18px] rounded-[5px] ${answered ? 'bg-[#2f7d4f]' : 'border-[1.5px] border-[#d5d8dd] bg-white'}`} />
              ))}
            </div>
            <div className="text-base tabular-nums text-[#2a2822]">
              <strong>{d.completionPct}% completion rate</strong> — completed {d.answered} of {d.total} · usually within{' '}
              <strong>{d.typicalResponse}</strong>.
            </div>
            <div className="mt-1.5 text-[12.5px] text-[#9ca3af]">Why the token is worth holding — this is what you’re really buying.</div>
          </>
        ) : (
          <div className="rounded-[11px] border border-dashed border-[#e4e6e9] px-4 py-3 text-[13px] text-[#9ca3af]">Delivery record unavailable</div>
        )}
      </div>

      {/* 4. Services */}
      <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white p-6 shadow-[0_1px_2px_rgba(20,18,10,0.03)]">
        <div className="mb-3.5 text-xs font-bold uppercase tracking-[0.05em] text-[#9ca3af]">What you can do with the token</div>
        <div className="mb-3.5 flex flex-col gap-2.5">
          {market.services.map((sv) => (
            <div key={sv.key} className="flex items-center gap-3.5 rounded-[14px] border border-[#ebebeb] px-[18px] py-4">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[11px] bg-[#f4f5f7] text-[#c0392b]">◆</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-[#161511]">{sv.name}</div>
                <div className="text-[13px] text-[#6b7280]">{sv.desc}</div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[15px] font-bold tabular-nums text-[#161511]">{usdWhole(sv.usd)}</div>
                <div className="text-xs tabular-nums text-[#9ca3af]">≈ {tok(serviceTokens(sv.usd, market.priceUsd))} tokens</div>
              </div>
              {sv.status === 'live' ? (
                <button
                  onClick={() => openAsk(sv)}
                  className="flex-shrink-0 rounded-[11px] bg-[#1a1a17] px-[18px] py-2.5 text-[13.5px] font-semibold text-white hover:bg-black"
                >
                  {sv.cta}
                </button>
              ) : (
                <span className="flex-shrink-0 rounded-full bg-[#f1f3f5] px-3 py-1.5 text-[12px] font-semibold text-[#9ca3af]">Rolling out</span>
              )}
            </div>
          ))}
        </div>
        <p className="font-serif text-[13px] leading-[1.55] text-[#6b7280]">
          Prices are set in dollars. As the token’s price rises, a service costs fewer tokens.
        </p>
      </div>

      {/* 5. Your position */}
      {market.position ? (
        <div className="mb-4 rounded-[18px] border border-[#ebebeb] bg-[#faf9f6] px-6 py-[22px]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="text-[15px] tabular-nums text-[#3f4650]">
              You hold <strong className="text-[#161511]">{tok(market.position.tokens)} tokens</strong> · worth{' '}
              <strong className="text-[#161511]">{usdPrice(market.position.valueUsd)}</strong> · floor value{' '}
              <strong className="text-[#161511]">{usdPrice(market.position.floorValueUsd)}</strong>
            </div>
            <div className="flex gap-2.5">
              <button onClick={() => setDialog('sell')} className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2.5 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5]">
                Sell
              </button>
              <button className="rounded-[10px] border border-[#e4e6e9] bg-white px-4 py-2.5 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f1f3f5]">Send</button>
              <button onClick={() => openAsk(market.services[0])} className="rounded-[10px] bg-[#1a1a17] px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-black">
                Spend
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 6. Honest note */}
      <p className="font-serif text-[12.5px] leading-[1.6] text-[#9ca3af]">
        This token’s price floats — it can go up or down. The floor above is the least you’re guaranteed back. If you sell
        soon after buying, an early-exit fee applies (it fades to zero over 6 weeks).
      </p>

      <TokenModals dialog={dialog} market={market} service={service} onClose={() => setDialog(null)} />
    </TokenShell>
  );
};

export default TokenMarketView;
