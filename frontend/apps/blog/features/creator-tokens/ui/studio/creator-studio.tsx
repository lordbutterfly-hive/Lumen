'use client';

import { FC, useState, useEffect } from 'react';
import {
  useStudio,
  answerAsk,
  renewSubscription,
  setServicePrice,
  raiseCap,
  claimTradeFees,
  sell,
  STUDIO_HANDLE
} from '../../market/store';
import type { PortfolioAsk } from '../../market/portfolio';
import { usdPrice, usdWhole } from '../../market/format';
import TokenShell from '../token-shell';

type Section = 'overview' | 'inbox' | 'offerings' | 'market' | 'billing' | 'earnings';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'offerings', label: 'Offerings' },
  { id: 'market', label: 'Market' },
  { id: 'billing', label: 'Billing' },
  { id: 'earnings', label: 'Earnings' }
];

const tok = (n: number) => n.toFixed(2);
const Card: FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`rounded-[18px] border border-[#ebebeb] bg-white p-5 shadow-[0_1px_2px_rgba(20,18,10,0.03)] ${className}`}>{children}</div>
);
const Stat: FC<{ label: string; value: string; sub?: string; green?: boolean }> = ({ label, value, sub, green }) => (
  <div>
    <div className="text-[12px] font-semibold uppercase tracking-wide text-[#9ca3af]">{label}</div>
    <div className={`mt-1 text-[22px] font-bold tabular-nums ${green ? 'text-[#2f7d4f]' : 'text-[#161511]'}`}>{value}</div>
    {sub ? <div className="mt-0.5 text-[12.5px] text-[#6b7280]">{sub}</div> : null}
  </div>
);

// Controlled service-price editor: reverts an invalid entry to the committed
// price so the field never lies (#4), and re-syncs when the stored price changes.
const PriceInput: FC<{ value: number; onCommit: (usd: number) => void }> = ({ value, onCommit }) => {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);
  return (
    <input
      value={txt}
      inputMode="decimal"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        const n = parseFloat(txt.replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0) onCommit(n);
        else setTxt(String(value));
      }}
      className="ml-1 w-[70px] border-0 text-[15px] font-bold tabular-nums text-[#161511] outline-none"
    />
  );
};

const AnswerModal: FC<{ ask: PortfolioAsk; onClose: () => void }> = ({ ask, onClose }) => {
  const [text, setText] = useState('');
  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,18,10,0.4)] p-5 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} className="w-[500px] max-w-full rounded-[20px] bg-white p-6 shadow-[0_20px_60px_rgba(20,18,10,0.25)]">
        <div className="mb-2 font-serif text-xl font-semibold text-[#161511]">Answer this {ask.service.toLowerCase()}</div>
        <p className="mb-3 text-[13px] text-[#6b7280]">Kept private on Lumen — only this holder sees it. Never posted to Hive.</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write your answer…"
          className="h-[130px] w-full resize-y rounded-xl border border-[#e4e6e9] px-4 py-3 font-serif text-[15px] leading-[1.5] text-[#161511] outline-none focus:border-[#c0392b]"
        />
        <div className="mt-3 rounded-[10px] bg-[#f0f7f2] px-3.5 py-2.5 text-[13px] text-[#2f7d4f]">
          Answering pays you <strong>{usdWhole(ask.costUsd)} ({tok(ask.tokens)} tokens)</strong> and closes the ask. This can’t be undone.
        </div>
        <div className="mt-4 flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-[#e4e6e9] py-3 text-[14px] font-semibold text-[#6b7280]">Cancel</button>
          <button
            onClick={() => {
              answerAsk(ask.id, text.trim() || 'Answered.');
              onClose();
            }}
            disabled={text.trim().length === 0}
            className="flex-1 rounded-xl bg-[#c0392b] py-3 text-[14px] font-semibold text-white hover:bg-[#96271b] disabled:opacity-50"
          >
            Send answer
          </button>
        </div>
      </div>
    </div>
  );
};

const CreatorStudio: FC = () => {
  const { market, inbox, subDaysLeft, tradeFeeClaimableUsd, commissionEarnedUsd, launched } = useStudio();
  const [section, setSection] = useState<Section>('overview');
  const [answering, setAnswering] = useState<PortfolioAsk | null>(null);
  const [capInput, setCapInput] = useState(String(market.cap));
  const [sellInput, setSellInput] = useState('');
  // Keep the cap field in sync with the committed cap after a successful raise (#3).
  useEffect(() => setCapInput(String(market.cap)), [market.cap]);

  // No token yet → the launch wizard is the whole studio (spec's no-token state).
  if (!launched) {
    return (
      <TokenShell>
        <div className="mx-auto max-w-[560px] pt-16 text-center">
          <h1 className="font-serif text-3xl font-semibold text-[#161511]">Launch your creator token</h1>
          <p className="mt-3 font-serif text-[15px] leading-[1.6] text-[#6b7280]">
            One token, bound to your account, that trades on a live market and is spent on your services. Free to launch.
          </p>
          <a href="/creators/launch" className="mt-6 inline-block rounded-[13px] bg-[#c0392b] px-6 py-3 text-[15px] font-bold text-white hover:bg-[#96271b]">
            Open the launch wizard
          </a>
        </div>
      </TokenShell>
    );
  }

  const supplyPct = Math.min(100, Math.round((market.supply / market.cap) * 100));
  const overdue = subDaysLeft <= 0;
  const held = market.position?.tokens ?? 0;

  const banner = overdue ? (
    <div className="mb-5 flex items-center justify-between gap-3 rounded-[14px] border border-[#f6e2c4] bg-[#fdf6ec] px-5 py-3.5">
      <span className="text-[14px] font-semibold text-[#b45309]">Your listing has lapsed — renew to stay in discovery. Answering and cashing out still work.</span>
      <button onClick={() => renewSubscription(1)} className="rounded-[10px] bg-[#b45309] px-4 py-2 text-[13px] font-semibold text-white">Renew ~$10</button>
    </div>
  ) : null;

  return (
    <TokenShell>
      <div className="pt-[26px]">
        <div className="mb-1 flex items-center gap-3">
          <span className="h-11 w-11 rounded-[13px]" style={{ background: market.avatarColor }} />
          <div>
            <h1 className="font-serif text-2xl font-semibold text-[#161511]">Creator Studio</h1>
            <p className="text-[13.5px] text-[#6b7280]">Your token @{STUDIO_HANDLE} · your control room</p>
          </div>
        </div>

        {/* Section tabs */}
        <div className="mb-5 mt-4 flex flex-wrap gap-1.5 rounded-[14px] border border-[#ebedf0] bg-[#f4f5f7] p-[5px]">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`rounded-[9px] px-4 py-2 font-sans text-[14px] font-semibold transition-colors ${
                section === s.id ? 'bg-white text-[#161511] shadow-sm' : 'text-[#6b7280] hover:text-[#161511]'
              }`}
            >
              {s.label}
              {s.id === 'inbox' && inbox.length > 0 ? <span className="ml-1.5 rounded-full bg-[#c0392b] px-1.5 text-[11px] text-white">{inbox.length}</span> : null}
            </button>
          ))}
        </div>

        {banner}

        {section === 'overview' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card><Stat label="Token price" value={usdPrice(market.priceUsd)} sub={`Floor ${usdPrice(market.floorUsd)} · cap ${supplyPct}% used`} /></Card>
            <Card><Stat label="Market cap" value={usdWhole(market.marketCapUsd)} sub={`${market.supply.toLocaleString('en-US')} of ${market.cap.toLocaleString('en-US')} tokens`} /></Card>
            <Card><Stat label="Delivery" value={`${market.delivery.completionPct}%`} sub={`${market.delivery.answered}/${market.delivery.total} answered · ${market.delivery.typicalResponse}`} /></Card>
            <Card><Stat label="Subscription" value={overdue ? 'Lapsed' : `${subDaysLeft} days left`} sub={overdue ? 'Renew to stay listed' : `Renew ~$10`} /></Card>
            <Card><Stat label="Trade-fee share (claimable)" value={usdWhole(tradeFeeClaimableUsd)} green sub="Your 5% of the token’s trades" /></Card>
            <Card><Stat label="Requests waiting" value={String(inbox.length)} sub="In your Inbox" /></Card>
          </div>
        ) : null}

        {section === 'inbox' ? (
          <div className="flex flex-col gap-2.5">
            {inbox.length === 0 ? (
              <Card><p className="py-6 text-center font-serif text-sm text-[#9ca3af]">No requests waiting. Nice — you’re all caught up.</p></Card>
            ) : (
              inbox.map((a) => (
                <Card key={a.id} className={a.urgent ? 'border-[#f6e2c4] bg-[#fdf6ec]' : ''}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[14.5px] font-semibold text-[#161511]">{a.service}</div>
                    <div className={`text-[12.5px] font-semibold ${a.urgent ? 'text-[#b45309]' : 'text-[#6b7280]'}`}>{a.dueLabel}</div>
                  </div>
                  <div className="mt-1 text-[12.5px] tabular-nums text-[#6b7280]">{usdWhole(a.costUsd)} · {tok(a.tokens)} tokens escrowed</div>
                  <div className="mt-3">
                    <button onClick={() => setAnswering(a)} className="rounded-[10px] bg-[#c0392b] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#96271b]">Answer</button>
                  </div>
                </Card>
              ))
            )}
          </div>
        ) : null}

        {section === 'offerings' ? (
          <Card>
            <div className="mb-3 font-serif text-lg font-semibold text-[#161511]">Your services & prices</div>
            <p className="mb-4 text-[13px] text-[#6b7280]">Buyers pay these in your token at the live price. Set the dollar price — the token amount follows the market.</p>
            <div className="flex flex-col gap-3">
              {market.services.map((sv) => (
                <div key={sv.key} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e6e9] px-4 py-3">
                  <div>
                    <div className="text-[14px] font-semibold text-[#161511]">{sv.name}</div>
                    <div className="text-[12px] text-[#9ca3af]">≈ {tok(sv.usd / market.priceUsd)} tokens at today’s price</div>
                  </div>
                  <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3 py-2">
                    <span className="font-bold text-[#9ca3af]">$</span>
                    <PriceInput value={sv.usd} onCommit={(usd) => setServicePrice(sv.key, usd)} />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        {section === 'market' ? (
          <Card>
            <div className="flex items-end justify-between">
              <Stat label="Price" value={usdPrice(market.priceUsd)} sub={`Floor ${usdPrice(market.floorUsd)}`} />
              <Stat label="Market cap" value={usdWhole(market.marketCapUsd)} />
              <Stat label="Reserve" value={usdWhole(market.reserveUsd)} sub="Backs the floor" />
            </div>
            <div className="mt-5">
              <div className="mb-1 flex justify-between text-[12.5px] text-[#6b7280]"><span>Supply</span><span className="tabular-nums">{market.supply.toLocaleString('en-US')} / {market.cap.toLocaleString('en-US')}</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-[#f1f3f5]"><div className="h-full bg-[#c0392b]" style={{ width: `${supplyPct}%` }} /></div>
            </div>
            <div className="mt-5 flex items-center gap-2">
              <span className="text-[13px] text-[#6b7280]">Raise cap to</span>
              <input value={capInput} onChange={(e) => setCapInput(e.target.value)} inputMode="numeric" className="w-[110px] rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] font-semibold tabular-nums outline-none" />
              <button
                onClick={() => {
                  const v = parseInt(capInput.replace(/[^\d]/g, ''), 10);
                  if (Number.isFinite(v) && v >= Math.ceil(market.supply)) raiseCap(v);
                  else setCapInput(String(market.cap)); // revert a too-low / invalid entry
                }}
                className="rounded-[10px] bg-[#161511] px-4 py-2 text-[13px] font-semibold text-white"
              >
                Raise cap
              </button>
              <span className="text-[12px] text-[#9ca3af]">lower only down to {market.supply.toLocaleString('en-US')} issued</span>
            </div>
            <p className="mt-4 rounded-[10px] bg-[#f6f7f8] px-3.5 py-3 text-[12.5px] leading-[1.5] text-[#6b7280]">
              Your token’s price is set by the market — buys raise it, sells lower it. You don’t set the price; you set your <strong>service prices</strong> in dollars.
            </p>
          </Card>
        ) : null}

        {section === 'billing' ? (
          <Card>
            <div className="mb-1 font-serif text-lg font-semibold text-[#161511]">Subscription</div>
            <div className="mb-4 text-[14px] text-[#4b5563]">{overdue ? 'Lapsed — renew to stay listed.' : `Paid up · ${subDaysLeft} days left.`} Staying listed is ~$10/month. First month’s on the house.</div>
            <button onClick={() => renewSubscription(1)} className="rounded-[11px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#96271b]">Renew ~$10</button>
            <p className="mt-4 text-[12.5px] leading-[1.5] text-[#9ca3af]">
              If you stop paying, your token’s market winds down, holders are refunded at the floor, and your delivery record resets — coming back means a new token. Answering and cashing out are never blocked by billing.
            </p>
            <div className="mt-5 border-t border-[#f1f3f5] pt-4">
              <button disabled className="rounded-[10px] border border-[#e4e6e9] px-4 py-2 text-[13px] font-semibold text-[#9ca3af]">End this token · Coming soon</button>
            </div>
          </Card>
        ) : null}

        {section === 'earnings' ? (
          <div className="flex flex-col gap-4">
            <Card>
              <div className="flex items-center justify-between">
                <Stat label="Trade-fee share" value={usdWhole(tradeFeeClaimableUsd)} green sub="Your 5% of your token’s trades" />
                <button onClick={() => claimTradeFees()} disabled={tradeFeeClaimableUsd <= 0} className="rounded-[11px] bg-[#2f7d4f] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-[#276b43] disabled:opacity-50">
                  {tradeFeeClaimableUsd <= 0 ? 'Claimed' : 'Claim'}
                </button>
              </div>
            </Card>
            <Card><Stat label="Service commission" value={usdWhole(commissionEarnedUsd)} green sub="From answered requests" /></Card>
            <Card>
              <Stat label="Your own holdings" value={`${tok(held)} tokens`} sub={`worth ${usdPrice(held * market.priceUsd)} · floor ${usdPrice(held * market.floorUsd)}`} />
              <div className="mt-4 flex items-center gap-2">
                <span className="text-[13px] text-[#6b7280]">Cash out</span>
                <input value={sellInput} onChange={(e) => setSellInput(e.target.value)} placeholder="tokens" inputMode="decimal" className="w-[110px] rounded-[10px] border border-[#e4e6e9] px-3 py-2 text-[14px] font-semibold tabular-nums outline-none" />
                <button
                  onClick={() => {
                    const n = parseFloat(sellInput.replace(/,/g, ''));
                    if (Number.isFinite(n) && n > 0) {
                      sell(STUDIO_HANDLE, n);
                      setSellInput('');
                    }
                  }}
                  className="rounded-[10px] bg-[#161511] px-4 py-2 text-[13px] font-semibold text-white"
                >
                  Sell
                </button>
              </div>
              <p className="mt-3 text-[12px] leading-[1.5] text-[#9ca3af]">Selling your own tokens returns them to dollars at the market price — it doesn’t affect anyone else’s floor. Never blocked by billing.</p>
            </Card>
          </div>
        ) : null}
      </div>

      {answering ? <AnswerModal ask={answering} onClose={() => setAnswering(null)} /> : null}
    </TokenShell>
  );
};

export default CreatorStudio;
