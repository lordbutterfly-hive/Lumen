'use client';

import { FC, useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Service } from '../../market/token-detail';
import { displayHandle, type LiveTokenMarket } from '../../live/adapt';
import { buyQuote, minBuyUsd, sellQuote, serviceQuote, EXIT_FEE_MAX, MIN_NET_DEFAULT_TOLERANCE_BPS } from '../../market/curve';
// usdWhole is gone from this file: the Ask card's posted price is now exact
// (usdPrice), which is what makes the whole-token overshoot checkable.
import { pctLabel, usdPrice } from '../../market/format';
import { writeFailureMessage } from '../write-failure';
import { useTokenAccounts } from '../../live/use-token-accounts';
import { useMagiSpendingPower } from '../../live/use-magi-spending-power';
import { MagiFuelGauge, MagiFundingHelp } from '../../live/magi-fuel-gauge';
import ModalShell from '../modal-shell';
import { sellEmptyStateMessage } from './sell-empty-state';
import { buyerOracleNotice } from '../../market/oracle-copy';
import type { Quote } from '../../types';
// ★★★ THE DIALOGS' CLAIMS ABOUT MONEY (2026-08-27). Same reason
// sell-empty-state.ts exists: this is a `'use client'` tree, so a sentence
// written inline is a sentence no test can read. disclosure-copy.ts's header
// carries the live figures each rewrite was reproduced against.
import { backingPerTokenValue, buyRiskNote, exitRoutesNote, interstitialLines } from './disclosure-copy';
// ★★★ THE DIALOGS' ARITHMETIC, FOR THE SAME REASON (2026-08-27). A number
// computed inline in a `'use client'` tree is a number no test can read, and
// every defect this module was extracted for was a number: a partial redeem
// scaled linearly against a split-aware net (F-A), a price cap compared on the
// wrong basis (F-C), an ask total that ignored the whole-token ceiling (F-D),
// an itemisation whose rows did not sum (F-G). Each function carries the live
// figures it was reproduced against.
import {
  acceptAmountText,
  askCost,
  buyCeilingNote,
  buyRows,
  defaultMaxPriceText,
  effectiveExitFeePct,
  exitFeeBaseNote,
  parseAmount,
  askCostSegments,
  redeemQuote,
  resolveMaxPriceCap,
  sellRows
} from './trade-preview';

export type TokenDialog = 'buy' | 'sell' | 'redeem' | 'ask' | 'send' | 'inter' | null;

const ModalHead: FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div className="flex items-center justify-between px-6 pt-[22px]">
    <div className="font-serif text-[22px] leading-[32px] font-semibold text-ink-2">{title}</div>
    <button
      onClick={onClose}
      aria-label="Close"
      className="-my-2 -mx-4 cursor-pointer rounded-lg border-0 bg-transparent px-4 py-2 text-[22px] leading-[34px] text-ink-14 hover:bg-surface-16"
    >
      ×
    </button>
  </div>
);

const tok = (n: number) => n.toFixed(2);

const BuyModal: FC<{
  m: LiveTokenMarket;
  onBuy: (usd: number, maxTotalUsd?: number) => Promise<void>;
  onClose: () => void;
}> = ({ m, onBuy, onClose }) => {
  const [busy, setBusy] = useState(false);
  // F7 fix: `busy` is a useState value — it only updates on the NEXT render,
  // so two clicks in the same tick (a fast double-click) both read
  // busy===false and both broadcast. A ref mutates synchronously, so the
  // second invocation in the same tick sees what the first already set,
  // before either has awaited anything. Mirrors
  // ui/meritum/launch/use-meritum-launch.ts's inFlight ref, the one guard in
  // this feature that was already correct. `busy` stays — it still drives
  // the disabled attribute and the "Confirm in your wallet…" label.
  const inFlight = useRef(false);
  const [amt, setAmt] = useState('50');
  const [adv, setAdv] = useState(false);
  /**
   * ★ THE CAP IS PRE-FILLED FROM THE LIVE QUOTE, NOT FROZEN AT MOUNT
   * (2026-08-27, F-C). It used to be `useState((m.priceUsd * 1.05).toFixed(2))`:
   * a bare CURVE spot price, captured once, that then stopped describing the
   * amount actually being bought. Same `touched` idiom the sell dialog's
   * minimum-net floor already uses — the default tracks the quote until the
   * reader edits it, and an edit (including clearing the field) is theirs to
   * keep. See resolveMaxPriceCap for the measurement and the ruling on basis.
   */
  const [maxPriceText, setMaxPriceText] = useState('');
  const [maxPriceTouched, setMaxPriceTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const usd = parseAmount(amt); // strips thousands separators ("1,000" → 1000, not 1)
  const q = buyQuote(usd, m);
  // F-G: the rows the reader can add up. See buyRows — the CHARGED total is
  // exact and the curve-cost row carries the (at most one cent) residue.
  const rows = buyRows(q);
  /**
   * ★ THE BUTTON WAS LIVE ON A QUOTE OF ZERO TOKENS (2026-08-27).
   *
   * `buyQuote` returns `tokens: 0` for any budget under the cost of one whole
   * token, and `tokensAffordableForBudget`'s own doc says the caller "must
   * surface rather than rounding up into a transaction that reverts" — this
   * caller did not surface it. Measured on the live market: $0.50 and $1.00 both
   * showed "≈ 0.00 tokens" and "Average price ~$0.00" under an ENABLED Buy, and
   * the only thing standing between the reader and a reverting broadcast was
   * token-market-view.tsx's handleBuy throwing AFTER the click.
   *
   * `minBuyUsd` is the same quote read backwards — the fee-inclusive cost of one
   * token at THIS supply, ceiled to the cent. It moves as the curve rises, which
   * is exactly why it is derived here per render and never written down as a
   * constant.
   */
  const minBuy = minBuyUsd(m);
  /**
   * ★★★ THE CAP REFUSED EVERY BUY THERE WAS (2026-08-27, F-C). `overMax`
   * compared the reader's max against `q.priceAfter` — a BARE CURVE price — while
   * the ceiling actually signed, `maxP × q.tokens`, was checked in
   * token-market-view.tsx's handleBuy against `totalDueHbd`, which INCLUDES the
   * 10% trade fee. Two different bases for one number: since TotalDue >= 1.10 ×
   * price(S) × n and the field defaulted to 1.05 × price(S), it could never pass.
   * Measured 19 of 19 (supply, budget) combinations refused at ZERO price drift,
   * 11 of them with the button still enabled, throwing "The price moved above
   * your limit" when nothing had moved. Both sides are the ALL-IN price per token
   * now; resolveMaxPriceCap carries the ruling and the measurement.
   */
  const defaultMaxPrice = defaultMaxPriceText(q.avgPrice);
  const maxPriceValue = maxPriceTouched ? maxPriceText : defaultMaxPrice;
  const cap = resolveMaxPriceCap(adv ? maxPriceValue : '', q);
  const overMax = adv && cap.overMax; // slippage guard
  /**
   * ★ A SOLD-OUT MARKET DISABLED BUY AND SAID NOTHING (2026-08-23).
   *
   * `overMax` above is the SLIPPAGE guard and was the only reason this button could be
   * dark for a reason other than money. When `supply >= cap` every token is issued, the
   * contract refuses the buy, and the reader got a greyed control with the ordinary
   * label and no explanation — indistinguishable from a bug. Seen live on a cap-reached
   * market. `>=` not `==`: a cap that moves down must not leave the button live.
   */
  const soldOut = Number.isFinite(m.supply) && Number.isFinite(m.cap) && m.cap > 0 && m.supply >= m.cap;
  // The "max price per token" cap, converted to a TOTAL-cost bound for the
  // quoted count — buy.go's own doc: "slippage protection is the buyer's own
  // signed transfer.allow" on TotalDue, not on a per-token price the chain
  // never receives as such. Threading this through is what makes the control
  // mean something once buy() is wired to a real chain call (previously it
  // only disabled this button locally and was never passed to onBuy at all).
  // The cap is now struck on the SAME fee-inclusive basis TotalDue is, so the
  // multiplication below and handleBuy's comparison are like for like.
  const maxTotalUsd = adv ? cap.maxTotalUsd : undefined;

  // ★ THE SPENDING CHECK, before the action rather than after the signature.
  //
  // The account that pays is the MAGI account, which for a lite user is the wallet
  // they signed in with — NOT `user.username`, which is a Lumen display name Magi
  // has never heard of. `useTokenAccounts` resolves the real identity, and a wallet
  // user may have more than one bound, so the first is treated as the payer.
  //
  // On Magi, HBD is also what pays to SEND, so a wallet holding nothing cannot
  // submit at all — see use-magi-spending-power. Checking here means a user is told
  // before they sign, not after they have spent resource credits on a transaction
  // that could never land.
  const tokenAccounts = useTokenAccounts();
  // ★ The account whose balance is checked must be the account that will SIGN,
  // or the gauge measures one identity and the transaction spends another. It
  // was `accounts[0]`, which is merely the oldest-bound credential.
  const payer = tokenAccounts.accounts.find((a) => a.canSign) ?? tokenAccounts.accounts[0] ?? null;
  const spending = useMagiSpendingPower(payer?.id ?? null);
  // HBD is a 3-decimal base-unit integer; the modal works in whole USD, and HBD is
  // dollar-pegged (see live/adapt.ts usdFromHbd — the one documented 1:1).
  // F-C14 (H-FE-11): the affordability gauge must reflect the MAXIMUM the buy could
  // charge, not just the base budget. In Advanced mode the signed ceiling is
  // maxTotalUsd (maxP × tokens), which can exceed `usd`; checking only `usd` would pass
  // a user whose balance covers the budget but not the higher ceiling they authorised.
  const costBaseUnits = Math.round(Math.max(usd, maxTotalUsd ?? 0) * 1000);
  const affordability = spending.affordability(costBaseUnits, 'buy');
  const blockedBySpending = affordability === 'no_resource_credits' || affordability === 'insufficient_hbd';

  return (
    <ModalShell width={460} onClose={onClose} title={`Buy @${displayHandle(m.handle)} token`}>
      <ModalHead title={`Buy @${displayHandle(m.handle)} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <label className="mb-[7px] block text-caption font-semibold text-ink-10">Amount (USD)</label>
        <div className="mb-2.5 flex items-center rounded-xl border border-line-11 px-4 py-3 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
          <span className="text-[22px] leading-[34px] font-bold text-ink-2">$</span>
          <input
            value={amt}
            onChange={(e) => {
              // ★ A MINUS SIGN REACHED A CURRENCY FORMATTER (2026-08-27). "-5"
              // parses to -5 and the CTA rendered "$-5". A budget has no negative
              // meaning at all, so the sign is refused at the point of ENTRY —
              // one place, covering paste as well as typing — rather than
              // defended against separately at every reader of `usd`.
              //
              // ★★★ AND THE FIRST FIX FOR IT MANGLED THE INPUT (same day). It was
              // `e.target.value.replace(/-/g, '')`, which DELETES the character
              // and keeps whatever the rest then means: "-5" became a live $5 buy,
              // and "1e-5" became "1e5" — a $100,000 budget from five characters
              // that meant 0.00001. A refusal is not a substitution. acceptAmountText
              // rejects the whole proposed value and keeps what was there, so
              // nothing is ever silently rewritten; its doc carries the full table.
              setAmt(acceptAmountText(amt, e.target.value));
              setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
            }}
            inputMode="decimal"
            className="ml-0.5 flex-1 border-0 text-[22px] leading-[34px] font-bold tabular-nums text-ink-2 outline-none focus-visible:outline-none"
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
              className="flex-1 rounded-control border border-line-11 py-2 text-caption font-semibold text-ink-7 hover:border-line-brand-10 hover:text-ink-brand-6"
            >
              ${v}
            </button>
          ))}
        </div>
        {/* ★ THREE THINGS THIS CARD USED TO GET WRONG (2026-08-27).
            1. "≈ 6.00 tokens" printed two decimals on a quantity the curve only
               ever mints in whole units (BuyQuote.tokens: "the curve mints
               integers only") — false precision that also made the "0.00" of a
               too-small budget look like a rounding artefact rather than a
               refusal.
            2. "Average price" and "Price after your buy" were shown as a pair
               with no basis named. avgPrice is totalUsd/tokens and so carries the
               10% trade fee; priceAfter is a bare curve price. At $10 on this
               market that read "~$1.57" above "~$1.46" — an average ABOVE the
               ending price, which a rising curve makes impossible. Both labels
               now say which basis they are on; ex-fee the average is $1.43, below
               $1.46, and the itemisation below shows where the difference went.
            3. The fee was named in prose ("Includes a 10% trade fee") but never
               itemised, so nothing on screen reconciled to the amount charged.
               The sell side has itemised its fees since it was written; this is
               the same treatment on the buy side, ending in the one figure the
               CTA repeats. */}
        <div className="mb-3.5 rounded-xl border border-line-9 bg-surface-12 px-4 py-3.5 tabular-nums">
          <div className="text-[15px] leading-[24px] font-bold text-ink-2">
            ≈ {q.tokens} token{q.tokens === 1 ? '' : 's'}
          </div>
          <div className="mt-2 flex justify-between text-caption text-ink-10">
            <span>Average price (incl. fees)</span>
            <span>~{usdPrice(q.avgPrice)} each</span>
          </div>
          <div className="mt-1 flex justify-between text-caption text-ink-10">
            <span>Curve price after your buy</span>
            <span>~{usdPrice(q.priceAfter)}</span>
          </div>
          {/* ★★★ 4. AND THE ROWS DID NOT ADD UP (2026-08-27, F-G). Each was
              formatted independently to two decimals off a three-decimal HBD
              figure, so "Curve cost $10.43 + Trade fee $1.04" sat under "Total
              charged $11.48". Measured over 1,914 quotes (supply 0..200 step 7 ×
              budget $1..$200 step 3): 866 of them, 45.2%, did not reconcile — in
              an itemisation whose entire stated purpose was that the reader can
              add the screen up. `buyRows` keeps the CHARGED total exact (it is
              the number the button repeats and the number signed for) and lands
              the at-most-one-cent residue on the curve-cost row. */}
          <div className="mt-2.5 flex justify-between text-caption text-ink-7">
            <span>Curve cost</span>
            <span>{usdPrice(rows.curveCostUsd)}</span>
          </div>
          <div className="mt-1.5 flex justify-between text-caption text-ink-warn-3">
            <span>Trade fee (10%)</span>
            <span>+{usdPrice(rows.tradeFeeUsd)}</span>
          </div>
          <div className="mt-2 flex justify-between border-t border-line-2 pt-2 text-[15px] leading-[24px]">
            <span className="font-bold">Total charged</span>
            <span className="font-bold text-ink-2">{usdPrice(rows.totalUsd)}</span>
          </div>
        </div>
        <button
          onClick={() => setAdv((v) => !v)}
          className="mb-3 flex items-center gap-1.5 border-0 bg-transparent text-caption font-semibold text-ink-10"
        >
          Advanced {adv ? '▴' : '▾'}
        </button>
        {adv ? (
          <div className="mb-3.5">
            {/* The label names the BASIS now. "Max price per token" alone was
                ambiguous between the curve price and what you actually pay, and
                the code read it one way while handleBuy enforced it the other. */}
            <label className="mb-1.5 block text-caption text-ink-10">Max price per token, all in</label>
            <div className="flex items-center rounded-control border border-line-11 px-3.5 py-2.5 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
              <span className="font-bold text-ink-14">$</span>
              <input
                value={maxPriceValue}
                onChange={(e) => {
                  // Same refusal the amount field makes, for the same reason: a
                  // price cap has no negative or exponential meaning either, and
                  // this field had NO validation at all before (F-B).
                  setMaxPriceTouched(true);
                  setMaxPriceText(acceptAmountText(maxPriceValue, e.target.value));
                  setFailure(null);
                }}
                inputMode="decimal"
                className="ml-0.5 flex-1 border-0 text-[15px] leading-[24px] font-semibold tabular-nums outline-none focus-visible:outline-none"
              />
            </div>
            <div className="mt-1.5 text-caption text-ink-14">
              Fees included, so this is what one token may cost you. The curve moves as others trade.
            </div>
            {cap.note ? <div className="mt-1.5 text-caption text-ink-14">{cap.note}</div> : null}
            {overMax ? (
              <div className="mt-1.5 text-caption font-semibold text-ink-warn-3">
                This buy works out at {usdPrice(q.avgPrice)} a token all in, above your cap of{' '}
                {usdPrice(cap.maxPricePerTokenUsd ?? 0)}. Lower the amount or raise the cap.
              </div>
            ) : null}
          </div>
        ) : null}
        {/* What you can actually spend, and whether you can send anything at all. */}
        <MagiFuelGauge state={spending} costBaseUnits={costBaseUnits} kind={payer?.kind} className="mb-3" />
        {blockedBySpending && payer ? <MagiFundingHelp kind={payer.kind} className="mb-3" /> : null}
        {/* H6 (2026-08-31): the exact remedy — how much HBD to add and that credit
            refills on its own — which describeRcBudget produced and nothing rendered. */}
        {blockedBySpending
          ? (() => {
              const msg = spending.remedy(costBaseUnits, 'buy');
              return msg ? <p className="mb-3 text-caption text-ink-warn-3">{msg}</p> : null;
            })()
          : null}
        <div className="mb-3 rounded-control bg-surface-16 px-3.5 py-3 text-caption text-ink-10">
          Includes a 10% trade fee (5% to @{displayHandle(m.handle)}, 5% to Lumen).
        </div>
        {/* ★★ HIDDEN FOR LAUNCH: `buyRiskNote` defaults to SHOW_BACKING_FIGURES
            and returns the standalone variant while it is false, so this
            paragraph carries no backing clause and no parenthetical today. The
            argument is still computed and still passed, unchanged, so nothing has
            to be rewired when the flag flips. The note below describes the copy
            that returns with it. */}
        {/* ★ THE FIGURE QUOTED HERE IS GROSS OF THE EARLY-EXIT FEE (2026-08-27).
            It read "The floor ($1.20) is what the reserve would pay out per token
            if the market wound down", and on this market a holder redeeming
            inside six weeks receives less than that: $0.96 on day 0, $1.08 on day
            21, the full $1.20 only from day 42 (refundNetBaseUnits against the
            live reserve of 60153 and supply 50). The sentence now names the
            deduction, and uses the renamed stat so the reader can find the number
            it is talking about. */}
        <p className="mb-3.5 font-serif text-caption text-ink-14">
          {buyRiskNote(backingPerTokenValue(m.floorUsd, m.supply))}
        </p>
        <button
          onClick={async () => {
            // q.tokens <= 0 is the same refusal the disabled attribute makes
            // below — the two must never disagree, or a keyboard activation
            // broadcasts what the pointer cannot.
            if (!Number.isFinite(usd) || usd <= 0 || q.tokens <= 0 || overMax) return;
            // F7: synchronous — see the `inFlight` doc above. Checked and set
            // BEFORE any await, so a same-tick second click is a no-op.
            if (inFlight.current) return;
            inFlight.current = true;
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
              inFlight.current = false;
              setBusy(false);
            }
          }}
          // blockedBySpending refuses BEFORE the signature. The gauge above already
          // explains which of the two problems it is (nothing to send with, versus
          // not enough for this particular purchase), so the label stays short.
          // Note it does NOT block on `affordability === 'unknown'`: a failed
          // balance read must not stop a user who may well be able to afford this.
          disabled={!Number.isFinite(usd) || usd <= 0 || q.tokens <= 0 || overMax || busy || blockedBySpending || soldOut}
          className="w-full rounded-card bg-surface-brand-12 py-[15px] text-[15px] leading-[24px] font-bold tabular-nums text-ink-27 hover:bg-surface-brand-16 disabled:opacity-50"
        >
          {/* ★ THE CTA NAMED A NUMBER NOBODY IS CHARGED (2026-08-27). The label was
              built from the TYPED BUDGET rounded to whole dollars, while what leaves the
              buyer's account is the quote's TotalDue — which is <= the budget, because
              tokens are integers. Typing 12.34 bought 7 tokens for $11.03 under a button
              reading "$12"; typing 0.50 read "$1", overstating 2x a buy that could not
              execute at all; typing -5 reached the formatter as "$-5" (refused at the
              field now, see the amount input above).

              `q` IS the charge. token-market-view.tsx's handleBuy recomputes the identical
              `buyQuote(usd, market)` and sends `local.tokens` to live.buy(), so the tokens
              this label is priced from are the tokens actually bought. The typed `usd`
              survives only as the spend CEILING (handleBuy's `cap`) — a limit, not a price,
              and it must not be shown as one.

              usdPrice, not usdWhole: two decimals, the same helper the Sell CTA already
              uses. TotalDue is a 3-decimal HBD figure, so the third decimal is rounded to
              the cent — sub-cent, and unavoidable without a formatter this feature does
              not have. */}
          {busy
            ? 'Confirm in your wallet…'
            : soldOut
              ? 'Sold out. Every token is issued'
              : affordability === 'no_resource_credits'
              ? 'Add HBD on Magi first'
              : affordability === 'insufficient_hbd'
                ? 'Not enough HBD'
                : q.tokens <= 0 && minBuy > 0
                  ? `Minimum buy is ${usdPrice(minBuy)}`
                  // ★ HOUSE STYLE, APPLIED TO COPY THIS SESSION CHANGED (2026-08-27).
                  // This label was rewritten today (see the note above: it used to be
                  // built from the typed budget), and it carried an em dash. No em or
                  // en dashes in prose published under the owner's name. Rewritten to
                  // read naturally without one rather than swapped for a hyphen.
                  //
                  // ★★★ AND THEN IT NAMED A NUMBER NOBODY IS GUARANTEED (F-E, same
                  // day). `q` is the LOCAL quote; handleBuy re-quotes against live
                  // state before signing and the ceiling it signs is `maxTotalUsd ??
                  // usd`, the typed BUDGET, which is strictly above this figure
                  // whenever the integer token count leaves change. Measured on a $50
                  // budget at supply 50 (label $48.59): +5 supply of drift charges
                  // $49.90 and still executes. The re-quote is right and stays; what
                  // was wrong is a bare figure with no qualifier while every sibling
                  // estimate in these dialogs carries "≈" or "~". The tilde matches
                  // them, and the line under the button names the ceiling that really
                  // binds.
                  //
                  // ★★ THIS BREAKS ONE ASSERTION IN A SIBLING TEST I DO NOT OWN.
                  // market/buy-preview.selftest.ts:341 asserts the literal
                  // `Buy for ${usdPrice(q.totalUsd)}`; it needs the tilde adding, to
                  // `Buy for ~${usdPrice(q.totalUsd)}`. Its line 342 asserts the
                  // minus-strip this pass removed (see the amount field) and needs
                  // replacing with the acceptAmountText call. Flagged in the handover
                  // rather than reached into; both invariants are asserted in
                  // trade-preview.selftest.ts so neither loses its home.
                  : `Buy for ~${usdPrice(q.totalUsd)}`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
        ) : null}
        {/* F-E: the label above is an estimate; THIS is the number that binds.
            handleBuy refuses outright above `maxTotalUsd ?? usd`, so this is a
            guarantee rather than a hedge and is worth stating plainly. */}
        <div className="mt-2.5 text-center text-caption text-ink-14">
          One signature confirms your buy. {buyCeilingNote(maxTotalUsd ?? usd, maxTotalUsd !== undefined)}
        </div>
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
  onSell: (tokens: number, minNetUsd?: number) => Promise<void>;
  onClose: () => void;
  mode?: 'sell' | 'redeem';
  /** The balance read FAILED. Never render "you hold none" for this — see LiveTokenMarketResult.positionUnavailable. */
  positionUnavailable?: boolean;
}> = ({ m, onSell, onClose, mode = 'sell', positionUnavailable = false }) => {
  const redeem = mode === 'redeem';
  const [busy, setBusy] = useState(false);
  // F7 fix: see BuyModal's `inFlight` doc — same synchronous guard, same
  // reason. `busy` stays for the disabled attribute and button label.
  const inFlight = useRef(false);
  const held = m.position?.tokens ?? 0;
  const [amt, setAmt] = useState(String(held || 0));
  const [failure, setFailure] = useState<string | null>(null);
  // F5 fix (2026-08-19). H-FE-7 added this floor but shipped it collapsed and
  // OFF by default (minNetUsd stayed undefined until the reader opened
  // Advanced AND typed a number), so the one real protection this dialog
  // offers against a same-block price move or front-run was inert unless a
  // reader knew to go looking for it. It now defaults ON: pre-filled just
  // under the SAME "you receive"/"you get" figure already shown above,
  // shown open rather than hidden (this IS the number being consented to —
  // AskInput.maxCreditsBaseUnits's doc makes the identical point about
  // showing a signed cap), and the escape hatch H-FE-7 cared about is still
  // one click away: clearing the field is an explicit opt-out, exactly as
  // absent minNet already meant "no floor" on the wire. Typing a lower
  // number "widens" the floor (more slippage tolerated) the same way.
  const [advOpen, setAdvOpen] = useState(true);
  const [minNetText, setMinNetText] = useState('');
  const [minNetTouched, setMinNetTouched] = useState(false);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const q = sellQuote(tokens, m, m.position?.heldDays ?? 999);
  // ★ TWIN OF THE "0%" BUG (2026-08-21). `exitFeePct` is a FRACTION, so a real
  // but small early-exit fee rounded to a flat "0%" — printed beside the nonzero
  // dollar deduction it was supposedly explaining. `pctLabel` reads "<1%" for
  // anything above zero that rounds below half a percent, so the rate and the
  // amount can no longer contradict each other.
  const feePctLabel = pctLabel(q.exitFeePct, 1) ?? '0%';
  // F-G: the itemised rows the reader can add up — "You receive" is exact (it is
  // what the button repeats and what the minimum-net floor is struck from) and
  // the gross carries the residue. See sellRows.
  const rows = sellRows(q);
  /**
   * ★★★ THE REDEEM AMOUNT IS RE-QUOTED PER AMOUNT NOW, NOT SCALED (2026-08-27).
   *
   * It was `(position.floorValueUsd * tokens) / held`. That was exact while the
   * tax was a flat rate on the whole gross, and it stopped being exact the moment
   * `floorValueUsd` became the SPLIT-AWARE net (lib/vsc-data-source.ts:502-508
   * passing `tokensMaturing`): core/refund.go:282-283 runs splitDraw on the
   * REDEEMED amount, maturing-first, so a draw inside the maturing bucket is
   * taxed on its whole gross while the whole-position figure it was scaled from
   * was not. Measured on reserve 120000 / supply 1000 / 100 held (40 maturing) at
   * day 0: every partial size was over-quoted (up to +15.0% there, +24.8% in the
   * worst position shape) and therefore every partial size tripped its own 1%
   * minimum-refund floor and REVERTED. Only "Redeem all" worked. redeemQuote runs
   * the contract's own arithmetic on the amount actually being redeemed; its doc
   * carries the table and the one approximation (the day-granular hold clock,
   * which errs conservative).
   */
  const rq = redeem
    ? redeemQuote({
        reserveUsd: m.reserveUsd,
        supplyTokens: m.supply,
        heldTokens: held,
        maturingTokens: m.position?.maturingTokens,
        heldDays: m.position?.heldDays ?? 0,
        tokens
      })
    : null;
  const redeemUsd = rq?.netUsd ?? 0;
  const shownNetUsd = redeem ? redeemUsd : q.receiveUsd;
  // MIN_NET_DEFAULT_TOLERANCE_BPS (market/curve.ts) is headroom under the
  // shown figure — see its own doc for why redeem mode in particular needs
  // it (a pro-rata scale, not a fresh per-amount recompute).
  const defaultMinNetUsd = shownNetUsd > 0 ? (shownNetUsd * (10_000 - MIN_NET_DEFAULT_TOLERANCE_BPS)) / 10_000 : 0;
  const minNetParsed = parseFloat(minNetText.replace(/,/g, ''));
  // Untouched: apply the default (or no floor, if there is nothing to
  // protect yet — e.g. tokens===0). Touched: the reader's own value, INCLUDING
  // nothing, which is the deliberate opt-out.
  const minNetUsd = minNetTouched
    ? Number.isFinite(minNetParsed) && minNetParsed > 0
      ? minNetParsed
      : undefined
    : defaultMinNetUsd > 0
      ? defaultMinNetUsd
      : undefined;
  const minNetDisplayValue = minNetTouched ? minNetText : defaultMinNetUsd > 0 ? defaultMinNetUsd.toFixed(2) : '';

  /**
   * ★★★ AN ALL-ZERO SELL FORM IS NOT AN ANSWER (2026-08-27, reproduced live on
   * the 30-cap market signed in as an account holding none of it).
   *
   * With `held === 0` this dialog rendered its full trading form against
   * nothing: "Sell all (0.00)", a curve breakdown of $0.00, a pre-filled
   * minimum-net floor of nothing, and a "Sell — get ~$0.00" CTA. Every figure
   * was arithmetically correct and the screen as a whole said something false —
   * that there is a sell here to make. A reader cannot tell that from a market
   * that has broken, which is the same "a greyed control with no reason reads
   * as a bug" failure the Buy button's sold-out disclosure was written for.
   *
   * Placed AFTER every hook above: React requires an unconditional hook order,
   * and an early return before them breaks it on the render the balance lands.
   *
   * ★ AND IT MUST NOT SAY "YOU HOLD NONE" WHEN THE BALANCE SIMPLY DID NOT READ.
   * `m.position` is null for BOTH — see LiveTokenMarketResult.positionUnavailable,
   * added for this — so a failed read gets the wording the wallet's holdings list
   * already uses for its unreadable index, and only a real, successful zero is
   * told it is a zero.
   */
  const emptyMessage = sellEmptyStateMessage({ held, redeem, positionUnavailable, handle: m.handle });
  if (emptyMessage !== null) {
    const emptyTitle = redeem ? `Redeem @${displayHandle(m.handle)} token` : `Sell @${displayHandle(m.handle)} token`;
    return (
      <ModalShell width={460} onClose={onClose} title={emptyTitle}>
        <ModalHead title={emptyTitle} onClose={onClose} />
        <div className="px-6 pb-6 pt-[18px]">
          <p className="rounded-xl border border-dashed border-line-11 px-4 py-5 text-center font-serif text-sm italic text-ink-14">
            {emptyMessage}
          </p>
          <button
            onClick={onClose}
            className="mt-3.5 w-full rounded-card border border-line-11 bg-surface-1 py-[15px] text-[15px] leading-[24px] font-semibold text-ink-7 hover:bg-surface-16"
          >
            Close
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      width={460}
      onClose={onClose}
      title={redeem ? `Redeem @${displayHandle(m.handle)} token` : `Sell @${displayHandle(m.handle)} token`}
    >
      <ModalHead title={redeem ? `Redeem @${displayHandle(m.handle)} token` : `Sell @${displayHandle(m.handle)} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <div className="mb-[7px] flex items-center justify-between">
          <label className="text-caption font-semibold text-ink-10">Amount (tokens)</label>
          <button
            onClick={() => setAmt(String(held))}
            className="border-0 bg-transparent text-caption font-semibold tabular-nums text-ink-brand-6"
          >
            {redeem ? 'Redeem all' : 'Sell all'} ({tok(held)})
          </button>
        </div>
        <div className="mb-3.5 flex items-center rounded-xl border border-line-11 px-4 py-3 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
          <input
            value={amt}
            onChange={(e) => {
              setAmt(e.target.value);
              setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
            }}
            inputMode="decimal"
            className="min-w-0 flex-1 border-0 text-[22px] leading-[34px] font-bold tabular-nums text-ink-2 outline-none focus-visible:outline-none"
          />
          <span className="text-caption font-semibold text-ink-14">tokens</span>
        </div>
        {q.exitFeePct > 0 ? (
          <div className="mb-3.5 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3.5">
            {/* ★ "RATE", AND WHAT IT IS A RATE ON (2026-08-27, F-F). This strip is
                the DECAY of τ and is correct; what it lacked was any statement of
                its base. Since the two-bucket fix the deduction falls on the
                MATURING share of the draw only (core/matured.go:197-219), so a
                mixed holder read "20% now" here beside an itemised deduction of
                8.0% of their proceeds below, with nothing on screen reconciling
                the two. The word "rate" and the clause below do that; the row
                itself now carries the effective percentage. */}
            <div className="mb-1.5 text-[14px] leading-[22px] font-bold tabular-nums text-ink-warn-3">
              Early-exit fee rate: {feePctLabel} now
            </div>
            <p className="mb-2.5 text-caption text-ink-warn-2">
              You’ve held these ~{m.position?.heldDays ?? 0} days. The fee drops to 0% if you hold ~6 weeks.
              {exitFeeBaseNote(held, m.position?.maturingTokens) ? ` ${exitFeeBaseNote(held, m.position?.maturingTokens)}` : ''}
            </p>
            <div className="h-1.5 overflow-hidden rounded bg-surface-warn-9">
              {/* Was a leftover 0.15 (the OLD, pre-curve 15% max) — reads as
                  maxed-out for the first quarter of the real 20% decay.
                  EXIT_FEE_MAX is the real, exported maximum (params.go
                  MaxExitTaxBps). */}
              <div
                className="h-full bg-surface-warn-11"
                style={{ width: `${(q.exitFeePct / EXIT_FEE_MAX) * 100}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-caption tabular-nums text-ink-warn-3">
              <span>{feePctLabel} now</span>
              <span>0% at 6 wks</span>
            </div>
          </div>
        ) : null}
        <div className="mb-3.5 rounded-xl border border-line-9 px-4 py-3.5 tabular-nums">
          {/* CURVE-RAIL ROWS ONLY. In redeem mode the curve is closed, so a
              "Curve proceeds" figure describes a rail that cannot execute, and the
              exit fee shown as a DOLLAR amount is computed off that same wrong
              basis. Both were left ungated in the first pass of this change and
              produced three numbers on screen that did not reconcile with each
              other or with the button. The exit-tax RATE strip above stays: that
              rate genuinely applies to both doors (see Market position exitTaxBps). */}
          {redeem ? null : (
            <>
              <div className="mb-1.5 flex justify-between text-caption text-ink-7">
                <span>Curve proceeds</span>
                <span>{usdPrice(rows.curveProceedsUsd)}</span>
              </div>
              {rows.exitFeeUsd > 0 ? (
                // ★ THE RATE HERE IS THE ONE THE TWO VISIBLE FIGURES STAND IN
                // (F-F). It was `feePctLabel`, the raw τ, printed beside a
                // deduction that is τ of the MATURING share only — "20%" next to
                // 8.0% of the proceeds directly above it. Now the row can be
                // checked against the row above it. pctLabel's guarantee carries:
                // a real but small deduction reads "<1%", never a flat "0%".
                <div className="mb-1.5 flex justify-between text-caption text-ink-warn-3">
                  <span>
                    Early-exit fee ({pctLabel(effectiveExitFeePct(rows.exitFeeUsd, rows.curveProceedsUsd), 1) ?? '0%'} of
                    proceeds)
                  </span>
                  <span>−{usdPrice(rows.exitFeeUsd)}</span>
                </div>
              ) : null}
            </>
          )}
          {/* The 10% trade fee is a CURVE-rail charge (sell.go). The wind-down
              rail (refund.go) is a pro-rata slice of the reserve and does not pay
              it, so showing it here would be inventing a deduction. */}
          {redeem ? null : (
            <div className="mb-2 flex justify-between text-caption text-ink-warn-3">
              <span>Trade fee (10%)</span>
              <span>−{usdPrice(rows.tradeFeeUsd)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-line-2 pt-2 text-[15px] leading-[24px]">
            <span className="font-bold">You receive</span>
            {/* Redeem: the contract's own arithmetic on the amount being redeemed
                (refundPayout + splitDraw + the K2 carve), not a pro-rata scale of
                the whole position — see redeemQuote for why the scale over-quoted
                every partial size. Still marked approximate: the contract
                recomputes it at execution from the live reserve, supply and hold
                clock, and we will not print an exact figure we cannot guarantee. */}
            <span className="font-bold text-ink-ok-2">
              {redeem ? `≈ ${usdPrice(redeemUsd)}` : usdPrice(rows.receiveUsd)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className="mb-2 border-0 bg-transparent text-caption font-semibold text-ink-10"
        >
          Advanced {advOpen ? '▴' : '▾'}
        </button>
        {advOpen ? (
          <div className="mb-3.5">
            <label className="mb-1.5 block text-caption text-ink-10">
              Minimum {redeem ? 'refund' : 'net'} (HBD): protects you if the price moves
            </label>
            <div className="flex items-center rounded-xl border border-line-11 px-4 py-2.5 focus-within:border-line-brand-10">
              <input
                value={minNetDisplayValue}
                onChange={(e) => {
                  setMinNetTouched(true);
                  setMinNetText(e.target.value);
                  setFailure(null);
                }}
                inputMode="decimal"
                placeholder="optional"
                className="flex-1 border-0 text-[15px] leading-[24px] font-semibold tabular-nums text-ink-2 outline-none focus-visible:outline-none"
              />
              <span className="text-caption font-semibold text-ink-14">HBD</span>
            </div>
            <p className="mt-1.5 text-caption text-ink-14">
              Pre-filled just under what you’re shown above, so the {redeem ? 'redeem' : 'sell'} reverts (nothing
              spent) if the net comes in lower: a price move or a same-block front-run, not you. Clear it to exit
              at the going rate with no minimum, or lower it to allow more slippage.
            </p>
          </div>
        ) : null}
        <button
          onClick={async () => {
            if (!Number.isFinite(tokens) || tokens <= 0) return;
            // F7: synchronous — see BuyModal's `inFlight` doc.
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            setFailure(null);
            try {
              await onSell(tokens, minNetUsd);
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That sell didn’t go through.'));
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={!Number.isFinite(tokens) || tokens <= 0 || held <= 0 || tokens > held || busy}
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-bold tabular-nums text-ink-27 hover:bg-surface-44 disabled:opacity-50"
        >
          {busy
            ? 'Confirm in your wallet…'
            : tokens > held
              ? 'More than you hold'
              : redeem
                ? `Redeem · get ~${usdPrice(redeemUsd)}`
                : `Sell · get ~${usdPrice(q.receiveUsd)}`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
        ) : null}
        {/* This used to read "Selling is always available — even if this market
            winds down", which is false: sell() throws once the market is
            retired/frozen/closed. That was corrected to "You can always exit",
            which moved the unconditional promise one word to the left instead of
            removing it.

            ★★★ AND THAT SECOND VERSION IS THE ONE THIS FIXES (2026-08-27, read
            off the live build 9k0sWWUqu7AcgaakLJfwI). "You can always exit.
            While this market is open by selling, and once it winds down by
            redeeming at the floor." A bonding curve offers a QUOTED buyback,
            contingent on the reserve being there and on the market being open.
            It cannot promise "always" — and the product's own copy says so two
            panels away ("not a price you can sell at on demand"), so the page
            was contradicting itself with a guarantee on one screen and a
            disclaimer on another.

            The replacement makes no promise: it names the two routes, says only
            one is open at a time, and states that neither pays a fixed price.
            See exitRoutesNote. */}
        <div className="mt-2.5 text-center text-caption text-ink-14">{exitRoutesNote(redeem)}</div>
      </div>
    </ModalShell>
  );
};

const AskModal: FC<{
  m: LiveTokenMarket;
  service: Service | null;
  /**
   * ask.go's settlement preview for this offering, run WHEN THE DIALOG OPENS.
   * See use-live-token-market's `quoteAsk` doc for why it exists.
   */
  quoteAsk: (offeringId: number) => Promise<Quote>;
  /** offeringId is Service.key — the creator's named service, or '0' for their legacy face price. Passing it is what makes the shop actually buyable. */
  onSpend: (input: {
    offeringId: number;
    usd: number;
    deadlineDays: number;
    question: string;
  }) => Promise<void>;
  onClose: () => void;
}> = ({ m, service, quoteAsk, onSpend, onClose }) => {
  const [busy, setBusy] = useState(false);
  // F7 fix: see BuyModal's `inFlight` doc.
  const inFlight = useRef(false);
  const [deadline, setDeadline] = useState(7);
  const [question, setQuestion] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const usd = service?.usd ?? 10;
  const offeringId = Number(service?.key ?? 0);
  /**
   * ★★★ ASK THE CHAIN BEFORE THE READER COMMITS, NOT AFTER (2026-08-30,
   * clauderfly-43).
   *
   * This dialog priced everything off spot (`serviceQuote` below) and enabled its
   * button unconditionally, so a buyer met a plausible price, pressed Send, got a
   * signature prompt and only THEN the refusal — on markets where the chain
   * cannot price a service at all. Measured against the live contract on
   * 2026-08-30, that was 13 of 13 registered markets.
   *
   * Nothing was ever at risk: `vsc-data-source.ts`'s ask() re-reads this same
   * quote and throws before any broadcast, so no resource credits were burned.
   * What was wrong is the ORDER — a price shown, a decision invited, and the
   * "actually, no" arriving after the click.
   *
   * The same read, run on open. It resolves with a REASON on a refusal and only
   * rejects when the read itself failed, so the two are told apart below: a
   * refusal names why, a failed read says we could not check, and neither is
   * allowed to look like a working price.
   */
  const askQuote = useQuery({
    queryKey: ['creatorTokens', 'live', 'askQuote', m.handle, offeringId],
    queryFn: () => quoteAsk(offeringId),
    // The settlement rate moves with the head block; a quote read once and held
    // is the same staleness problem one layer up.
    staleTime: 15_000,
    retry: 1
  });
  const oracleStatus = askQuote.data?.oracleStatus ?? null;
  const priceRefused = oracleStatus !== null && oracleStatus !== 'ok';
  const quoteUnreadable = askQuote.isError;
  /** Never offer to send something we could not price, or that the chain has said it will refuse. */
  const priceBlocked = priceRefused || quoteUnreadable || askQuote.isLoading;
  // USER RULING 2026-07-27: the posted USD price is the buyer's TOTAL — 12%
  // is a SEPARATE HBD platform commission, never tokens (ask.go splitFace).
  const q = serviceQuote(usd, m.priceUsd);
  /**
   * ★★★ THE POSTED PRICE WAS PRINTED AS THE TOTAL, AND IT IS NOT (2026-08-27,
   * F-D). The card read "{usdWhole(usd)} total". What leaves the buyer is
   * `ceil(tokenLeg / rate)` WHOLE tokens plus the HBD commission, and the ceiling
   * is the defect: a $13.20 token leg cannot buy 1.15 tokens, it buys 2.
   * Measured on a $15 service: at supply 50, 10 tokens ($14.00) + $1.80 = $15.80
   * (+5.3%); at supply 1000, 2 tokens ($23.00) + $1.80 = $24.80 (+65.3%). The
   * USER RULING of 2026-07-27 above is untouched — it settles the SPLIT, which is
   * still exactly as it says; the whole-token ceiling is a different quantity it
   * never spoke to, and it is disclosed rather than hidden behind the posted
   * figure. See askCost.
   */
  const cost = askCost(usd, q, m.priceUsd);
  const held = m.position?.tokens ?? 0;
  // This mock has no HBD wallet balance to check — a real, wallet-connected
  // build MUST also verify the buyer can cover q.commissionUsd in HBD
  // (ask.go's commissionHbdPaid leg) before enabling this button; this only
  // proves the TOKEN leg is affordable. Never let "canAfford" quietly mean
  // "affords the tokens" once a real HBD balance exists to check — see
  // ask.go's Ask() guard order (maxCredits, then the exact commission match).
  const canAffordTokens = held >= q.tokens && Number.isFinite(q.tokens);
  // H-FE-2: the commission is a SEPARATE HBD leg (ask.go's commissionHbdPaid), so the
  // buyer must be able to cover it in HBD — the token-leg check alone let an ask be
  // signed that the contract's exact-commission guard rejects for want of HBD, burning
  // the caller's RC. Same payer resolution + spending gauge BuyModal uses; HBD is
  // dollar-pegged, so the USD commission is its base-unit amount ×1000.
  const askTokenAccounts = useTokenAccounts();
  // Same reasoning as `payer` above: check the balance of whoever signs.
  const askPayer = askTokenAccounts.accounts.find((a) => a.canSign) ?? askTokenAccounts.accounts[0] ?? null;
  const askSpending = useMagiSpendingPower(askPayer?.id ?? null);
  const commissionBaseUnits = Math.round(q.commissionUsd * 1000);
  const commissionAffordability = askSpending.affordability(commissionBaseUnits, 'ask');
  const blockedByCommission =
    commissionAffordability === 'no_resource_credits' || commissionAffordability === 'insufficient_hbd';
  const canAsk = canAffordTokens && !blockedByCommission && !priceBlocked;
  return (
    <ModalShell width={500} onClose={onClose} title={`Ask @${displayHandle(m.handle)}`}>
      <ModalHead title={`Ask @${displayHandle(m.handle)}`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={`What do you want to ask @${displayHandle(m.handle)}?`}
          className="h-[120px] w-full resize-y rounded-xl border border-line-11 px-4 py-3.5 font-serif text-[15px] leading-[24px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
        />
        <div className="my-2 mb-3.5 text-caption text-ink-14">
          Private. Stored on Lumen, only its fingerprint goes on-chain.
        </div>
        {/* ★ THE REFUSAL REPLACES THE PRICE, it does not sit under one. Leaving a
            cost sentence on screen beside "this cannot be bought" is the same
            mixed message as a live price on a dead market — see the askQuote doc
            above. `unavailable` here is OUR read failing, which is a different
            sentence from the chain refusing, and both are different from a price. */}
        {priceRefused && oracleStatus ? (
          <div
            className="mb-4 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-warn-3"
            data-testid="ask-modal-price-refused"
          >
            {buyerOracleNotice(oracleStatus, displayHandle(m.handle))}
          </div>
        ) : quoteUnreadable ? (
          <div
            className="mb-4 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3.5 text-[14px] leading-[22px] font-semibold text-ink-warn-3"
            data-testid="ask-modal-price-unreadable"
          >
            We couldn&rsquo;t work out what this would cost just now, so it can&rsquo;t be sent yet. Try again in a
            moment.
          </div>
        ) : askQuote.isLoading ? (
          <div className="mb-4 rounded-xl border border-line-9 px-4 py-3.5 text-[14px] leading-[22px] text-ink-10">
            Checking what this costs&hellip;
          </div>
        ) : (
        <div className="mb-4 rounded-xl border border-line-9 px-4 py-3.5 text-[14px] leading-[22px] text-ink-7">
          {/* ★★★ THE SENTENCE IS ASSEMBLED IN trade-preview.ts, NOT HERE (F-D).
              Two reasons, one of which bit this pass on its first draft:

              1. THE COUNT IS AN INTEGER. It went through `tok`, the 2-decimal
                 formatter, and rendered "14.00 tokens" on a quantity ask.go only
                 ever escrows whole — the same false precision the buy card was
                 corrected for the same day.
              2. THE TOTAL WAS THE POSTED PRICE, which is not what leaves the
                 buyer (askCost's doc carries the measurement: up to +65.3%).

              And writing it inline is what makes a note like this dangerous: JSX
              strips the whitespace-only lines either side of an expression
              container, so a `{/* … *\/}` dropped between two text runs renders
              "against aposted price of". Segments cannot have that happen to
              them, and askCostLine gives a test the whole sentence to read. Same
              pattern, same reason, as disclosure-copy.ts's positionSegments. */}
          {askCostSegments(cost).map((seg, i) =>
            seg.strong ? (
              <strong key={i} className="tabular-nums text-ink-2">
                {seg.text}
              </strong>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
            {/* ★ "YOU GET IT ALL BACK" WAS FALSE (2026-08-23). Verified against the contract,
                not against the claim: core/ask.go:767 retains
                `mMulDivCeil(commission, MissReclaimSliceBps, 10000)` with
                MissReclaimSliceBps = 2500 (core/params.go:251) — 25% of the HELD COMMISSION
                goes to the treasury on a miss. The credits/tokens DO return whole (returned
                above that line, untouched). The slice applies only when `rec.asker != creator`,
                so asking yourself is genuinely free — an edge case not worth a sentence here. */}{' '}
            If it&rsquo;s unanswered by your deadline you can reclaim your tokens in full and 75% of the
            commission. The platform keeps 25% so a missed deadline cannot be manufactured for free.
        </div>
        )}
        <label className="mb-2 block text-caption font-semibold text-ink-10">Answer due within</label>
        <div className="mb-4 flex items-center gap-3.5">
          <input
            type="range"
            min={2}
            max={30}
            value={deadline}
            onChange={(e) => setDeadline(Number(e.target.value))}
            className="flex-1 accent-line-brand-10"
          />
          <span className="w-[70px] text-right text-[14px] leading-[22px] font-bold tabular-nums text-ink-2">
            {deadline} days
          </span>
        </div>
        {blockedByCommission && askPayer ? <MagiFundingHelp kind={askPayer.kind} className="mb-3" /> : null}
        <button
          onClick={async () => {
            if (!canAsk) return;
            // F7: synchronous — see BuyModal's `inFlight` doc.
            if (inFlight.current) return;
            inFlight.current = true;
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
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={!canAsk || busy}
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-semibold tabular-nums text-ink-27 hover:bg-surface-44 disabled:opacity-50"
        >
          {busy
            ? 'Confirm in your wallet…'
            : askQuote.isLoading
              ? 'Checking the price…'
              : priceRefused
                ? 'Not available yet'
                : quoteUnreadable
                  ? 'Price unavailable'
                  : !canAffordTokens
              ? `You need ${cost.tokens} @${displayHandle(m.handle)} tokens. Buy some first`
              : blockedByCommission
                ? `You need ${usdPrice(q.commissionUsd)} in HBD for the commission`
                : `Send question for ${cost.tokens} tokens + ${usdPrice(q.commissionUsd)} HBD`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
        ) : null}
      </div>
    </ModalShell>
  );
};

const SendModal: FC<{
  m: LiveTokenMarket;
  onTransfer: (to: string, tokens: number) => Promise<void>;
  onClose: () => void;
}> = ({ m, onTransfer, onClose }) => {
  const [busy, setBusy] = useState(false);
  // F7 fix: see BuyModal's `inFlight` doc. transfer is irreversible — a
  // double-submit here sends the tokens twice.
  const inFlight = useRef(false);
  const held = m.position?.tokens ?? 0;
  const [to, setTo] = useState('');
  const [amt, setAmt] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const valid = to.trim().length > 0 && Number.isFinite(tokens) && tokens > 0 && tokens <= held;
  return (
    <ModalShell width={420} onClose={onClose} title={`Send @${displayHandle(m.handle)} tokens`}>
      <ModalHead title={`Send @${displayHandle(m.handle)} tokens`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <label className="mb-1.5 block text-caption font-semibold text-ink-10">
          To (Lumen or Hive name)
        </label>
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setFailure(null);
          }}
          placeholder="@name"
          className="mb-3.5 w-full rounded-xl border border-line-11 px-4 py-3 text-[15px] leading-[24px] font-semibold text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
        />
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-caption font-semibold text-ink-10">Amount (tokens)</label>
          <button
            onClick={() => setAmt(String(held))}
            className="border-0 bg-transparent text-caption font-semibold tabular-nums text-ink-brand-6"
          >
            Max ({tok(held)})
          </button>
        </div>
        <input
          value={amt}
          onChange={(e) => {
            setAmt(e.target.value);
            setFailure(null); // a fresh amount deserves a fresh attempt, not a stale error
          }}
          inputMode="decimal"
          placeholder="0"
          className="mb-3.5 w-full rounded-xl border border-line-11 px-4 py-3 text-[22px] leading-[34px] font-bold tabular-nums text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
        />
        <button
          onClick={async () => {
            if (!valid) return;
            // F7: synchronous — see BuyModal's `inFlight` doc.
            if (inFlight.current) return;
            inFlight.current = true;
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
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={!valid || busy}
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-bold tabular-nums text-ink-27 hover:bg-surface-44 disabled:opacity-50"
        >
          {busy
            ? 'Confirm in your wallet…'
            : tokens > held
              ? 'More than you hold'
              : `Send ${tok(tokens)} tokens`}
        </button>
        {failure ? (
          <div className="mt-2.5 text-center text-caption font-semibold text-ink-brand-6">{failure}</div>
        ) : null}
        <div className="mt-2.5 text-center text-caption text-ink-14">
          Transfers are free and instant on Lumen. Never blocked by billing.
        </div>
      </div>
    </ModalShell>
  );
};

const InterstitialModal: FC<{ handle: string; onClose: () => void }> = ({ onClose }) => (
  <ModalShell width={480} onClose={onClose} title="Before you trade this token">
    <div className="px-6 py-[26px]">
      <div className="mb-[18px] font-serif text-[22px] leading-[34px] font-semibold text-ink-2">
        Before you trade this token
      </div>
      {/* ★ `interstitialLines()`, not the constant (2026-08-27): with the backing
          stat hidden for launch, the line reading "Backing per token, shown next
          to the price ..." directed the reader to a place on the screen where
          nothing is. The selector drops that line and trims the clause in line 2
          that depended on it; the original four lines are still exported and come
          back with the flag. See disclosure-copy.ts. */}
      <div className="mb-[22px] flex flex-col gap-3.5">
        {interstitialLines().map((line, i) => (
          <p key={i} className="font-serif text-[14px] leading-[22px] text-ink-7">
            {line}
          </p>
        ))}
      </div>
      <div className="flex gap-3">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl bg-surface-42 py-3.5 text-[15px] leading-[24px] font-semibold text-ink-27 hover:bg-surface-44"
        >
          I understand. Show the market
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
  onSell: (tokens: number, minNetUsd?: number) => Promise<void>;
  /** refund.go Refund — the pro-rata exit, and the only rail that works once the market winds down. */
  onRedeem: (tokens: number, minNetUsd?: number) => Promise<void>;
  onSpend: (input: {
    offeringId: number;
    usd: number;
    deadlineDays: number;
    question: string;
  }) => Promise<void>;
  onTransfer: (to: string, tokens: number) => Promise<void>;
  /** Forwarded to the ask dialog so it can price the service BEFORE the reader commits to it. */
  quoteAsk: (offeringId: number) => Promise<Quote>;
  onClose: () => void;
  /** Forwarded to the sell/redeem dialog so its empty state cannot claim a zero it never read. */
  positionUnavailable?: boolean;
}> = ({ dialog, market, service, onBuy, onSell, onRedeem, onSpend, onTransfer, quoteAsk, onClose, positionUnavailable }) => {
  if (dialog === 'buy') return <BuyModal m={market} onBuy={onBuy} onClose={onClose} />;
  if (dialog === 'sell')
    return <SellModal m={market} onSell={onSell} onClose={onClose} positionUnavailable={positionUnavailable} />;
  // The wind-down exit. Same dialog, refund.go behind it instead of sell.go.
  if (dialog === 'redeem')
    return (
      <SellModal m={market} onSell={onRedeem} onClose={onClose} mode="redeem" positionUnavailable={positionUnavailable} />
    );
  if (dialog === 'ask')
    return <AskModal m={market} service={service} quoteAsk={quoteAsk} onSpend={onSpend} onClose={onClose} />;
  if (dialog === 'send') return <SendModal m={market} onTransfer={onTransfer} onClose={onClose} />;
  if (dialog === 'inter') return <InterstitialModal handle={market.handle} onClose={onClose} />;
  return null;
};

export default TokenModals;
