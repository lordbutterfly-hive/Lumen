/**
 * THE TRADE DIALOGS' ARITHMETIC AND THE SENTENCES BUILT FROM IT.
 *
 * Same reason `sell-empty-state.ts` and `disclosure-copy.ts` exist: token-modals
 * .tsx is a `'use client'` tree, so a number computed inline there is a number no
 * test can read, and every defect below was a number (or a claim about one) that
 * nobody could assert on.
 *
 * Everything here is PURE. The live figures each function was reproduced against
 * are recorded on the function, so a later reader can re-run the measurement
 * rather than trust the prose.
 *
 * ★ ONE RULE GOVERNS THE WHOLE FILE: a figure shown to a holder about their own
 * money must be EQUAL TO, or CONSERVATIVE AGAINST, what the contract will
 * actually pay or charge. Never the other way. A payout preview that rounds in
 * the holder's favour is not optimism, it is a quote that reverts.
 */

import {
  BLOCKS_PER_DAY,
  humanToBaseUnits,
  refundNetBaseUnits
} from '../../lib/contract-math';

/** HBD base units -> dollars. HBD is the dollar-pegged unit these screens print (live/adapt.ts usdFromHbd is the documented 1:1). */
function usdFromBaseUnits(baseUnits: number): number {
  return baseUnits / 1000;
}

/** The same two-decimal money label market/format.ts's usdPrice renders, so a segment can be compared to what is on screen. */
function usdAmount(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// =====================================================================
// F-A — THE PARTIAL REDEEM QUOTE
// =====================================================================

export interface RedeemQuoteInput {
  /** The market's reserve in dollars (LiveTokenMarket.reserveUsd). */
  reserveUsd: number;
  /** The market's whole-token supply (LiveTokenMarket.supply). */
  supplyTokens: number;
  /** The holder's WHOLE position — maturing + matured (core/matured.go totalBalance). */
  heldTokens: number;
  /** The MATURING half of that position. Omitted ⇒ treat it all as maturing, which OVER-states the tax. */
  maturingTokens?: number;
  /** The holder's hold clock in whole days (LiveHolderPosition.heldDays). */
  heldDays: number;
  /** How many tokens the reader has asked to redeem. */
  tokens: number;
}

export interface RedeemQuote {
  /** The whole token count actually quoted, clamped to the position. */
  tokens: number;
  /** refund.go refundPayout — floor(reserve · tokens / supply), pre-tax. */
  grossUsd: number;
  /** The K2 exit tax carved from the MATURING share of THIS draw. */
  taxUsd: number;
  /** What the holder receives: gross − tax. This is what refund() transfers. */
  netUsd: number;
  /** The rate the tax was struck at, in basis points. */
  taxBps: number;
}

/**
 * ★★★ THE PARTIAL REDEEM WAS SCALED LINEARLY AND EVERY PARTIAL SIZE REVERTED
 * (fixed 2026-08-27, a regression introduced the same day).
 *
 * The dialog computed
 *
 *     redeemUsd = position.floorValueUsd * tokens / held
 *
 * which is only correct while the tax is a flat rate on the whole gross. It
 * stopped being that when `floorValueUsd` became the SPLIT-AWARE net
 * (lib/vsc-data-source.ts:502-508 now passes `tokensMaturing` into
 * refundNetBaseUnits). The contract does not scale: core/refund.go:282-283 runs
 * `splitDraw` on the REDEEMED amount, and splitDraw is MATURING-FIRST
 * (core/matured.go:185-195), so any draw with `tokens <= maturing` is taxed on
 * its WHOLE gross while the whole-position figure it was scaled from was taxed
 * on only the maturing fraction.
 *
 * MEASURED (reserve 120000 base units, supply 1000, held 100 = 40 maturing + 60
 * matured, h = 0 ⇒ τ = 2000 bps). "chain" is refundNetBaseUnits with the
 * REDEEMED count, i.e. what refund() pays:
 *
 *     redeem  10   chain    960   linear  1104.0  (+15.0%)   minNet 1093.0 → REVERTS
 *     redeem  40   chain   3840   linear  4416.0  (+15.0%)   minNet 4371.8 → REVERTS
 *     redeem  80   chain   8640   linear  8832.0  (+2.2%)    minNet 8743.7 → REVERTS
 *     redeem 100   chain  11040   linear 11040.0  (0%)       → the ONLY size that worked
 *
 * The over-quote is bounded by (1 − τ·maturing/held)/(1 − τ), i.e. it approaches
 * 1/(1 − τ) = +25% as the maturing share goes to zero; measured +24.75% at
 * maturing/held = 1/100 with τ = 20%. The default minNet floor is 1%
 * (MIN_NET_DEFAULT_TOLERANCE_BPS), so every one of those reverts — and
 * refund() (lib/vsc-data-source.ts:1668) has no fresh-quote pre-check the way
 * sell() does, so the dialog closes as if it had succeeded.
 *
 * THIS FUNCTION IS THE CONTRACT'S OWN ARITHMETIC, not an approximation of it:
 * refundNetBaseUnits(reserve, REDEEMED, supply, heldBlocks, MATURING BALANCE) is
 * a faithful port of refundPayout + splitDraw + maturingGrossShare + ExitTaxOn,
 * and splitDraw takes the holder's whole maturing BALANCE (core/refund.go:282
 * reads kBal, not a pre-split draw), which is exactly what the fifth argument
 * means (lib/contract-math.ts:653-654).
 *
 * ★ THE ONE APPROXIMATION, AND ITS DIRECTION. The view-model carries `heldDays`
 * (floor of blocks/day, live/adapt.ts:277), not `heldBlocks`, so the rate is
 * struck at `heldDays × BLOCKS_PER_DAY <= heldBlocks`. ExitTaxBpsAt is
 * NON-INCREASING in held blocks (core/exittax.go:91-102), so a low block count
 * gives a rate that is too HIGH, a tax that is too LARGE and a net that is too
 * SMALL — the conservative direction. The size of the error is one day of decay
 * on the TAXABLE BASE (48 bps: ExitTaxBpsAt's ceil makes the daily step 48, not
 * 2000/42 = 47.62) plus at most one base unit from ExitTaxOn's own ceil.
 * MEASURED WORST over the golden set: 0.499% of gross, on a 1-token draw
 * grossing 1203 units where that single-unit residue is the larger half of it.
 * Comfortably inside the 1% minNet headroom, so it can never cause a revert.
 *
 * ★ IT IS ALSO THE GAP AGAINST THE POSITION CARD on the page behind this dialog,
 * which shows `floorValueUsd` computed from the TRUE heldBlocks. The dialog reads
 * at or below that card, never above. If `heldBlocks` is ever surfaced on
 * LiveHolderPosition, pass it straight through and both notes go away.
 */
export function redeemQuote(input: RedeemQuoteInput): RedeemQuote {
  const supply = Math.max(0, Math.floor(input.supplyTokens));
  const held = Math.max(0, Math.floor(input.heldTokens));
  // The same integer lattice the curve and the reserve share are priced on.
  const wanted = Number.isFinite(input.tokens) ? Math.floor(input.tokens) : 0;
  const tokens = Math.max(0, Math.min(wanted, held, supply));
  const reserveBaseUnits = humanToBaseUnits(input.reserveUsd);
  if (tokens <= 0 || supply <= 0 || reserveBaseUnits <= 0) {
    return { tokens: 0, grossUsd: 0, taxUsd: 0, netUsd: 0, taxBps: 0 };
  }
  const heldBlocks = Math.max(0, Math.floor(input.heldDays)) * BLOCKS_PER_DAY;
  // splitDraw's own input: the holder's maturing BALANCE. Absent ⇒ the whole
  // position, which over-states the tax (contract-math.ts:649-654) — the safe
  // reading, and the same one CurveMarketInput documents for the sell side.
  const maturingBalance =
    input.maturingTokens === undefined
      ? held
      : Math.max(0, Math.min(held, Math.floor(input.maturingTokens)));
  const q = refundNetBaseUnits(reserveBaseUnits, tokens, supply, heldBlocks, maturingBalance);
  return {
    tokens,
    grossUsd: usdFromBaseUnits(q.grossBaseUnits),
    taxUsd: usdFromBaseUnits(q.taxBaseUnits),
    netUsd: usdFromBaseUnits(q.netBaseUnits),
    taxBps: q.taxBps
  };
}

// =====================================================================
// F-B — WHAT MAY BE TYPED INTO A MONEY FIELD
// =====================================================================

/** A positive decimal, possibly mid-typing. Commas are thousands separators and are stripped by the readers (token-modals.tsx's `parseFloat(amt.replace(/,/g, ''))`). */
const POSITIVE_DECIMAL_IN_PROGRESS = /^[0-9,]*\.?[0-9]*$/;

/**
 * ★★★ STRIPPING THE MINUS SIGN MANGLED THE REST OF THE INPUT (fixed 2026-08-27,
 * a regression introduced the same day).
 *
 * The amount field ran `e.target.value.replace(/-/g, '')`. The intent was to
 * REFUSE a negative budget; what it did was delete the character and keep
 * whatever the rest of the string then meant. Measured on the live field:
 *
 *     "-5"    → field "5"    → usd 5        (was correctly DISABLED as negative;
 *                                            became a live $5 buy)
 *     "1e-5"  → field "1e5"  → usd 100000   (a 20,000,000,000x error)
 *     "2e-3"  → field "2e3"  → usd 2000
 *     "1-2"   → field "12"   → usd 12
 *
 * A refusal is not a substitution. This REJECTS the whole proposed value and
 * keeps what was there before, so nothing is silently rewritten — the behaviour
 * a paste as well as a keystroke needs, and the one that cannot invent a number
 * the reader never typed.
 *
 * Commas stay legal: the readers strip them as thousands separators ("1,000" →
 * 1000), and refusing them here would break a habit the field already supports.
 * An empty string is legal — a cleared field is not an invalid one, it is zero,
 * and the buttons are already disabled on zero.
 */
export function acceptAmountText(previous: string, proposed: string): string {
  if (typeof proposed !== 'string') return previous;
  if (proposed === '') return '';
  if (!POSITIVE_DECIMAL_IN_PROGRESS.test(proposed)) return previous;
  return proposed;
}

/** The readers' own parse, in one place: commas are separators, anything unparseable is zero. */
export function parseAmount(text: string): number {
  const n = parseFloat(String(text).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// =====================================================================
// F-C — THE "MAX PRICE PER TOKEN" CAP
// =====================================================================

/**
 * Headroom over the quote's own ALL-IN average price, used to pre-fill the cap.
 *
 * 5% was the figure the field already defaulted to; what changed is the BASIS it
 * is 5% of. It used to be 5% over the bare curve spot price, which is not a
 * price anyone pays — see `resolveMaxPriceCap` for the measurement.
 */
export const MAX_PRICE_DEFAULT_HEADROOM_BPS = 500; // 5%

export interface MaxPriceCapInput {
  /** Whole tokens the budget buys (BuyQuote.tokens). */
  tokens: number;
  /** Total charged for them, curve cost + 10% trade fee (BuyQuote.totalUsd). */
  totalUsd: number;
  /** totalUsd / tokens — the ALL-IN price per token (BuyQuote.avgPrice). */
  avgPrice: number;
}

export interface MaxPriceCap {
  /** The parsed cap, or null when the field names none. */
  maxPricePerTokenUsd: number | null;
  /** The fee-inclusive TOTAL ceiling to sign for, or undefined for "no cap". */
  maxTotalUsd: number | undefined;
  /** True when this quote already costs more per token, all in, than the cap allows. */
  overMax: boolean;
  /** The single sentence to render under the field, or null when the cap is simply working. */
  note: string | null;
}

/**
 * ★★★ THE CAP REFUSED EVERY BUY THERE WAS (fixed 2026-08-27, pre-existing).
 *
 * Two basis errors compounded. `overMax` compared the reader's max against
 * `q.priceAfter`, a BARE CURVE price with no fee in it; `maxTotalUsd` was
 * `maxP × q.tokens` and was then checked in token-market-view.tsx's handleBuy
 * against `authoritative.totalDueHbd`, which INCLUDES the 10% trade fee. The
 * field defaulted to 5% over spot. Since TotalDue >= 1.10 × price(S) × n >
 * 1.05 × price(S) × n, the check could never pass.
 *
 * MEASURED at zero price drift, default cap, over supply {10, 50, 100, 500,
 * 1000} × budget {$10, $25, $50, $100}: 19 of 19 combinations refused, 11 of
 * them with the button still ENABLED and no local warning — so the reader
 * clicked, and handleBuy threw "The price moved above your limit" when nothing
 * had moved. With the basis fixed: 0 of 19 refused.
 *
 * ★ THE RULING, AND WHY. "Max price per token" now means the ALL-IN price —
 * what leaves your account, divided by the tokens you get. Three reasons, in
 * order of weight:
 *
 *  1. It is the only basis that can be ENFORCED. The chain's slippage
 *     protection is the buyer's signed transfer.allow on TotalDue (buy.go), a
 *     fee-inclusive total. A bare-curve cap has to have the fee added back
 *     before it can bind, which means the number the reader typed is not the
 *     number that protects them — exactly the gap that produced this defect.
 *  2. It is like-for-like with the figure the card already leads with,
 *     "Average price (incl. fees)" (BuyQuote.avgPrice). A cap on a number the
 *     reader can see is a cap they can check.
 *  3. It is the conservative reading. An all-in cap of $X binds at $X; a
 *     bare-curve cap of $X lets $1.10·X leave the account.
 */
export function resolveMaxPriceCap(text: string, q: MaxPriceCapInput): MaxPriceCap {
  const parsed = parseFloat(String(text).replace(/,/g, ''));
  const hasCap = Number.isFinite(parsed) && parsed > 0;
  if (!hasCap) {
    return {
      maxPricePerTokenUsd: null,
      maxTotalUsd: undefined,
      overMax: false,
      // ★ AN EMPTY OR ZERO CAP MEANT "NO CAP" AND SAID NOTHING (F-B, same pass).
      // The reader had opened Advanced precisely to set a limit; leaving the
      // field blank silently removed the one they thought they had. It is not an
      // error — handleBuy still holds the typed budget as the ceiling — so this
      // states what is actually protecting them rather than blocking anything.
      note: 'No price cap set. Your budget is the only limit on this buy.'
    };
  }
  const tokens = Number.isFinite(q.tokens) ? Math.max(0, Math.floor(q.tokens)) : 0;
  if (tokens <= 0) {
    return { maxPricePerTokenUsd: parsed, maxTotalUsd: undefined, overMax: false, note: null };
  }
  const maxTotalUsd = parsed * tokens;
  return {
    maxPricePerTokenUsd: parsed,
    maxTotalUsd,
    // Like for like: both sides are the ALL-IN cost of one token. `avgPrice` is
    // totalUsd/tokens, and maxTotalUsd is parsed×tokens, so this is exactly the
    // same comparison handleBuy makes on the total, one division down.
    overMax: q.totalUsd > maxTotalUsd,
    note: null
  };
}

/**
 * The cap to pre-fill while the reader has not touched the field — the SAME
 * idiom the sell dialog's minimum-net floor already uses (a default that tracks
 * the live quote until it is edited), for the same reason: a default frozen at
 * mount stops describing the amount now being bought.
 *
 * Rounded UP to the cent, never `toFixed`: `toFixed` rounds to nearest, and on a
 * token under $0.10 that can land the pre-filled cap BELOW the price it is meant
 * to allow, which is the self-refusing default all over again one scale down.
 */
export function defaultMaxPriceText(avgPrice: number, headroomBps: number = MAX_PRICE_DEFAULT_HEADROOM_BPS): string {
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return '';
  const withHeadroom = (avgPrice * (10_000 + headroomBps)) / 10_000;
  return (Math.ceil(withHeadroom * 100) / 100).toFixed(2);
}

// =====================================================================
// F-D — WHAT AN ASK REALLY COSTS
// =====================================================================

export interface AskCost {
  /** WHOLE tokens escrowed — ask.go creditsForAsk ceils, so this is never fractional. */
  tokens: number;
  /** Those tokens' value at the rate the quote was struck at. */
  tokenLegUsd: number;
  /** The 12% platform commission, a SEPARATE HBD leg. */
  commissionUsd: number;
  /** tokenLegUsd + commissionUsd — what actually leaves the buyer. */
  totalUsd: number;
  /** The creator's posted price, for comparison. */
  postedUsd: number;
}

/**
 * ★★★ THE ASK DIALOG UNDERSTATED THE REAL COST BY UP TO 65% (fixed 2026-08-27).
 *
 * It printed the creator's POSTED price as "$15 total". What leaves the buyer is
 * `ceil(tokenLeg / rate)` WHOLE tokens plus the HBD commission, and the ceiling
 * is the whole defect: a token leg worth $13.20 cannot buy 1.15 tokens, it buys
 * 2. MEASURED, on a $15 service:
 *
 *     supply    50   10 tokens ($14.00) + $1.80 commission = $15.80   vs "$15"  (+5.3%)
 *     supply  1000    2 tokens ($23.00) + $1.80 commission = $24.80   vs "$15"  (+65.3%)
 *
 * The gap grows with the token price, because one indivisible token is a larger
 * and larger overshoot of the posted amount.
 *
 * ★ THIS DOES NOT DISTURB THE USER RULING OF 2026-07-27 ("the posted USD price
 * is the buyer's TOTAL — 12% is a SEPARATE HBD platform commission, never
 * tokens"). That ruling is about the SPLIT, and the split is unchanged and still
 * named. What it never spoke to is the whole-token ceiling, which is where the
 * overshoot comes from — so the posted price stays on screen as the posted
 * price, and the overshoot is disclosed beside it instead of being hidden
 * behind it.
 */
/** One run of the sentence, `strong` where the figure carries emphasis. Same shape as disclosure-copy.ts's CopySegment. */
export interface CostSegment {
  text: string;
  strong: boolean;
}

/**
 * The ask card's cost sentence, as SEGMENTS rather than as JSX.
 *
 * ★★★ WHY SEGMENTS AND NOT INLINE JSX, learned the hard way in this very pass.
 * The first draft wrote the sentence inline with a `{/* … *\/}` note explaining
 * one of the formatters, and dropped it BETWEEN two text runs. JSX strips the
 * whitespace-only lines either side of an expression container, so
 * "…against a" + comment + "posted price of…" renders as "against aposted price
 * of" — a defect that typechecks, lints and passes every string scan, and that
 * only a reader would ever see. The same reason disclosure-copy.ts's
 * positionSegments exists: a sentence assembled here can be asserted here,
 * whitespace and all, and a comment can never land inside it.
 */
export function askCostSegments(cost: AskCost): CostSegment[] {
  const plural = cost.tokens === 1 ? '' : 's';
  return [
    { text: 'This costs ', strong: false },
    { text: `${cost.tokens} token${plural}`, strong: true },
    { text: ' from your balance, worth about ', strong: false },
    { text: usdAmount(cost.tokenLegUsd), strong: true },
    { text: ' at today\u2019s price, plus a separate ', strong: false },
    { text: usdAmount(cost.commissionUsd), strong: true },
    { text: ' platform commission paid in HBD. That is about ', strong: false },
    { text: usdAmount(cost.totalUsd), strong: true },
    { text: ' in all, against a posted price of ', strong: false },
    // usdAmount, never a whole-dollar rounding: the sentence exists so the reader
    // can reconcile the gap between the posted price and the real cost, and a
    // posted $12.50 printed as "$13" makes that gap un-checkable.
    { text: usdAmount(cost.postedUsd), strong: true },
    { text: '. Tokens are whole, so the last one rounds up.', strong: false }
  ];
}

/** The same sentence as one string, for assertions and the dash sweep. */
export function askCostLine(cost: AskCost): string {
  return askCostSegments(cost).map((s) => s.text).join('');
}

export function askCost(usdPosted: number, q: { tokens: number; commissionUsd: number }, priceUsd: number): AskCost {
  const tokens = Number.isFinite(q.tokens) ? Math.max(0, Math.floor(q.tokens)) : 0;
  const rate = Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : 0;
  const commissionUsd = Number.isFinite(q.commissionUsd) ? Math.max(0, q.commissionUsd) : 0;
  const tokenLegUsd = tokens * rate;
  return {
    tokens,
    tokenLegUsd,
    commissionUsd,
    totalUsd: tokenLegUsd + commissionUsd,
    postedUsd: Number.isFinite(usdPosted) ? usdPosted : 0
  };
}

// =====================================================================
// F-G — AN ITEMISATION THAT ADDS UP
// =====================================================================

const cents = (usd: number): number => (Number.isFinite(usd) ? Math.round(usd * 100) : 0);

export interface BuyRows {
  curveCostUsd: number;
  tradeFeeUsd: number;
  totalUsd: number;
}

/**
 * ★★★ THE ROWS DID NOT SUM TO THE TOTAL THEY WERE UNDER (fixed 2026-08-27).
 *
 * Every row was formatted independently to two decimals off a three-decimal HBD
 * figure, so the visible arithmetic failed whenever the residues did not cancel.
 * Reproduced at supply 0 on a $12 budget:
 *
 *     Curve cost      $10.43
 *     Trade fee (10%)  +$1.04
 *     Total charged   $11.48        ← 10.43 + 1.04 = 11.47
 *
 * ★ MEASURED OFF THE RENDERED STRINGS, not off the floats behind them — the
 * claim is about what a reader can add up, so the instrument has to be the
 * number they actually see (`parseFloat(usdPrice(x))`). Comparing rounded floats
 * instead reports 45.2%/65.0% here, which is the comparison's own error, not the
 * screen's; the figures below are the honest ones.
 *
 *     BUY   supply 0..200 step 7 × budget $1..$200 step 3      507 / 1,914 = 26.5%
 *     SELL  supply 10..400 step 13 × 1..60 tokens step 3
 *           × {0, 10, 21, 41} days                             834 / 2,244 = 37.2%
 *
 * The stated purpose of itemising at all was that the reader can add the screen
 * up.
 *
 * ★ WHICH ROW ABSORBS THE RESIDUE IS NOT ARBITRARY. The row the call to action
 * repeats — what you are CHARGED on a buy, what you RECEIVE on a sell — is
 * rounded from the real figure and never touched again; the residue lands on the
 * derived row (the curve's own cost, the gross proceeds), which is the quantity
 * nobody signs for. It moves at most one cent on a buy and at most two on a
 * sell, and it moves it AWAY from the number that binds.
 */
export function buyRows(q: { curveCostUsd: number; tradeFeeUsd: number; totalUsd: number }): BuyRows {
  const totalC = cents(q.totalUsd);
  const feeC = cents(q.tradeFeeUsd);
  return { curveCostUsd: (totalC - feeC) / 100, tradeFeeUsd: feeC / 100, totalUsd: totalC / 100 };
}

export interface SellRows {
  curveProceedsUsd: number;
  exitFeeUsd: number;
  tradeFeeUsd: number;
  receiveUsd: number;
}

/** The sell side of `buyRows` — the anchor is "You receive", and the gross absorbs the residue. */
export function sellRows(q: {
  curveProceedsUsd: number;
  exitFeeUsd: number;
  tradeFeeUsd: number;
  receiveUsd: number;
}): SellRows {
  const netC = cents(q.receiveUsd);
  const taxC = cents(q.exitFeeUsd);
  const feeC = cents(q.tradeFeeUsd);
  return {
    curveProceedsUsd: (netC + taxC + feeC) / 100,
    exitFeeUsd: taxC / 100,
    tradeFeeUsd: feeC / 100,
    receiveUsd: netC / 100
  };
}

// =====================================================================
// F-F — THE EXIT-FEE RATE AND THE AMOUNT BESIDE IT
// =====================================================================

/**
 * ★★★ THE RATE ON THE LABEL WAS NOT THE RATE OF THE DEDUCTION (fixed
 * 2026-08-27).
 *
 * The itemised row read `Early-exit fee (20%)` beside an amount that was not 20%
 * of anything on screen. Since the two-bucket fix (core/matured.go:197-219,
 * ported at contract-math.ts:641-657) the tax is struck on the MATURING share of
 * the draw only, so a holder with matured tokens pays a rate on part of their
 * proceeds and the blended, visible rate is lower. MEASURED on the canonical
 * position — 100 tokens, 40 maturing, τ = 20% — the row said 20% next to a
 * deduction of 8.0% of the proceeds shown directly above it.
 *
 * This returns the rate the two VISIBLE figures actually stand in, so the row
 * can be checked against the row above it. `pctLabel`'s own guarantee carries:
 * a real but small deduction reads "<1%", never a flat "0%".
 */
export function effectiveExitFeePct(exitFeeUsd: number, curveProceedsUsd: number): number {
  if (!Number.isFinite(exitFeeUsd) || !Number.isFinite(curveProceedsUsd) || curveProceedsUsd <= 0) return 0;
  return Math.max(0, Math.min(1, exitFeeUsd / curveProceedsUsd));
}

/**
 * The clause that names what the headline RATE applies to, or '' when the whole
 * position is maturing and the rate needs no qualification.
 *
 * Without it the strip's "20% now" and the itemised row's effective percentage
 * are two different numbers on one screen with nothing saying why.
 */
export function exitFeeBaseNote(heldTokens: number, maturingTokens: number | undefined): string {
  if (maturingTokens === undefined) return '';
  const held = Math.max(0, Math.floor(heldTokens));
  const maturing = Math.max(0, Math.min(held, Math.floor(maturingTokens)));
  const matured = held - maturing;
  if (held <= 0 || matured <= 0) return '';
  if (maturing <= 0) {
    return `All ${matured} of your tokens have finished maturing, so this rate no longer costs you anything.`;
  }
  return `It applies to the ${maturing} of your ${held} tokens still maturing; the other ${matured} have finished and pay none of it.`;
}

// =====================================================================
// F-E — WHAT THE BUY BUTTON PROMISES
// =====================================================================

/**
 * ★★★ "BUY FOR $X" WAS A PREVIEW WEARING THE CLOTHES OF A PRICE (fixed
 * 2026-08-27, a regression introduced the same day).
 *
 * The label prices the LOCAL quote, but token-market-view.tsx's handleBuy
 * re-quotes against live state before signing and the ceiling it signs is
 * `maxTotalUsd ?? usd` — the TYPED BUDGET, which is strictly ABOVE the label
 * whenever the integer token count leaves change. Under ordinary supply drift
 * between the render and the click the charge therefore lands above the label
 * and still executes. MEASURED, $50 budget at supply 50 (label $48.59):
 *
 *     +5 supply    charged $49.90   +$1.31 over the label, inside the budget → EXECUTES
 *     +10 supply   charged $51.22   past the $50 budget → handleBuy refuses
 *
 * so the exposure is bounded by the budget, and it is exactly the slack between
 * the label and the budget that the label never mentions.
 *
 * The re-quote is correct and stays. What was wrong is that the label named a
 * number strictly below the ceiling with no qualifier at all, while every other
 * estimate in these dialogs is marked `≈` or `~`. So: the tilde, and one
 * sentence naming the ceiling that actually binds — which is a real guarantee,
 * not a hedge (handleBuy refuses outright above it), and therefore worth stating
 * rather than leaving the reader to infer.
 */
export function buyCeilingNote(ceilingUsd: number, hasExplicitCap: boolean): string {
  const amount = `$${Math.max(0, ceilingUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return hasExplicitCap
    ? `Re-quoted live before you sign. It will not charge more than your cap of ${amount}.`
    : `Re-quoted live before you sign. It will not charge more than your ${amount} budget.`;
}
