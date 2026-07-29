'use client';

import { FC, ReactNode, useState } from 'react';
import type { Service } from '../../market/token-detail';
import type { LiveTokenMarket } from '../../live/adapt';
import { buyQuote, sellQuote, serviceQuote, EXIT_FEE_MAX } from '../../market/curve';
import { usdPrice, usdWhole } from '../../market/format';
import { writeFailureMessage } from '../write-failure';

export type TokenDialog = 'buy' | 'sell' | 'redeem' | 'ask' | 'send' | 'inter' | null;

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

const BuyModal: FC<{ m: LiveTokenMarket; onBuy: (usd: number, maxTotalUsd?: number) => Promise<void>; onClose: () => void }> = ({ m, onBuy, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [amt, setAmt] = useState('50');
  const [adv, setAdv] = useState(false);
  const [maxPrice, setMaxPrice] = useState((m.priceUsd * 1.05).toFixed(2));
  const [failure, setFailure] = useState<string | null>(null);
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
              setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
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
                setFailure(null);
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
          onClick={async () => {
            if (!Number.isFinite(usd) || usd <= 0 || overMax || busy) return;
            // The action is a real broadcast now, not a synchronous store
            // mutation: it opens a signer, waits, and can be REJECTED by the
            // user or the chain. Close only after it resolves — closing early
            // would tell someone their money moved while the signer is still
            // open, which is the exact lie this rewiring exists to remove.
            setBusy(true);
            setFailure(null);
            try {
              await onBuy(usd, maxTotalUsd);
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That buy didn’t go through.'));
            } finally {
              setBusy(false);
            }
          }}
          disabled={!Number.isFinite(usd) || usd <= 0 || overMax || busy}
          className="w-full rounded-[13px] bg-[#c0392b] py-[15px] text-[15px] font-bold text-white hover:bg-[#a5301f] disabled:opacity-50"
        >
          {busy ? 'Confirm in your wallet…' : `Buy — ${usdWhole(usd)}`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            {failure}
          </div>
        ) : null}
        <div className="mt-2.5 text-center text-xs text-[#9ca3af]">One signature confirms your buy.</div>
      </div>
    </ModalShell>
  );
};

/**
 * Doubles as the REDEEM dialog when `mode === 'redeem'`.
 *
 * The two rails are genuinely different contract calls — sell.go Sell walks the
 * curve, refund.go Refund pays a pro-rata slice of the reserve — but from a
 * holder's point of view they are the same act ("give me my money for N tokens"),
 * and once a market is winding down only ONE of them works. Sharing the dialog
 * means the wind-down path cannot drift out of sync with the normal one, which is
 * how it came to be missing entirely.
 */
const SellModal: FC<{
  m: LiveTokenMarket;
  onSell: (tokens: number) => Promise<void>;
  onClose: () => void;
  mode?: 'sell' | 'redeem';
}> = ({ m, onSell, onClose, mode = 'sell' }) => {
  const redeem = mode === 'redeem';
  const [busy, setBusy] = useState(false);
  const held = m.position?.tokens ?? 0;
  const [amt, setAmt] = useState(String(held || 0));
  const [failure, setFailure] = useState<string | null>(null);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const q = sellQuote(tokens, m, m.position?.heldDays ?? 999);
  const feePctLabel = Math.round(q.exitFeePct * 100);
  // REDEEM amount, derived from the position's own already-taxed floor value and
  // scaled pro rata (the slice is linear in tokens; the tax rate does not vary
  // with size). This is the ONLY figure we have for this rail — we do NOT have a
  // gross, so redeem mode shows one honest number instead of a breakdown whose
  // rows would have to be invented.
  const redeemUsd = redeem && held > 0 ? ((m.position?.floorValueUsd ?? 0) * tokens) / held : 0;
  return (
    <ModalShell width={460} onClose={onClose}>
      <ModalHead title={redeem ? `Redeem @${m.handle} token` : `Sell @${m.handle} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <div className="mb-[7px] flex items-center justify-between">
          <label className="text-[12.5px] font-semibold text-[#6b7280]">Amount (tokens)</label>
          <button onClick={() => setAmt(String(held))} className="border-0 bg-transparent text-[12.5px] font-semibold text-[#c0392b]">
            {redeem ? 'Redeem all' : 'Sell all'} ({tok(held)})
          </button>
        </div>
        <div className="mb-3.5 flex items-center rounded-xl border border-[#e4e6e9] px-4 py-3">
          <input
            value={amt}
            onChange={(e) => {
              setAmt(e.target.value);
              setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
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
          {/* CURVE-RAIL ROWS ONLY. In redeem mode the curve is closed, so a
              "Curve proceeds" figure describes a rail that cannot execute, and the
              exit fee shown as a DOLLAR amount is computed off that same wrong
              basis. Both were left ungated in the first pass of this change and
              produced three numbers on screen that did not reconcile with each
              other or with the button. The exit-tax RATE strip above stays: that
              rate genuinely applies to both doors (see Market position exitTaxBps). */}
          {redeem ? null : (
            <>
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
            </>
          )}
          {/* The 10% trade fee is a CURVE-rail charge (sell.go). The wind-down
              rail (refund.go) is a pro-rata slice of the reserve and does not pay
              it, so showing it here would be inventing a deduction. */}
          {redeem ? null : (
            <div className="mb-2 flex justify-between text-[13px] text-[#b45309]">
              <span>Trade fee (10%)</span>
              <span>−{usdPrice(q.tradeFeeUsd)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-[#f1f3f5] pt-2 text-[15px]">
            <span className="font-bold">You receive</span>
            {/* Redeem: derived from the position's own already-taxed floor value,
                scaled pro rata — the slice is linear in tokens and the tax rate is
                the same at any size. Marked approximate because the contract
                recomputes it at execution from the live clock, and we will not
                print an exact figure we cannot guarantee. */}
            <span className="font-bold text-[#2f7d4f]">
              {redeem ? `≈ ${usdPrice(redeemUsd)}` : usdPrice(q.receiveUsd)}
            </span>
          </div>
        </div>
        <button
          onClick={async () => {
            if (!Number.isFinite(tokens) || tokens <= 0 || busy) return;
            setBusy(true);
            setFailure(null);
            try {
              await onSell(tokens);
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That sell didn’t go through.'));
            } finally {
              setBusy(false);
            }
          }}
          disabled={!Number.isFinite(tokens) || tokens <= 0 || held <= 0 || tokens > held || busy}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-bold text-white hover:bg-black disabled:opacity-50"
        >
          {busy
            ? 'Confirm in your wallet…'
            : tokens > held
              ? 'More than you hold'
              : redeem
                ? `Redeem — get ~${usdPrice(redeemUsd)}`
                : `Sell — get ~${usdPrice(q.receiveUsd)}`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            {failure}
          </div>
        ) : null}
        {/* This used to read "Selling is always available — even if this market
            winds down", which is false: sell() throws once the market is
            retired/frozen/closed. The honest statement is that an EXIT is always
            available — via this dialog's redeem mode, which is what the page
            routes to in that state. */}
        <div className="mt-2.5 text-center text-xs text-[#9ca3af]">
          {redeem
            ? 'Redeeming pays your share of the reserve at the floor. Available even while this market winds down.'
            : 'You can always exit — while this market is open by selling, and once it winds down by redeeming at the floor.'}
        </div>
      </div>
    </ModalShell>
  );
};

const AskModal: FC<{
  m: LiveTokenMarket;
  service: Service | null;
  /** offeringId is Service.key — the creator's named service, or '0' for their legacy face price. Passing it is what makes the shop actually buyable. */
  onSpend: (input: { offeringId: number; usd: number; deadlineDays: number; question: string }) => Promise<void>;
  onClose: () => void;
}> = ({ m, service, onSpend, onClose }) => {
  const [busy, setBusy] = useState(false);
  const [deadline, setDeadline] = useState(7);
  const [question, setQuestion] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
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
          onClick={async () => {
            if (!canAffordTokens || busy) return;
            setBusy(true);
            setFailure(null);
            try {
              // Service.key IS the on-chain offeringId ('0' = the creator's
              // legacy face price). Dropping it here would silently charge the
              // generic face price for a named service.
              await onSpend({ offeringId: Number(service?.key ?? 0), usd, deadlineDays: deadline, question });
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That request didn’t go through.'));
            } finally {
              setBusy(false);
            }
          }}
          disabled={!canAffordTokens || busy}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-semibold text-white hover:bg-black disabled:opacity-50"
        >
          {busy
            ? 'Confirm in your wallet…'
            : canAffordTokens
              ? `Send question — ${tok(q.tokens)} tokens + ${usdPrice(q.commissionUsd)} HBD`
              : `You need ${tok(q.tokens)} @${m.handle} tokens — buy some first`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            {failure}
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
};

const SendModal: FC<{ m: LiveTokenMarket; onTransfer: (to: string, tokens: number) => Promise<void>; onClose: () => void }> = ({ m, onTransfer, onClose }) => {
  const [busy, setBusy] = useState(false);
  const held = m.position?.tokens ?? 0;
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
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
            setFailure(null);
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
            setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
          }}
          inputMode="decimal"
          placeholder="0"
          className="mb-3.5 w-full rounded-xl border border-[#e4e6e9] px-4 py-3 text-[22px] font-bold tabular-nums text-[#161511] outline-none"
        />
        <button
          onClick={async () => {
            if (!valid || busy) return;
            setBusy(true);
            setFailure(null);
            try {
              // ★ The RECIPIENT is passed now. It was collected by the input
              // above and then DROPPED — onTransfer only ever received the
              // amount, so a real send would have gone nowhere or to the wrong
              // account. Strip a leading '@': the field invites one, the chain
              // account name never has one.
              await onTransfer(to.trim().replace(/^@/, ''), tokens);
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That send didn’t go through.'));
            } finally {
              setBusy(false);
            }
          }}
          disabled={!valid || busy}
          className="w-full rounded-[13px] bg-[#1a1a17] py-[15px] text-[15px] font-bold text-white hover:bg-black disabled:opacity-50"
        >
          {busy ? 'Confirm in your wallet…' : tokens > held ? 'More than you hold' : `Send ${tok(tokens)} tokens`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-[12.5px] font-semibold text-[#c0392b]">
            {failure}
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

/**
 * Every action here RESOLVES on success and REJECTS on failure — a rejected
 * signer prompt, an insufficient balance, a chain refusal. The modals close on
 * resolve only. They used to take synchronous booleans from the demo store;
 * with a real broadcast behind them, "did it work" is not knowable at call
 * time, and treating it as if it were is how a user gets told their money moved
 * when it did not.
 */
const TokenModals: FC<{
  dialog: TokenDialog;
  market: LiveTokenMarket;
  service: Service | null;
  onBuy: (usd: number, maxTotalUsd?: number) => Promise<void>;
  onSell: (tokens: number) => Promise<void>;
  /** refund.go Refund — the pro-rata exit, and the only rail that works once the market winds down. */
  onRedeem: (tokens: number) => Promise<void>;
  onSpend: (input: { offeringId: number; usd: number; deadlineDays: number; question: string }) => Promise<void>;
  onTransfer: (to: string, tokens: number) => Promise<void>;
  onClose: () => void;
}> = ({ dialog, market, service, onBuy, onSell, onRedeem, onSpend, onTransfer, onClose }) => {
  if (dialog === 'buy') return <BuyModal m={market} onBuy={onBuy} onClose={onClose} />;
  if (dialog === 'sell') return <SellModal m={market} onSell={onSell} onClose={onClose} />;
  // The wind-down exit. Same dialog, refund.go behind it instead of sell.go.
  if (dialog === 'redeem') return <SellModal m={market} onSell={onRedeem} onClose={onClose} mode="redeem" />;
  if (dialog === 'ask') return <AskModal m={market} service={service} onSpend={onSpend} onClose={onClose} />;
  if (dialog === 'send') return <SendModal m={market} onTransfer={onTransfer} onClose={onClose} />;
  if (dialog === 'inter') return <InterstitialModal handle={market.handle} onClose={onClose} />;
  return null;
};

export default TokenModals;
