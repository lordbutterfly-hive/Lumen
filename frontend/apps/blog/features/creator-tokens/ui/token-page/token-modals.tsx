'use client';

import { fractionalTokensUnder } from '../../market/contract-rules';
import { FC, useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Service } from '../../market/token-detail';
import { displayHandle, type LiveTokenMarket } from '../../live/adapt';
import { buyQuote, minBuyUsd, sellQuote, serviceQuote, EXIT_FEE_MAX, MIN_NET_DEFAULT_TOLERANCE_BPS } from '../../market/curve';
import { COMMISSION_BPS, TRADE_FEE_BPS,
  toUnits, fromUnits, TOKEN_SCALE
} from '../../lib/contract-math';

/**
 * ★ DERIVED, NEVER TYPED OUT (2026-09-11). Both fee rows below read "Trade fee
 * (10%)" as a literal while the contract charged 5%, because a contract update
 * moved the rate and a hand-written label cannot follow one. Rendering it from
 * the same constant the arithmetic uses means the label and the number under it
 * can never disagree again.
 */
const TRADE_FEE_PCT = `${Number((TRADE_FEE_BPS / 100).toFixed(2))}%`;
/**
 * ★★★ THE MISS SLICE, MIRRORED FROM THE CONTRACT (5.2 / 13-D).
 *
 * core/ask.go Reclaim (the `slice` block, ~873-881) keeps
 * `max(1, ceil(commission x MissReclaimSliceBps / 10000))` out of an escrow
 * reclaimed after a MISS, clamped to the escrow's own credits; `commission` is
 * the escrow's held share, `floor(credits x CommissionBps / 10000)` (ask.go:543,
 * contract-math's commissionOwedForBaseUnits). CommissionBps is 1200 and
 * MissReclaimSliceBps is 2500 (core/params.go), so the slice is 3% of the
 * escrow — except that it is not, at the small end, which is the entire reason
 * this is computed rather than written as "3%":
 *
 *  - the commission FLOORS to zero at eight tokens or fewer, so v5.1
 *    (2026-09-18) put a ONE TOKEN floor under the slice. Three unanswered
 *    one-token asks used to shut a creator's inflows for seven days at a cost
 *    to the griefer of exactly nothing.
 *  - the ceiling means a 10-token escrow keeps 1 token (10%), not 0.3.
 *
 * `commissionTokens` is the chain's own `commissionCredits` off the live quote
 * when we have it; the formula is only the fallback, and it is the contract's
 * formula, not an approximation of it.
 *
 * MissReclaimSliceBps has no mirror in contract-math.ts (COMMISSION_BPS does),
 * so it is named here with its source rather than inlined as a magic 2500.
 */
const MISS_RECLAIM_SLICE_BPS = 2_500; // core/params.go MissReclaimSliceBps — 25% of the HELD commission
function missReclaimSliceTokens(escrowTokens: number, commissionTokens: number | null): number {
  // ask.go Reclaim, on UNITS: ceil(commission x 25%), floored at one whole
  // token (MissReclaimFloorUnits = 100 units), never more than the escrow.
  const units = Number.isFinite(escrowTokens) ? Math.max(0, toUnits(escrowTokens)) : 0;
  if (units <= 0) return 0;
  const commission =
    commissionTokens !== null && Number.isFinite(commissionTokens)
      ? Math.max(0, toUnits(commissionTokens))
      : Math.floor((units * COMMISSION_BPS) / 10_000);
  return fromUnits(Math.min(units, Math.max(TOKEN_SCALE, Math.ceil((commission * MISS_RECLAIM_SLICE_BPS) / 10_000))));
}
/** The creator's half and Lumen's half of it, derived the same way — tradefee.go splits floor(fee/2) to the creator and the odd base unit to the platform. */
const TRADE_FEE_HALF_PCT = `${Number((TRADE_FEE_BPS / 200).toFixed(2))}%`;
// usdWhole is gone from this file: the Ask card's posted price is now exact
// (usdPrice), which is what makes the whole-token overshoot checkable.
import { pctLabel, usdPrice } from '../../market/format';
import { writeFailureMessage } from '../write-failure';
import { useTokenAccounts } from '../../live/use-token-accounts';
import { useMagiSpendingPower } from '../../live/use-magi-spending-power';
import { HiveTopUpPanel, MagiFuelGauge, MagiFundingHelp } from '../../live/magi-fuel-gauge';
import RecipientPicker, { type RecipientResolution } from '@/blog/features/wallet/components/dialogs/shared/recipient-picker';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { bareHiveName, planHiveTopUp, type TopUpPlan } from '@/blog/lib/meritum/hive-topup';
import { rcLimitForAction } from '../../lib/vsc/rc-budget';
import { getCreatorTokensConfig } from '../../lib/creator-tokens-data-source';
import { useMagiL1Balances, type MagiL1Balances } from '@/blog/features/wallet/hooks/use-magi-l1-balances';
import { isMagiL1Configured } from '@/blog/features/wallet/lib/magi-l1-broadcast';
import type { MagiSpendingPower } from '@/blog/lib/lite/wallet/magi-balance';
import ModalShell from '../modal-shell';
import DmComposeModal from '@/blog/features/direct-messages/ui/dm-compose-modal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { sellEmptyStateMessage } from './sell-empty-state';
import { buyerOracleNotice } from '../../market/oracle-copy';
import type { Quote } from '../../types';
// ★★★ THE DIALOGS' CLAIMS ABOUT MONEY (2026-08-27). Same reason
// sell-empty-state.ts exists: this is a `'use client'` tree, so a sentence
// written inline is a sentence no test can read. disclosure-copy.ts's header
// carries the live figures each rewrite was reproduced against.
import { exitRoutesNote, interstitialLines } from './disclosure-copy';
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
  buyRows,
  effectiveExitFeePct,
  exitFeeBaseNote,
  parseAmount,
  askCostSegments,
  redeemQuote,
  sellRows
} from './trade-preview';

// ★ 'dm' is the creator direct-message compose. It is DISTINCT from 'send', which
// is the on-chain token TRANSFER dialog - do not collide the two.
export type TokenDialog = 'buy' | 'sell' | 'redeem' | 'ask' | 'send' | 'inter' | 'dm' | null;

/**
 * A small inline spinner. `border-current` so it takes the colour of whatever text
 * it sits in - white on the brand button, ink in the confirming banner - and needs
 * no palette of its own. Tailwind's `animate-spin`, no new dependency.
 */
const Spinner: FC<{ className?: string }> = ({ className }) => (
  <span
    aria-hidden="true"
    className={`inline-block h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent ${className ?? ''}`}
  />
);

/**
 * ★ THE CONFIRMING BANNER (2026-09-05, owner). Every money write now WAITS for the
 * chain to confirm (vsc-data-source.ts awaitExecution, ~20s and up to a minute).
 * During that window the button greyed with a stale "Confirm in your wallet…"
 * label - which reads as a frozen dialog after the wallet step is already done -
 * and the only account of the wait was a faint grey line easy to miss. A MOVING
 * spinner plus a plain statement of what is happening is the whole fix: the buyer
 * can see it is working, and knows why it is taking a moment. Shared by all four
 * money dialogs (buy/sell/ask/transfer), which all wait the same way.
 */
const ConfirmingOnChain: FC = () => (
  <div
    role="status"
    aria-live="polite"
    className="mt-3 flex items-center justify-center gap-2.5 rounded-card border border-line-brand-10 bg-surface-16 px-4 py-3 text-center text-caption font-medium text-ink-2 font-ui"
  >
    <Spinner />
    <span>Confirming on the Magi network. Usually a few seconds. Keep this open while it goes through.</span>
  </div>
);

export const ModalHead: FC<{ title: string; onClose: () => void }> = ({ title, onClose }) => (
  <div className="flex items-center justify-between px-6 pt-[22px]">
    <div className="font-ui text-[22px] leading-[32px] font-medium text-ink-2">{title}</div>
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

/**
 * ★ ONE SIGNATURE FUNDS AND BUYS (2026-09-15). When a Hive account cannot
 * cover the buy from Magi, size the shortfall that will ride in front of the
 * buy call from their Hive wallet (lib/meritum/hive-topup.ts). Null whenever
 * the path does not apply: not a Hive account, the chain override the L1
 * transfer needs is not configured, no fresh Magi read yet, nothing to buy,
 * or Magi already covers it (then the ordinary gate decides). Any bad input
 * from a chain read is refused by the planner and treated as "no plan".
 */
function hiveTopUpPlan(
  hiveName: string | null,
  l1Ready: boolean,
  power: MagiSpendingPower | null,
  chargedBaseUnits: number,
  hiveWallet: MagiL1Balances | null
): TopUpPlan | null {
  if (!hiveName || !l1Ready || !power || chargedBaseUnits <= 0) return null;
  try {
    const plan = planHiveTopUp({
      signer: hiveName,
      totalDueBaseUnits: chargedBaseUnits,
      magiHbdBaseUnits: power.balance.hbdBaseUnits,
      magiRcAvailable: power.rc.amount,
      magiRcMax: power.rc.maxRcs,
      // The limit the op will actually carry (op-builders.ts: config.rcLimit, else the measured default).
      rcLimitBaseUnits: getCreatorTokensConfig()?.rcLimit ?? rcLimitForAction('buy'),
      hiveLiquidHbdBaseUnits: hiveWallet ? Math.round(hiveWallet.liquidHbd.times(1000).toNumber()) : null
    });
    return plan.kind === 'not-a-hive-account' || plan.kind === 'magi-covers' ? null : plan;
  } catch {
    return null;
  }
}

const BuyModal: FC<{
  m: LiveTokenMarket;
  onBuy: (usd: number, maxTotalUsd?: number, fundFromHive?: boolean) => Promise<void>;
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
  // M-01: default to the lowest quick-pick chip ($10), not $50 — a $50 default on a
  // small market is most of the whole market, and it matched none of the 10/25/100 chips.
  const [amt, setAmt] = useState('10');
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
   * ★ A SOLD-OUT MARKET DISABLED BUY AND SAID NOTHING (2026-08-23).
   *
   * When `supply >= cap` every token is issued, the contract refuses the buy, and
   * the reader got a greyed control with the ordinary label and no explanation,
   * indistinguishable from a bug. Seen live on a cap-reached market. `>=` not
   * `==`: a cap that moves down must not leave the button live.
   */
  const soldOut = Number.isFinite(m.supply) && Number.isFinite(m.cap) && m.cap > 0 && m.supply >= m.cap;

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
  // dollar-pegged (see live/adapt.ts usdFromHbd, the one documented 1:1). The
  // affordability gauge checks the typed budget, which is also the spend ceiling
  // the parent signs (cap = usd), so there is nothing higher to account for.
  const costBaseUnits = Math.round(usd * 1000);
  const affordability = spending.affordability(costBaseUnits, 'buy');
  // ★ ONE SIGNATURE FUNDS AND BUYS (2026-09-15, owner: "if their hbd is on
  // Hive they just sign a tx directly from there"). A Hive account short on
  // Magi is no longer sent away to deposit: the shortfall moves from its Hive
  // wallet in the SAME signature (see hiveTopUpPlan). The plan is sized from
  // the CHARGED total (rows.totalUsd, what the button repeats), and the data
  // source re-sizes it from a fresh balance read before anything is signed.
  const hiveName = payer?.kind === 'hive' ? bareHiveName(payer.id) : null;
  const l1Ready = isMagiL1Configured();
  // This buyer can pay from Hive in the same signature. The flag goes to the
  // data source whenever it holds: the data source re-sizes the deposit from a
  // FRESH balance read at broadcast time, and a zero deposit is the plain buy,
  // so a stale dialog balance can neither under-deposit nor block a buyer who
  // can already pay (scrutiny F3/F4, 2026-09-15). The dialog's own plan below
  // is for what it SHOWS, and for the one honest dead end: short on Hive too.
  const hiveRail = hiveName !== null && l1Ready;
  const hiveWallet = useMagiL1Balances(hiveRail ? hiveName : '');
  const chargedBaseUnits = Number.isFinite(rows.totalUsd) && q.tokens > 0 ? Math.round(rows.totalUsd * 1000) : 0;
  const shortOnMagi = affordability === 'no_resource_credits' || affordability === 'insufficient_hbd';
  const topUp = hiveRail && shortOnMagi ? hiveTopUpPlan(hiveName, l1Ready, spending.power, chargedBaseUnits, hiveWallet.balances) : null;
  const fundPlan = topUp && (topUp.kind === 'top-up' || topUp.kind === 'hive-unknown') ? topUp : null;
  const shortOnHive = topUp?.kind === 'short-on-hive';
  const fundFromHive = hiveRail && !shortOnHive;
  const blockedBySpending = shortOnMagi && !fundFromHive;

  return (
    <ModalShell width={460} onClose={onClose} title={`Buy @${displayHandle(m.handle)} token`}>
      <ModalHead title={`Buy @${displayHandle(m.handle)} token`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <label className="mb-[7px] block text-caption font-medium text-ink-10 font-ui">Amount (USD)</label>
        <div className="mb-2.5 flex items-center rounded-xl border border-line-11 px-4 py-3 focus-within:border-line-brand-10 focus-within:ring-1 focus-within:ring-line-brand-10">
          <span className="text-[22px] leading-[34px] text-ink-2 font-num">$</span>
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
            className="ml-0.5 flex-1 border-0 text-[22px] leading-[34px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none"
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
              className="flex-1 rounded-control border border-line-11 py-2 text-caption tabular-nums text-ink-7 font-num hover:border-line-brand-10 hover:text-ink-brand-6"
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
               trade fee; priceAfter is a bare curve price. At $10 on this market
               that read "~$1.57" above "~$1.46" — an average ABOVE the ending
               price, which a rising curve makes impossible. Both labels now say
               which basis they are on, and the itemisation below shows where the
               difference went. (The cents moved when TradeFeeBps halved on
               2026-09-09: the same $10 now reads "~$1.50" above "~$1.46". The
               inversion IS the fee, so a smaller fee narrowed the gap without
               closing it. Re-measured in market/buy-preview.selftest.ts; never
               quote a rate here, the row label reads TRADE_FEE_PCT.)
            3. The fee was named in prose ("Includes a 10% trade fee" — the rate
               of the day) but never itemised, so nothing on screen reconciled to
               the amount charged.
               The sell side has itemised its fees since it was written; this is
               the same treatment on the buy side, ending in the one figure the
               CTA repeats. */}
        <div className="mb-3.5 rounded-xl border border-line-9 bg-surface-12 px-4 py-3.5 tabular-nums">
          <div className="text-[15px] leading-[24px] tabular-nums text-ink-2 font-num">
            ≈ {q.tokens} token{q.tokens === 1 ? '' : 's'}
          </div>
          <div className="mt-2 flex justify-between text-caption text-ink-10 font-ui">
            <span>Average price (incl. fees)</span>
            <span className="font-num">~{usdPrice(q.avgPrice)} each</span>
          </div>
          <div className="mt-1 flex justify-between text-caption text-ink-10 font-ui">
            <span>Curve price after your buy</span>
            <span className="font-num">~{usdPrice(q.priceAfter)}</span>
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
          <div className="mt-2.5 flex justify-between text-caption text-ink-7 font-ui">
            <span>Token cost</span>
            <span className="font-num">{usdPrice(rows.curveCostUsd)}</span>
          </div>
          <div className="mt-1.5 flex justify-between text-caption text-ink-warn-3 font-ui">
            <span>Trade fee ({TRADE_FEE_PCT})</span>
            <span className="font-num">+{usdPrice(rows.tradeFeeUsd)}</span>
          </div>
          <div className="mt-2 flex justify-between border-t border-line-2 pt-2 text-[15px] leading-[24px]">
            <span className="font-medium font-ui">Total</span>
            <span className="text-ink-2 font-num">{usdPrice(rows.totalUsd)}</span>
          </div>
          {/* Whole-token rounding: the curve mints integers, so the charge can
              land under the entered budget. Say so, using the two figures on screen. */}
          {q.tokens > 0 && usd > rows.totalUsd ? (
            <div className="mt-2 text-caption text-ink-14 font-ui">
              You get the most tokens that fit your ${usd}.
            </div>
          ) : null}
        </div>
        {/* What you can actually spend, and whether you can send anything at all. */}
        <MagiFuelGauge state={spending} costBaseUnits={costBaseUnits} kind={payer?.kind} fundedFromHive={fundFromHive && shortOnMagi} className="mb-3" />
        {topUp && spending.power ? (
          <HiveTopUpPanel plan={topUp} magiHbdBaseUnits={spending.power.balance.hbdBaseUnits} pending={hiveWallet.isLoading} className="mb-3" />
        ) : null}
        {blockedBySpending && payer && !shortOnHive ? <MagiFundingHelp kind={payer.kind} account={payer.id} className="mb-3" /> : null}
        {/* H6 (2026-08-31): the exact remedy — how much HBD to add and that credit
            refills on its own — which describeRcBudget produced and nothing rendered. */}
        {blockedBySpending && !shortOnHive
          ? (() => {
              const msg = spending.remedy(costBaseUnits, 'buy');
              return msg ? <p className="mb-3 text-caption text-ink-warn-3 font-ui">{msg}</p> : null;
            })()
          : null}
        <div className="mb-3 rounded-control bg-surface-16 px-3.5 py-3 text-caption text-ink-10 font-ui">
          The {TRADE_FEE_PCT} trade fee is on the token cost, not your budget ({TRADE_FEE_HALF_PCT} to @{displayHandle(m.handle)}, {TRADE_FEE_HALF_PCT} to Lumen).
        </div>
        {/* ★ NO DISCLOSURE PARAGRAPHS UNDER THE FEE LINE (owner, 2026-09-15: "This
            token's price floats... ALL THIS TEXT REMOVE IT: no point to it").
            The risk-note helper in disclosure-copy.ts and the one-signature /
            budget-ceiling footnote helper in trade-preview.ts are no longer
            rendered here; both stay for the interstitial and the tests. */}
        <button
          onClick={async () => {
            // q.tokens <= 0 is the same refusal the disabled attribute makes
            // below — the two must never disagree, or a keyboard activation
            // broadcasts what the pointer cannot.
            if (!Number.isFinite(usd) || usd <= 0 || q.tokens <= 0) return;
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
              await onBuy(usd, undefined, fundFromHive);
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
          disabled={!Number.isFinite(usd) || usd <= 0 || q.tokens <= 0 || busy || blockedBySpending || soldOut}
          className="w-full rounded-card bg-surface-brand-12 py-[15px] text-[15px] leading-[24px] font-medium tabular-nums text-ink-27 font-ui hover:bg-surface-brand-16 disabled:opacity-50"
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
              survives only as the spend CEILING (handleBuy's `cap`, which is `usd`),
              a limit, not a price, and it must not be shown as one.

              usdPrice, not usdWhole: two decimals, the same helper the Sell CTA already
              uses. TotalDue is a 3-decimal HBD figure, so the third decimal is rounded to
              the cent — sub-cent, and unavoidable without a formatter this feature does
              not have. */}
          {busy
            ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner /> Confirming…
              </span>
            )
            : soldOut
              ? 'Sold out. Every token is issued'
              : shortOnHive
                ? 'Not enough HBD on Hive'
              : affordability === 'no_resource_credits' && !fundFromHive
              ? 'Add HBD on Magi first'
              : affordability === 'insufficient_hbd' && !fundFromHive
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
                  // state before signing and the ceiling it signs is `usd`, the typed
                  // BUDGET, which is strictly above this figure
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
        {/* ★ CONFIRMING INDICATOR (2026-09-01), the token-page twin of the Studio's
            sticky banner. Every money write now WAITS for the chain to confirm
            (awaitExecution, ~20-72s typical, up to 180s), and `busy` holds the
            button greyed with a "Confirm in your wallet…" label for that whole
            window, which reads as broken and invites a reload that drops the
            poll. This says what is actually happening. */}
        {busy ? (
          <ConfirmingOnChain />
        ) : null}
        {failure ? (
          <div role="alert" ref={(n) => n?.scrollIntoView({ block: 'nearest' })} className="mt-2.5 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
        ) : null}
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
  // ★ FUNDING GATE for sell/redeem (2026-09-01). A sell/redeem RECEIVES HBD but
  // still costs resource credits to SUBMIT, and a wallet-only signer starts with
  // ZERO free RC, so a 0-RC holder would sign and then fail out-of-gas after the
  // whole confirm window — worst on Redeem, the only exit once a market winds
  // down. `cannotTransact` is the clean "cannot submit anything" signal (RC too
  // low), kept distinct from a failed read, so blocking on it never blocks a
  // holder who can actually pay.
  const tokenAccounts = useTokenAccounts();
  const payer = tokenAccounts.accounts.find((a) => a.canSign) ?? tokenAccounts.accounts[0] ?? null;
  const sellSpending = useMagiSpendingPower(payer?.id ?? null);
  const blockedBySpending = sellSpending.cannotTransact;
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
            className="mt-3.5 w-full rounded-card border border-line-11 bg-surface-1 py-[15px] text-[15px] leading-[24px] font-medium text-ink-7 font-ui hover:bg-surface-16"
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
          <label className="text-caption font-medium text-ink-10 font-ui">Amount (tokens)</label>
          <button
            onClick={() => setAmt(String(held))}
            className="border-0 bg-transparent text-caption font-medium tabular-nums text-ink-brand-6 font-ui"
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
            className="min-w-0 flex-1 border-0 text-[22px] leading-[34px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none"
          />
          <span className="text-caption font-medium text-ink-14 font-ui">tokens</span>
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
            <div className="mb-1.5 text-[14px] leading-[22px] tabular-nums text-ink-warn-3 font-num">
              Early-exit fee rate: {feePctLabel} now
            </div>
            <p className="mb-2.5 text-caption text-ink-warn-2 font-ui">
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
            <div className="mt-1.5 flex justify-between text-caption tabular-nums text-ink-warn-3 font-num">
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
              <div className="mb-1.5 flex justify-between text-caption text-ink-7 font-ui">
                <span>Curve proceeds</span>
                <span className="font-num">{usdPrice(rows.curveProceedsUsd)}</span>
              </div>
              {rows.exitFeeUsd > 0 ? (
                // ★ THE RATE HERE IS THE ONE THE TWO VISIBLE FIGURES STAND IN
                // (F-F). It was `feePctLabel`, the raw τ, printed beside a
                // deduction that is τ of the MATURING share only — "20%" next to
                // 8.0% of the proceeds directly above it. Now the row can be
                // checked against the row above it. pctLabel's guarantee carries:
                // a real but small deduction reads "<1%", never a flat "0%".
                <div className="mb-1.5 flex justify-between text-caption text-ink-warn-3 font-ui">
                  <span>
                    Early-exit fee ({pctLabel(effectiveExitFeePct(rows.exitFeeUsd, rows.curveProceedsUsd), 1) ?? '0%'} of
                    proceeds)
                  </span>
                  <span className="font-num">−{usdPrice(rows.exitFeeUsd)}</span>
                </div>
              ) : null}
            </>
          )}
          {/* The trade fee is a CURVE-rail charge (sell.go), at whatever
              params.go TradeFeeBps says — the row label reads TRADE_FEE_PCT and
              never a typed number. The wind-down rail (refund.go) is a pro-rata
              slice of the reserve and does not pay it, so showing it here would
              be inventing a deduction. */}
          {redeem ? null : (
            <div className="mb-2 flex justify-between text-caption text-ink-warn-3 font-ui">
              <span>Trade fee ({TRADE_FEE_PCT})</span>
              <span className="font-num">−{usdPrice(rows.tradeFeeUsd)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-line-2 pt-2 text-[15px] leading-[24px]">
            <span className="font-medium font-ui">You receive</span>
            {/* Redeem: the contract's own arithmetic on the amount being redeemed
                (refundPayout + splitDraw + the K2 carve), not a pro-rata scale of
                the whole position — see redeemQuote for why the scale over-quoted
                every partial size. Still marked approximate: the contract
                recomputes it at execution from the live reserve, supply and hold
                clock, and we will not print an exact figure we cannot guarantee. */}
            <span className="text-ink-ok-2 font-num">
              {redeem ? `≈ ${usdPrice(redeemUsd)}` : usdPrice(rows.receiveUsd)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className="mb-2 border-0 bg-transparent text-caption font-medium text-ink-10 font-ui"
        >
          Advanced {advOpen ? '▴' : '▾'}
        </button>
        {advOpen ? (
          <div className="mb-3.5">
            <label className="mb-1.5 block text-caption text-ink-10 font-ui">
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
                className="flex-1 border-0 text-[15px] leading-[24px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none"
              />
              <span className="text-caption font-medium text-ink-14 font-ui">HBD</span>
            </div>
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
          disabled={!Number.isFinite(tokens) || tokens <= 0 || held <= 0 || tokens > held || busy || blockedBySpending}
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-medium tabular-nums text-ink-27 font-ui hover:bg-surface-44 disabled:opacity-50"
        >
          {busy
            ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner /> Confirming…
              </span>
            )
            : tokens > held
              ? 'More than you hold'
              : redeem
                ? `Redeem · get ~${usdPrice(redeemUsd)}`
                : `Sell · get ~${usdPrice(q.receiveUsd)}`}
        </button>
        {blockedBySpending && payer ? <MagiFundingHelp kind={payer.kind} account={payer.id} className="mt-3" /> : null}
        {/* ★ CONFIRMING INDICATOR (2026-09-01), the token-page twin of the Studio's
            sticky banner. Every money write now WAITS for the chain to confirm
            (awaitExecution, ~20-72s typical, up to 180s), and `busy` holds the
            button greyed with a "Confirm in your wallet…" label for that whole
            window, which reads as broken and invites a reload that drops the
            poll. This says what is actually happening. */}
        {busy ? (
          <ConfirmingOnChain />
        ) : null}
        {failure ? (
          <div role="alert" ref={(n) => n?.scrollIntoView({ block: 'nearest' })} className="mt-2.5 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
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
        {/* The slippage note and the exit-routes disclosure both moved off the
            face of the card into this one hover (owner, 2026-09-01): keep the
            Sell pill uncluttered, keep every word one hover away. Both strings
            are unchanged and still true under v1 and v2 (exitRoutesNote is
            selftested; the min-net note matches MIN_NET_DEFAULT_TOLERANCE_BPS). */}
        <div className="mt-2.5 flex justify-center">
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label={redeem ? 'How redeeming works' : 'How selling works'}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-line-11 text-[11px] font-bold leading-none text-ink-14 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-brand-10"
              >
                ?
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px] text-left text-caption font-normal leading-[20px] font-ui">
                <p>
                  Pre-filled just under what you’re shown above, so the {redeem ? 'redeem' : 'sell'} reverts (nothing spent) if the net comes in lower: a price move or a same-block front-run, not you. Clear it to exit at the going rate with no minimum, or lower it to allow more slippage.
                </p>
                <p className="mt-2">{exitRoutesNote(redeem)}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
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
  const q = serviceQuote(usd, m.priceUsd, m.rules);
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
  /**
   * ★★★ PRICE-3 FIX (2026-09-08): PRICE THE ASK OFF THE LIVE SETTLEMENT QUOTE,
   * NOT OFF SPOT. The chain settles an ask at `min(TWAP_short, TWAP_long, spot)`
   * and escrows `ceil(tokenLeg / thatRate)` WHOLE tokens (ask.go creditsForAsk).
   * `serviceQuote(usd, m.priceUsd)` above prices the token leg off `m.priceUsd`,
   * which is the live SPOT price (live/adapt.ts: `usdFromHbd(spotPriceHbd)`). On
   * any market trading ABOVE its long TWAP, spot > settlement rate, so the
   * spot-derived token count is TOO LOW — measured at 13 tokens shown while the
   * chain escrowed 65 (understated 4.39x), on a screen that otherwise looked
   * normal. The CORRECT count is already fetched here as
   * `askQuote.data.creditsRequired` (the contract's own `quote` entrypoint) and
   * was previously used only to gate the button; render it as the cost instead
   * of discarding it. The signing path (use-live-token-market.ts) already re-reads
   * the quote and signs the true credits, so only the DISPLAY and the
   * affordability check understated the cost — both are corrected here off the
   * same figure. `q` is still used for the commission (a face×12% HBD leg that
   * is rate-independent) and as a pre-quote placeholder while the button is
   * blocked (`priceBlocked`) until the quote lands.
   */
  const settlementCredits = askQuote.data?.creditsRequired ?? null;
  const chainTokens = settlementCredits ?? q.tokens;
  // The commission is a SHARE of the tokens above (OWNER RULING 2026-09-12), so
  // it is priced off the same count and the same rate — never off the posted
  // face, which would report a figure the escrow does not hold.
  const commissionTokens = askQuote.data?.commissionCredits ?? null;
  const commissionUsd = commissionTokens === null ? q.commissionUsd : commissionTokens * m.priceUsd;
  const cost = askCost(usd, { tokens: chainTokens, commissionUsd }, m.priceUsd);
  const held = m.position?.tokens ?? 0;
  // PRICE-3: the balance must cover what the CHAIN escrows (chainTokens), not the
  // understated spot-derived count — otherwise a buyer is told they can afford an
  // ask the contract's maxCredits guard will reject.
  //
  // ★ THE TOKEN BALANCE IS NOW THE WHOLE CHECK (OWNER RULING 2026-09-12). An
  // H-FE-2 HBD affordability gate used to sit beside it, because the commission
  // was a separate HBD leg the buyer also had to cover — an ask signed without
  // it was rejected by the contract's exact-commission guard and burned the
  // caller's RC. There is no HBD leg to cover: a buyer holding enough of the
  // creator's token can buy the service, which is the entire point of the
  // ruling. The RESOURCE-CREDIT check stays — every write still costs RC.
  const canAffordTokens = held >= chainTokens && Number.isFinite(chainTokens);
  const askTokenAccounts = useTokenAccounts();
  // Same reasoning as `payer` above: check the balance of whoever signs.
  const askPayer = askTokenAccounts.accounts.find((a) => a.canSign) ?? askTokenAccounts.accounts[0] ?? null;
  const askSpending = useMagiSpendingPower(askPayer?.id ?? null);
  const blockedByCredits = askSpending.affordability(0, 'ask') === 'no_resource_credits';
  const canAsk = canAffordTokens && !blockedByCredits && !priceBlocked;
  return (
    <ModalShell width={500} onClose={onClose} title={`Ask @${displayHandle(m.handle)}`}>
      <ModalHead title={`Ask @${displayHandle(m.handle)}`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={`What do you want to ask @${displayHandle(m.handle)}?`}
          className="h-[120px] w-full resize-y rounded-xl border border-line-11 px-4 py-3.5 font-ui text-[15px] leading-[24px] text-ink-2 outline-none focus-visible:outline-none focus:border-line-brand-10"
        />
        <div className="my-2 mb-3.5 text-caption text-ink-14 font-ui">
          {/* ★ THE MESSAGE IS STORED AGAIN, SO THE LINE HAD TO CHANGE. The ask
              mutation now posts the buyer's text to Lumen alongside the write,
              keyed by the same content hash, so the creator reads the request
              beside the escrow it paid for (live/use-ask-notes.ts) instead of
              receiving a fingerprint and no brief. The previous line — "isn't
              stored on Lumen or on-chain" — became false the moment that
              shipped, and a privacy claim that is false is worse than none.
              WHAT GOES ON CHAIN IS UNCHANGED: askReference()'s short
              fingerprint, never the text. */}
          Your message is stored on Lumen so @{displayHandle(m.handle)} can read it with your request. Only a short fingerprint of it goes
          on-chain.
        </div>
        {/* ★ THE REFUSAL REPLACES THE PRICE, it does not sit under one. Leaving a
            cost sentence on screen beside "this cannot be bought" is the same
            mixed message as a live price on a dead market — see the askQuote doc
            above. `unavailable` here is OUR read failing, which is a different
            sentence from the chain refusing, and both are different from a price. */}
        {priceRefused && oracleStatus ? (
          <div
            className="mb-4 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3.5 text-[14px] leading-[22px] font-medium text-ink-warn-3 font-ui"
            data-testid="ask-modal-price-refused"
          >
            {buyerOracleNotice(oracleStatus, displayHandle(m.handle))}
          </div>
        ) : quoteUnreadable ? (
          <div
            className="mb-4 rounded-xl border border-line-warn-2 bg-surface-warn-4 px-4 py-3.5 text-[14px] leading-[22px] font-medium text-ink-warn-3 font-ui"
            data-testid="ask-modal-price-unreadable"
          >
            We couldn&rsquo;t work out what this would cost just now, so it can&rsquo;t be sent yet. Try again in a
            moment.
          </div>
        ) : askQuote.isLoading ? (
          <div className="mb-4 rounded-xl border border-line-9 px-4 py-3.5 text-[14px] leading-[22px] text-ink-10 font-ui">
            Checking what this costs&hellip;
          </div>
        ) : (
        <div className="mb-4 rounded-xl border border-line-9 px-4 py-3.5 text-[14px] leading-[22px] text-ink-7 font-ui">
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
          {askCostSegments(cost, fractionalTokensUnder(m.rules)).map((seg, i) =>
            seg.strong ? (
              <strong key={i} className="tabular-nums text-ink-2 font-num">
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
            Once sent, this can&rsquo;t be cancelled. If @{displayHandle(m.handle)} declines, every token comes back. If
            they haven&rsquo;t answered by your deadline, you can reclaim about an hour later:{' '}
            {missReclaimSliceTokens(chainTokens, commissionTokens) >= chainTokens ? (
              <>
                the platform keeps {chainTokens === 1 ? 'that token' : 'all of them'} so a missed deadline can&rsquo;t be manufactured for free, and the
                miss goes on their record.
              </>
            ) : (
              <>
                you get <strong className="tabular-nums font-num">{chainTokens - missReclaimSliceTokens(chainTokens, commissionTokens)}</strong> of the{' '}
                <strong className="tabular-nums font-num">{chainTokens}</strong> tokens back, the platform keeps{' '}
                <strong className="tabular-nums font-num">{missReclaimSliceTokens(chainTokens, commissionTokens)}</strong> so a missed deadline can&rsquo;t be
                manufactured for free, and the miss goes on their record.
              </>
            )}
        </div>
        )}
        <label className="mb-2 block text-caption font-medium text-ink-10 font-ui">Answer due within</label>
        <div className="mb-4 flex items-center gap-3.5">
          <input
            type="range"
            min={1}
            max={30}
            value={deadline}
            onChange={(e) => setDeadline(Number(e.target.value))}
            className="flex-1 accent-line-brand-10"
          />
          <span className="w-[70px] text-right text-[14px] leading-[22px] tabular-nums text-ink-2 font-num">
            {deadline} days
          </span>
        </div>
        {/* ★ Suppress the deposit remedy when the ORACLE is the binding constraint:
            depositing HBD does not make an unpriceable market purchasable, only more
            trading does, so stacking it under an oracle refusal points at a fix that
            is not one (43, 2026-08-31). Shown only when RESOURCE CREDITS are the real
            block — since 2026-09-12 an ask costs no HBD, so a deposit is the remedy
            for the RC floor alone, never for a commission. */}
        {blockedByCredits && askPayer && !priceBlocked ? (
          <MagiFundingHelp kind={askPayer.kind} account={askPayer.id} className="mb-3" />
        ) : null}
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
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-medium tabular-nums text-ink-27 font-ui hover:bg-surface-44 disabled:opacity-50"
        >
          {busy
            ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner /> Confirming…
              </span>
            )
            : askQuote.isLoading
              ? 'Checking the price…'
              : priceRefused
                ? 'Not available yet'
                : quoteUnreadable
                  ? 'Price unavailable'
                  : !canAffordTokens
              ? `You need ${cost.tokens} @${displayHandle(m.handle)} tokens. Buy some first`
              : blockedByCredits
                ? 'You need a little HBD on Magi for the network fee'
                : `Send question for ${cost.tokens} ${cost.tokens === 1 ? 'token' : 'tokens'}`}
        </button>
        {/* ★ CONFIRMING INDICATOR (2026-09-01), the token-page twin of the Studio's
            sticky banner. Every money write now WAITS for the chain to confirm
            (awaitExecution, ~20-72s typical, up to 180s), and `busy` holds the
            button greyed with a "Confirm in your wallet…" label for that whole
            window, which reads as broken and invites a reload that drops the
            poll. This says what is actually happening. */}
        {busy ? (
          <ConfirmingOnChain />
        ) : null}
        {failure ? (
          <div role="alert" ref={(n) => n?.scrollIntoView({ block: 'nearest' })} className="mt-2.5 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
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
  // ★ THE SAME RECIPIENT PICKER THE WALLET USES (owner, 2026-09-15: "when you
  // type the names and it checks against the chain if real name... just copy
  // that code into send meritum tokens"). It resolves a Hive name against the
  // chain as you type (avatar, display name, exists / not found / could not
  // check) or a wallet address; the button only arms on a resolved
  // destination. A failed check can still be sent on a second press, as before.
  const [resolution, setResolution] = useState<RecipientResolution>({ status: 'idle' });
  const checking = resolution.status === 'checking';
  const dest =
    resolution.status === 'ok' ? (resolution.kind === 'hive' ? resolution.name : resolution.id) : resolution.status === 'check_failed' ? resolution.name : null;
  const registerTo: UseFormRegisterReturn = {
    name: 'to',
    onChange: async (e: { target: { value: string } }) => {
      setTo(e.target.value);
      setFailure(null);
      setConfirmAnyway(false);
    },
    onBlur: async () => undefined,
    ref: () => undefined
  };
  // Set when a hive destination could not be verified to exist; a second Send
  // press then goes through. Reset whenever the destination changes.
  const [confirmAnyway, setConfirmAnyway] = useState(false);
  const tokens = parseFloat(amt.replace(/,/g, '')) || 0;
  const valid = dest !== null && Number.isFinite(tokens) && tokens > 0 && tokens <= held;
  return (
    <ModalShell width={420} onClose={onClose} title={`Send @${displayHandle(m.handle)} tokens`}>
      <ModalHead title={`Send @${displayHandle(m.handle)} tokens`} onClose={onClose} />
      <div className="px-6 pb-6 pt-[18px]">
        <div className="mb-3.5">
          <RecipientPicker mode="magi" label="To (Hive name or wallet address)" register={registerTo} value={to} onResolved={setResolution} testId="meritum-send-to" />
        </div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-caption font-medium text-ink-10 font-ui">Amount (tokens)</label>
          <button
            onClick={() => setAmt(String(held))}
            className="border-0 bg-transparent text-caption font-medium tabular-nums text-ink-brand-6 font-ui"
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
          className="mb-3.5 w-full rounded-xl border border-line-11 px-4 py-3 text-[22px] leading-[34px] tabular-nums text-ink-2 font-num outline-none focus-visible:outline-none focus:border-line-brand-10 focus:ring-1 focus:ring-line-brand-10"
        />
        <button
          onClick={async () => {
            if (!valid) return;
            // F7: synchronous — see BuyModal's `inFlight` doc.
            if (inFlight.current) return;
            // ★ EXISTENCE CHECK for hive destinations (2026-09-01, 57 confirmed
            // against core). The transfer contract CREDITS a well-formed but
            // NONEXISTENT hive account, so a typo is a permanent, unrecoverable
            // send that a stranger could later claim by registering that name.
            // did:pkh has no registry, so shape is all there is for those.
            if (dest === null) return;
            if (resolution.status === 'check_failed' && !confirmAnyway) {
              setConfirmAnyway(true);
              setFailure(`Could not verify @${dest} exists right now. Sends are permanent and cannot be undone. Press Send again to send anyway.`);
              return;
            }
            inFlight.current = true;
            setBusy(true);
            setFailure(null);
            try {
              // ★ The RECIPIENT is passed now. It was collected by the input
              // above and then DROPPED — onTransfer only ever received the
              // amount, so a real send would have gone nowhere or to the wrong
              // account. Strip a leading '@': the field invites one, the chain
              // account name never has one.
              await onTransfer(dest, tokens);
              onClose();
            } catch (err) {
              // The REAL reason, not a guess. See ../write-failure.ts.
              setFailure(writeFailureMessage(err, 'That send didn’t go through.'));
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
          disabled={!valid || busy || checking}
          className="w-full rounded-card bg-surface-42 py-[15px] text-[15px] leading-[24px] font-medium tabular-nums text-ink-27 font-ui hover:bg-surface-44 disabled:opacity-50"
        >
          {checking
            ? 'Checking the account…'
            : busy
              ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner /> Confirming…
              </span>
            )
              : tokens > held
                ? 'More than you hold'
                : confirmAnyway
                  ? `Send ${tok(tokens)} tokens anyway`
                  : `Send ${tok(tokens)} tokens`}
        </button>
        {/* ★ CONFIRMING INDICATOR (2026-09-01), the token-page twin of the Studio's
            sticky banner. Every money write now WAITS for the chain to confirm
            (awaitExecution, ~20-72s typical, up to 180s), and `busy` holds the
            button greyed with a "Confirm in your wallet…" label for that whole
            window, which reads as broken and invites a reload that drops the
            poll. This says what is actually happening. */}
        {busy ? (
          <ConfirmingOnChain />
        ) : null}
        {failure ? (
          <div role="alert" ref={(n) => n?.scrollIntoView({ block: 'nearest' })} className="mt-2.5 text-center text-caption font-medium text-ink-brand-6 font-ui">{failure}</div>
        ) : null}
        <div className="mt-2.5 text-center text-caption text-ink-14 font-ui">
          Sends are permanent and cannot be undone. Free and instant on Lumen, never blocked by billing.
        </div>
      </div>
    </ModalShell>
  );
};

const InterstitialModal: FC<{ handle: string; onClose: () => void }> = ({ onClose }) => (
  <ModalShell width={480} onClose={onClose} title="Before you trade this token">
    <div className="px-6 py-[26px]">
      <div className="mb-[18px] font-ui text-[22px] leading-[34px] font-medium text-ink-2">
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
          <p key={i} className="font-ui text-[14px] leading-[22px] text-ink-7">
            {line}
          </p>
        ))}
      </div>
      <div className="flex gap-3">
        <button
          onClick={onClose}
          /* ★★ THE PRIMARY BUTTON INVERTS IN DARK (owner: "its pill is invisible. its
             just text i hover over to see pill"). `bg-surface-42` is #1a1a17 in
             light — a near-BLACK button carrying white text, which is the whole
             point of it. Mapped into dark by lightness it became #2c3036, a grey
             a few points off the #16181b panel it sits on, so white text on it
             looked like text on the panel until the hover lifted it. A near-black
             primary in light is a near-WHITE primary in dark; that is the same
             design idea mirrored, and it is what `bg-primary` already does on
             /service-unavailable. */
          className="flex-1 rounded-xl bg-surface-42 py-3.5 text-[15px] leading-[24px] font-medium text-ink-27 font-ui hover:bg-surface-44 dark:bg-[rgb(var(--ink-2))] dark:text-[rgb(var(--surface-23))] dark:hover:bg-[rgb(var(--ink-10))]"
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
  onBuy: (usd: number, maxTotalUsd?: number, fundFromHive?: boolean) => Promise<void>;
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
  // Creator DM compose. Self-contained (its own keypair + encryption + send), so it
  // takes none of the money-path callbacks above - just the recipient and a close.
  if (dialog === 'dm') return <DmComposeModal recipientHandle={market.handle} onClose={onClose} />;
  if (dialog === 'inter') return <InterstitialModal handle={market.handle} onClose={onClose} />;
  return null;
};

export default TokenModals;
