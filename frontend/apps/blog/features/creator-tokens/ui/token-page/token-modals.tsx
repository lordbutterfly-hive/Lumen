'use client';

import { FC, ReactNode, useState } from 'react';
import type { Service, TokenMarketDetail } from '../../market/token-detail';
import { buyQuote, sellQuote, serviceQuote, EXIT_FEE_MAX } from '../../market/curve';
import { usdPrice, usdWhole } from '../../market/format';

export type TokenDialog = 'buy' | 'sell' | 'ask' | 'send' | 'inter' | null;

const ModalShell: FC<{ width: number; onClose: () => void; children: ReactNode }> = ({ width, onClose, children }) => (
  <div
    onClick={onClose}
    className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-[rgba(20,18,10,0.4)] p-5 py-12 backdrop-blur-[2px]"
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ width }}
      className="max-w-full rounded-[20px] bg-white shadow-[0_20px_60px_rgba(20,18,10,0.25)]"
    >
      {children}
    </div>
  </div>
);

const ModalHead: FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div className="flex items-center justify-between px-6 pt-[22px]">
    <div className="font-serif text-[21px] font-semibold text-[#161511]">{title}</div>
    <button onClick={onClose} className="cursor-pointer border-0 bg-transparent text-[22px] text-[#9ca3af]">
      ×
    </button>
  </div>
);

const tok = (n: number) => n.toFixed(2);

const BuyModal: FC<{ m: TokenMarketDetail; onBuy: (usd: number, maxTotalUsd?: number) => boolean; onClose: () => void }> = ({ m, onBuy, onClose }) => {
  const [amt, setAmt] = useState('50');
  const [adv, setAdv] = useState(false);
  const [maxPrice, setMaxPrice] = useState((m.priceUsd * 1.05).toFixed(2));
  const [failed, setFailed] = useState(false);
  const usd = parseFloat(amt.replace(/,/g, '')) || 0; // strip thousands separators ("1,000" → 1000, not 1)
  const q = buyQuote(usd, m);
  const maxP = parseFloat(maxPrice.replace(/,/g, ''));
  const overMax = adv && Number.isFinite(maxP) && maxP > 0 && q.priceAfter > maxP; // slippage guard
  // The "max price per token" cap, converted to a TOTAL-cost bound for the
  // quoted count — buy.go's own doc: "slippage protection is the buyer's own
  // signed transfer.allow" on TotalDue, not on a per-token price the chain
  // never receives as such. Threading this through is what makes the control
  // mean something once buy() is wired to a real chain call (previously it
  // only disabled this button locally and was never passed to onBuy at all).
  const maxTotalUsd = adv && Number.isFinite(maxP) && maxP > 0 && q.tokens > 0 ? maxP * q.tokens : undefined;
  return (
    <ModalShell width={460} onClose={onClose}>
      <ModalHead title={`Buy @${m.handle} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <label className="mb-[7px] block text-[12.5px] font-semibold text-[#6b7280]">Amount (USD)</label>
        <div className="mb-2.5 flex items-center rounded-xl border border-[#e4e6e9] px-4 py-3">
          <span className="text-[22px] font-bold text-[#161511]">$</span>
          <input
            value={amt}
            onChange={(e) => {
              setAmt(e.target.value);
              setFailed(false); // a fresh amount deserves a fresh attempt, not a stale error
            }}
            inputMode="decimal"
            className="ml-0.5 flex-1 border-0 text-[22px] font-bold tabular-nums text-[#161511] outline-none"
          />
        </div>
        <div className="mb-4 flex gap-2">
          {['10', '25', '100'].map((v) => (
            <button
              key={v}
              onClick={() => {
                setAmt(v);
                setFailed(false);
              }}
              className="flex-1 rounded-[9px] border border-[#e4e6e9] py-2 text-[13px] font-semibold text-[#3f4650] hover:border-[#c0392b] hover:text-[#c0392b]"
            >
              ${v}
            </button>
          ))}
        </div>
        <div className="mb-3.5 rounded-xl border border-[#ebebeb] bg-[#faf9f6] px-4 py-3.5 tabular-nums">
          <div className="text-[15px] font-bold text-[#161511]">≈ {tok(q.tokens)} tokens</div>
          <div className="mt-2 flex justify-between text-[12.5px] text-[#6b7280]">
            <span>Average price</span>
            <span>~{usdPrice(q.avgPrice)} each</span>
          </div>
          <div className="mt-1 flex justify-between text-[12.5px] text-[#6b7280]">
            <span>Price after your buy</span>
            <span>~{usdPrice(q.priceAfter)}</span>
          </div>
        </div>
        <button onClick={() => setAdv((v) => !v)} className="mb-3 flex items-center gap-1.5 border-0 bg-transparent text-[12.5px] font-semibold text-[#6b7280]">
          Advanced {adv ? '▴' : '▾'}
        </button>
        {adv ? (
          <div className="mb-3.5">
            <label className="mb-1.5 block text-xs text-[#6b7280]">Max price per token</label>
            <div className="flex items-center rounded-[10px] border border-[#e4e6e9] px-3.5 py-2.5">
              <span className="font-bold text-[#9ca3af]">$</span>
              <input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} inputMode="decimal" className="ml-0.5 flex-1 border-0 text-[15px] font-semibold tabular-nums outline-none" />
            </div>
            <div className="mt-1.5 text-[11.5px] text-[#9ca3af]">Don’t buy above this — the curve moves as others trade.</div>
            {overMax ? (
              <div className="mt-1.5 text-[11.5px] font-semibold text-[#b45309]">Your buy would push the price to {usdPrice(q.priceAfter)}, above your max — lower the amount or raise the cap.</div>
            ) : null}
          </div>
        ) : null}
        <div className="mb-3 rounded-[10px] bg-[#f6f7f8] px-3.5 py-3 text-[12.5px] leading-[1.5] text-[#6b7280]">
          Includes a 10% trade fee (5% to @{m.handle}, 5% to Lumen).
        </div>
        <p className="mb-3.5 font-serif text-[12.5px] leading-[1.55] text-[#9ca3af]">
          This token’s price floats. The floor ({usdPrice(m.floorUsd)}) is the least you’re guaranteed back; sell soon after
          buying and an early-exit fee applies.
        </p>
        <button
          onClick={() => {
            if (Number.isFinite(usd) && usd > 0 && !overMax) {
              // onBuy reports whether the buy actually executed (defect fix:
              // this used to close unconditionally, as if a cap-refused or
              // wound-down buy had succeeded) — only close on a real success.
              const ok = onBuy(usd, maxTotalUsd);
              if (ok) onClose();
              else setFailed(true);
            }
          }}
          disabled={!Number.isFinite(usd) || usd <= 0 || overMax}
          className="w-full rounded-[13px] bg-[#c0392b] py-[15px] text-[15px] font-bold text-white hover:bg-[#a5301f] disabled:opacity-50"
        >
          Buy — {usdWhole(usd)}
        </button>
        {failed ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            That buy didn’t go through — the market may be at its cap or winding down. Try a smaller amount.
          </div>
        ) : null}
        <div className="mt-2.5 text-center text-xs text-[#9ca3af]">One signature confirms your buy.</div>
      </div>
    </ModalShell>
  );
};

const SellModal: FC<{ m: TokenMarketDetail; onSell: (tokens: number) => boolean; onClose: () => void }> = ({ m, onSell, onClose }) => {
  const held = m.position?.tokens ?? 0;
  const [amt, setAmt] = useState(String(held || 0));
  const [failed, setFailed] = useState(false);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const q = sellQuote(tokens, m, m.position?.heldDays ?? 999);
  const feePctLabel = Math.round(q.exitFeePct * 100);
  return (
    <ModalShell width={460} onClose={onClose}>
      <ModalHead title={`Sell @${m.handle} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <div className="mb-[7px] flex items-center justify-between">
          <label className="text-[12.5px] font-semibold text-[#6b7280]">Amount (tokens)</label>
          <button onClick={() => setAmt(String(held))} className="border-0 bg-transparent text-[12.5px] font-semibold text-[#c0392b]">
            Sell all ({tok(held)})
          </button>
        </div>
        <div className="mb-3.5 flex items-center rounded-xl border border-[#e4e6e9] px-4 py-3">
          <input
            value={amt}
            onChange={(e) => {
              setAmt(e.target.value);
              setFailed(false); // a fresh amount deserves a fresh attempt, not a stale error
            }}
            inputMode="decimal"
            className="flex-1 border-0 text-[22px] font-bold tabular-nums text-[#161511] outline-none"
          />
          <span className="text-[13px] font-semibold text-[#9ca3af]">tokens</span>
        </div>
        {q.exitFeePct > 0 ? (
          <div className="mb-3.5 rounded-xl border border-[#f6e2c4] bg-[#fdf6ec] px-4 py-3.5">
            <div className="mb-1.5 text-[13.5px] font-bold text-[#b45309]">Early-exit fee: {feePctLabel}% now</div>
            <p className="mb-2.5 text-[12.5px] leading-[1.5] text-[#8a5a20]">
              You’ve held these ~{m.position?.heldDays ?? 0} days. The fee drops to 0% if you hold ~6 weeks.
            </p>
            <div className="h-1.5 overflow-hidden rounded bg-[#f4e3c8]">
              {/* Was a leftover 0.15 (the OLD, pre-curve 15% max) — reads as
                  maxed-out for the first quarter of the real 20% decay.
                  EXIT_FEE_MAX is the real, exported maximum (params.go
                  MaxExitTaxBps). */}
              <div className="h-full bg-[#b45309]" style={{ width: `${(q.exitFeePct / EXIT_FEE_MAX) * 100}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-[#b45309]">
              <span>{feePctLabel}% now</span>
              <span>0% at 6 wks</span>
            </div>
          </div>
        ) : null}
        <div className="mb-3.5 rounded-xl border border-[#ebebeb] px-4 py-3.5 tabular-nums">
          <div className="mb-1.5 flex justify-between text-[13px] text-[#3f4650]">
            <span>Curve proceeds</span>
            <span>{usdPrice(q.curveProceedsUsd)}</span>
          </div>
          {q.exitFeeUsd > 0 ? (
            <div className="mb-1.5 flex justify-between text-[13px] text-[#b45309]">
              <span>Early-exit fee ({feePctLabel}%)</span>
              <span>−{usdPrice(q.exitFeeUsd)}</span>
            </div>
          ) : null}
          <div className="mb-2 flex justify-between text-[13px] text-[#b45309]">
            <span>Trade fee (10%)</span>
            <span>−{usdPrice(q.tradeFeeUsd)}</span>
          </div>
          <div className="flex justify-between border-t border-[#f1f3f5] pt-2 text-[15px]">
            <span className="font-bold">You receive</span>
            <span className="font-bold text-[#2f7d4f]">{usdPrice(q.receiveUsd)}</span>
          </div>
        </div>
        <button
          onClick={() => {
            if (Number.isFinite(tokens) && tokens > 0) {
              // onSell reports whether the sell actually executed (defect fix:
              // this used to close unconditionally, as if a nothing-held or
              // sub-1-token sell had succeeded) — only close on a real success.
              const ok = onSell(tokens);
              if (ok) onClose();
              else setFailed(true);
            }
          }}
          disabled={!Number.isFinite(tokens) || tokens <= 0 || held <= 0 || tokens > held}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-bold text-white hover:bg-black disabled:opacity-50"
        >
          {tokens > held ? 'More than you hold' : `Sell — get ~${usdPrice(q.receiveUsd)}`}
        </button>
        {failed ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            That sell didn’t go through — your held balance may have changed. Try a smaller amount.
          </div>
        ) : null}
        <div className="mt-2.5 text-center text-xs text-[#9ca3af]">Selling is always available — even if this market winds down.</div>
      </div>
    </ModalShell>
  );
};

const AskModal: FC<{
  m: TokenMarketDetail;
  service: Service | null;
  onSpend: (usd: number, serviceName?: string, deadlineDays?: number, question?: string) => boolean;
  onClose: () => void;
}> = ({ m, service, onSpend, onClose }) => {
  const [deadline, setDeadline] = useState(7);
  const [question, setQuestion] = useState('');
  const [failed, setFailed] = useState(false);
  const usd = service?.usd ?? 10;
  // USER RULING 2026-07-27: the posted USD price is the buyer's TOTAL — 12%
  // is a SEPARATE HBD platform commission, never tokens (ask.go splitFace).
  const q = serviceQuote(usd, m.priceUsd);
  const held = m.position?.tokens ?? 0;
  // This mock has no HBD wallet balance to check — a real, wallet-connected
  // build MUST also verify the buyer can cover q.commissionUsd in HBD
  // (ask.go's commissionHbdPaid leg) before enabling this button; this only
  // proves the TOKEN leg is affordable. Never let "canAfford" quietly mean
  // "affords the tokens" once a real HBD balance exists to check — see
  // ask.go's Ask() guard order (maxCredits, then the exact commission match).
  const canAffordTokens = held >= q.tokens && Number.isFinite(q.tokens);
  return (
    <ModalShell width={500} onClose={onClose}>
      <ModalHead title={`Ask @${m.handle}`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={`What do you want to ask @${m.handle}?`}
          className="h-[120px] w-full resize-y rounded-xl border border-[#e4e6e9] px-4 py-3.5 font-serif text-[15px] leading-[1.5] text-[#161511] outline-none focus:border-[#c0392b]"
        />
        <div className="my-2 mb-3.5 text-xs text-[#9ca3af]">Private — stored on Lumen, only its fingerprint goes on-chain.</div>
        <div className="mb-4 rounded-xl border border-[#ebebeb] px-4 py-3.5 text-[14px] leading-[1.55] text-[#3f4650]">
          This costs <strong className="tabular-nums text-[#161511]">{tok(q.tokens)} tokens</strong> from your balance, plus
          a separate <strong className="tabular-nums text-[#161511]">{usdPrice(q.commissionUsd)}</strong> platform
          commission paid in HBD — {usdWhole(usd)} total. If unanswered within your deadline, you get it all back.
        </div>
        <label className="mb-2 block text-[12.5px] font-semibold text-[#6b7280]">Answer due within</label>
        <div className="mb-4 flex items-center gap-3.5">
          <input
            type="range"
            min={2}
            max={30}
            value={deadline}
            onChange={(e) => setDeadline(Number(e.target.value))}
            className="flex-1 accent-[#c0392b]"
          />
          <span className="w-[70px] text-right text-[14px] font-bold tabular-nums text-[#161511]">{deadline} days</span>
        </div>
        <button
          onClick={() => {
            if (canAffordTokens) {
              // onSpend reports whether the ask actually opened (defect fix:
              // this used to close unconditionally, as if a wound-down market
              // or a stale balance check had succeeded) — only close on a real success.
              const ok = onSpend(usd, service?.name, deadline, question);
              if (ok) onClose();
              else setFailed(true);
            }
          }}
          disabled={!canAffordTokens}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-semibold text-white hover:bg-black disabled:opacity-50"
        >
          {canAffordTokens
            ? `Send question — ${tok(q.tokens)} tokens + ${usdPrice(q.commissionUsd)} HBD`
            : `You need ${tok(q.tokens)} @${m.handle} tokens — buy some first`}
        </button>
        {failed ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            That ask didn’t go through — this market may have just closed to new asks, or your token balance changed. Try again.
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
};

const SendModal: FC<{ m: TokenMarketDetail; onTransfer: (tokens: number) => boolean; onClose: () => void }> = ({ m, onTransfer, onClose }) => {
  const held = m.position?.tokens ?? 0;
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [failed, setFailed] = useState(false);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const valid = to.trim().length > 0 && Number.isFinite(tokens) && tokens > 0 && tokens <= held;
  return (
    <ModalShell width={420} onClose={onClose}>
      <ModalHead title={`Send @${m.handle} tokens`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <label className="mb-1.5 block text-[12.5px] font-semibold text-[#6b7280]">To (Lumen or Hive name)</label>
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setFailed(false);
          }}
          placeholder="@name"
          className="mb-3.5 w-full rounded-xl border border-[#e4e6e9] px-4 py-3 text-[15px] font-semibold text-[#161511] outline-none"
        />
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[12.5px] font-semibold text-[#6b7280]">Amount (tokens)</label>
          <button onClick={() => setAmt(String(held))} className="border-0 bg-transparent text-[12.5px] font-semibold text-[#c0392b]">Max ({tok(held)})</button>
        </div>
        <input
          value={amt}
          onChange={(e) => {
            setAmt(e.target.value);
            setFailed(false); // a fresh amount deserves a fresh attempt, not a stale error
          }}
          inputMode="decimal"
          placeholder="0"
          className="mb-3.5 w-full rounded-xl border border-[#e4e6e9] px-4 py-3 text-[22px] font-bold tabular-nums text-[#161511] outline-none"
        />
        <button
          onClick={() => {
            if (valid) {
              // onTransfer reports whether the send actually executed (defect
              // fix: this used to close unconditionally, as if the store had
              // clamped a too-large amount down to whatever you held and sent
              // that instead — it now refuses rather than sending less than
              // you typed) — only close on a real success.
              const ok = onTransfer(tokens);
              if (ok) onClose();
              else setFailed(true);
            }
          }}
          disabled={!valid}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-bold text-white hover:bg-black disabled:opacity-50"
        >
          {tokens > held ? 'More than you hold' : `Send ${tok(tokens)} tokens`}
        </button>
        {failed ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            That send didn’t go through — your held balance may have changed. Try a smaller amount.
          </div>
        ) : null}
        <div className="mt-2.5 text-center text-xs text-[#9ca3af]">Transfers are free and instant on Lumen. Never blocked by billing.</div>
      </div>
    </ModalShell>
  );
};

const InterstitialModal: FC<{ handle: string; onClose: () => void }> = ({ onClose }) => (
  <ModalShell width={480} onClose={onClose}>
    <div className="px-6 py-[26px]">
      <div className="mb-[18px] font-serif text-[22px] font-semibold text-[#161511]">Before you trade this token</div>
      <div className="mb-[22px] flex flex-col gap-3.5">
        {[
          'This is a real token whose price goes up and down.',
          'If you buy from the market above the floor, you can get back less than you paid.',
          'The floor is the least you’re guaranteed back, shown next to the price.',
          'Selling soon after buying has an early-exit fee that fades to zero over 6 weeks.'
        ].map((line, i) => (
          <p key={i} className="font-serif text-[14px] leading-[1.55] text-[#3f4650]">
            {line}
          </p>
        ))}
      </div>
      <div className="flex gap-3">
        <button onClick={onClose} className="flex-1 rounded-xl bg-[#1a1a17] py-3.5 text-[14.5px] font-semibold text-white hover:bg-black">
          I understand — show the market
        </button>
      </div>
    </div>
  </ModalShell>
);

const TokenModals: FC<{
  dialog: TokenDialog;
  market: TokenMarketDetail;
  service: Service | null;
  /** Returns whether the buy actually executed — see market/store.ts's buy() doc. */
  onBuy: (usd: number, maxTotalUsd?: number) => boolean;
  /** Returns whether the sell actually executed — see market/store.ts's sell() doc. */
  onSell: (tokens: number) => boolean;
  /** Returns whether the ask actually opened — see market/store.ts's spend() doc. */
  onSpend: (usd: number, serviceName?: string, deadlineDays?: number, question?: string) => boolean;
  /** Returns whether the transfer actually executed — see market/store.ts's transferTokens() doc. */
  onTransfer: (tokens: number) => boolean;
  onClose: () => void;
}> = ({ dialog, market, service, onBuy, onSell, onSpend, onTransfer, onClose }) => {
  if (dialog === 'buy') return <BuyModal m={market} onBuy={onBuy} onClose={onClose} />;
  if (dialog === 'sell') return <SellModal m={market} onSell={onSell} onClose={onClose} />;
  if (dialog === 'ask') return <AskModal m={market} service={service} onSpend={onSpend} onClose={onClose} />;
  if (dialog === 'send') return <SendModal m={market} onTransfer={onTransfer} onClose={onClose} />;
  if (dialog === 'inter') return <InterstitialModal handle={market.handle} onClose={onClose} />;
  return null;
};

export default TokenModals;
