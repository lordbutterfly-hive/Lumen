import {
  ASSET_DECIMALS,
  BLOCKS_PER_DAY,
  MAX_EXIT_TAX_BPS,
  TRADE_FEE_BPS,
  creditsForAskBaseUnits,
  displayPricePerTokenBaseUnits,
  exitTaxBpsAt,
  exitTaxOnBaseUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  spotRateBaseUnits,
  splitFaceBaseUnits,
  tokensAffordableForBudget
} from '../lib/contract-math';

/**
 * Buy/Sell preview math for the token modals.
 *
 * ★ REWRITTEN 2026-07-24. This file used to APPROXIMATE the curve — it priced
 * a trade as "the mid-point of a linear move" and carried a 15% early-exit fee
 * decaying over 42 days. Every one of those numbers was wrong:
 *
 *   - the real curve is price(i) = 1000 + 63i/8 + 21i²/8000 (base units) with
 *     the reserve held at the EXACT integer area under it, not a linear ramp;
 *   - the real exit tax maxes at 20% (MaxExitTaxBps = 2000), not 15%;
 *   - the real trade fee applies to the GROSS curve proceeds, not to the
 *     post-exit-tax remainder, so the old sell preview under-charged it;
 *   - the real tax is ceil() on gross proceeds with no cap, which is what
 *     makes it un-splittable — a floor() approximation is evadable in chunks.
 *
 * It now delegates every number to lib/contract-math.ts, which is a
 * term-for-term port of core/curve.go, core/buy.go, core/sell.go and
 * core/exittax.go. A preview that disagrees with the chain is worse than no
 * preview: the user signs a transfer.allow against it.
 *
 * DENOMINATION. The UI is denominated in USD (the North Star: "tokens
 * denominated in USD"); the contract settles in HBD. HBD is a USD-pegged
 * stablecoin, so the two are treated 1:1 here and `usd` is simply HBD with a
 * dollar sign. That assumption lives in this one file — if HBD ever needs a
 * real oracle rate, HBD_PER_USD is the single seam to change.
 *
 * UNITS. Everything crossing into contract-math is integer: whole TOKENS and
 * HBD BASE UNITS (3 decimals). Only the values returned to the UI are
 * fractional dollars. Never let a token count round-trip through a float.
 */

/** HBD per USD. 1.0 — HBD is soft-pegged to the dollar. The single seam if a real oracle is ever needed. */
const HBD_PER_USD = 1;

const SCALE = 10 ** ASSET_DECIMALS;

/** The 10% trade fee (5% creator, 5% Lumen), as a fraction — for copy that quotes the headline rate. */
export const TRADE_FEE = TRADE_FEE_BPS / 10_000;
/** Early-exit tax at day 0 — 20%, matching params.go MaxExitTaxBps. */
export const EXIT_FEE_MAX = MAX_EXIT_TAX_BPS / 10_000;
/** Decays linearly to 0 over 6 weeks (params.go ExitTaxDecayBlocks = 42 days). */
export const EXIT_FEE_DAYS = 42;

function usdToBaseUnits(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * HBD_PER_USD * SCALE);
}

function baseUnitsToUsd(baseUnits: number): number {
  return baseUnits / SCALE / HBD_PER_USD;
}

/**
 * The market's supply as the WHOLE TOKEN COUNT the curve indexes by. The mock
 * store carries `supply` as a float (it let buys credit fractional tokens);
 * the chain never does. Flooring here keeps the preview on the same integer
 * lattice the contract prices on.
 */
/**
 * The ONLY three fields these quote helpers actually read off a market. Typed
 * structurally (2026-07-28) rather than as the demo's full TokenMarketDetail so
 * the LIVE, chain-backed view-model (live/adapt.ts's LiveTokenMarket) can be
 * priced by the exact same functions — the alternative was a second copy of the
 * curve math for the live path, which is how a preview and a charge start
 * disagreeing.
 *
 * These are a LOCAL preview, computed from the same ported contract math the
 * chain runs (contract-math.ts). The AUTHORITATIVE numbers still come from the
 * data source's quoteBuy/quoteSell immediately before signing — this is what
 * makes a slider feel instant, not what the user's signature is bound to.
 */
export interface CurveMarketInput {
  supply: number;
  cap: number;
  position: {
    /** The holder's WHOLE position — core/matured.go:145 totalBalance, i.e. maturing + matured. */
    tokens: number;
    /**
     * The MATURING half of that position (core/matured.go's kBal bucket) — the
     * only half a curve sell owes exit tax on, because a matured token's rate is
     * 0 by definition (core/matured.go:6-13).
     *
     * OPTIONAL, and omitting it is the CONSERVATIVE reading: `sellQuote` then
     * treats the whole position as maturing, which is bit-for-bit what this file
     * computed before and overstates the tax rather than understating it. Supply
     * it wherever the split is actually known — until then a holder with matured
     * tokens sees an exit that looks worse than the one the chain will give them
     * (measured: 17.1% understated payout on 100 tokens sold from 40 maturing /
     * 60 matured at supply 1000, h=0).
     */
    maturingTokens?: number;
  } | null;
}

function supplyTokens(m: CurveMarketInput): number {
  return Math.max(0, Math.floor(m.supply));
}

/**
 * The marginal $/token at a given whole-token supply — curve.go SpotRate, the
 * same number the chain records as its price observation. Use this instead of
 * nudging a stored `priceUsd` by a ratio: the curve, not the last trade, is
 * the price source.
 */
export function spotPriceUsd(supply: number): number {
  return baseUnitsToUsd(spotRateBaseUnits(Math.max(0, Math.floor(supply))));
}

/**
 * WHAT ONE TOKEN COSTS A BUYER AT THIS SUPPLY — the price to SHOW a person.
 *
 * ★★★ NOT `spotPriceUsd`, AND THE DIFFERENCE IS NOT COSMETIC (2026-08-15,
 * caught rendering `$0.00` on the launch screen). `SpotRate` is the contract's
 * ORACLE input and curve.go returns 0 at S == 0 deliberately, so that an empty
 * market records no observation rather than a synthetic one. A market that has
 * not opened yet is exactly S == 0, so the Meritum launch flow asked for its
 * own opening price and was told the token was free — on the same screen that
 * engraves that figure onto the coin.
 *
 * `displayPricePerTokenBaseUnits` is Area(S+1) − Area(S): the marginal cost of
 * the next token, which is precisely what the Buy path charges. The headline
 * and the buy quote therefore agree by construction. At S == 0 it is 1007 base
 * units, i.e. the first token really costs $1.007.
 *
 * The same function already backs every live market price (`vsc-data-source`,
 * `mock-data-source`); this wrapper only puts it in USD for a market that does
 * not exist yet. Anything needing the oracle rate keeps calling `spotPriceUsd`.
 */
export function displayPriceUsd(supply: number): number {
  return baseUnitsToUsd(displayPricePerTokenBaseUnits(Math.max(0, Math.floor(supply))));
}

/** The reserve the curve requires at a given supply — R === Area(S), the mechanism's core equality. */
export function reserveUsdAt(supply: number): number {
  const s = Math.max(0, Math.floor(supply));
  return baseUnitsToUsd(quoteBuyBaseUnits(0, s).costBaseUnits);
}

/** Early-exit tax fraction for a holding aged `holdDays` (0 once >= 6 weeks). Exact ceil-based rate from exittax.go. */
export function exitFeeFraction(holdDays: number): number {
  const heldBlocks = Math.max(0, Math.round(holdDays * BLOCKS_PER_DAY));
  return exitTaxBpsAt(heldBlocks) / 10_000;
}

/**
 * The NET floor value a position of `tokens` would redeem for at a flat
 * pro-rata wind-down, aged `holdDays` — refund.go's K2 tax carved off the
 * GROSS pro-rata slice (tokens × the market's per-token floor), exactly
 * matching lib/vsc-data-source.ts's readHolderPosition (refundNetBaseUnits).
 *
 * Showing the untaxed GROSS here overstates a fresh holder's payout by up to
 * MaxExitTaxBps (20%) — the same defect refundNetBaseUnits's own doc warns
 * against — because a wind-down redemption always carries the holder's own
 * hold-time exit tax, never the bare reserve share.
 */
export function floorValueUsdNet(tokens: number, floorUsd: number, holdDays: number): number {
  const heldBlocks = Math.max(0, Math.round(holdDays * BLOCKS_PER_DAY));
  const taxBps = exitTaxBpsAt(heldBlocks);
  const grossBaseUnits = usdToBaseUnits(tokens * floorUsd);
  const taxBaseUnits = exitTaxOnBaseUnits(grossBaseUnits, taxBps);
  return baseUnitsToUsd(grossBaseUnits - taxBaseUnits);
}

export interface BuyQuote {
  /** WHOLE tokens received — the curve mints integers only. */
  tokens: number;
  /**
   * Average $/token actually paid across the curve move — `totalUsd / tokens`,
   * so it INCLUDES the 10% trade fee, while `priceAfter` below is a bare curve
   * price with no fee in it at all.
   *
   * ★ THE TWO ARE ON DIFFERENT BASES AND MUST NEVER BE SHOWN AS IF THEY WERE
   * THE SAME KIND OF NUMBER (2026-08-27). On a rising curve the average paid
   * must lie BELOW the price you end at; measured at $10 on a supply-50 market
   * the modal showed "Average price ~$1.57" above "Price after your buy ~$1.46",
   * an ordering the curve makes impossible, because the fee is in one figure and
   * not the other (ex-fee the average is $1.43, correctly below $1.46). The
   * arithmetic is right in both; the pairing was unlabelled. Any surface showing
   * both must name the basis — token-modals.tsx reads "Average price (incl.
   * fees)" and "Curve price after your buy", and itemises `tradeFeeUsd`.
   */
  avgPrice: number;
  /** $/token after your buy (the curve moves up). NO fee in this — see `avgPrice`. */
  priceAfter: number;
  /**
   * The curve's own cost for the quoted tokens, BEFORE the trade fee — buy.go's
   * `cost`. `curveCostUsd + tradeFeeUsd === totalUsd` by construction
   * (quoteBuyBaseUnits: totalDue = cost + fee), which is what lets a modal
   * itemise the fee the way the sell side already does instead of leaving it
   * folded invisibly into one figure.
   */
  curveCostUsd: number;
  tradeFeeUsd: number;
  /** What the buy really costs, cost + fee — may be LESS than the requested budget, since tokens are integers. */
  totalUsd: number;
}

/**
 * Preview a buy of `usdGross` dollars, fee-inclusive as the button shows.
 *
 * The budget buys the largest WHOLE number of tokens whose total (curve cost +
 * 10% fee) fits — `tokensAffordableForBudget` bisects the real quote function
 * rather than inverting an approximation of it. `totalUsd` is therefore <=
 * `usdGross`, and it is that number, not the requested budget, that the buyer
 * must approve as their transfer.allow.
 *
 * Also never quotes past the market's own cap (buy.go's ErrCap: a buy that
 * would push supply over the cap is refused outright, never partial-filled) —
 * a quote that ignored the cap would show more tokens than a real buy could
 * ever mint, and the execution side would then have to silently refuse the
 * difference.
 */
export function buyQuote(usdGross: number, m: CurveMarketInput): BuyQuote {
  const supply = supplyTokens(m);
  const budgetBaseUnits = usdToBaseUnits(usdGross);
  const capHeadroom = Math.max(0, Math.floor(m.cap) - supply);
  const affordable = tokensAffordableForBudget(supply, budgetBaseUnits);
  const tokens = Math.min(affordable, capHeadroom);
  if (tokens <= 0) {
    // ★ THE ORACLE RATE LEAKED INTO A BUYER-FACING PRICE HERE (found 2026-08-21,
    // the same fault as the "$0.00 in the directory" bug one layer up).
    // `spotRateBaseUnits` returns 0 at supply 0 BY DESIGN — curve.go wants an
    // empty market to record no observation — so on a new market this branch
    // rendered "Price after your buy: ~$0.00" for a token that costs $1.007.
    // At any other supply it understated the real price by about 1%, which also
    // made the max-price slippage guard below (token-modals.tsx) that much too
    // lenient. contract-math.ts's own doc forbids conflating the two.
    return {
      tokens: 0,
      avgPrice: 0,
      priceAfter: baseUnitsToUsd(displayPricePerTokenBaseUnits(supply)),
      curveCostUsd: 0,
      tradeFeeUsd: 0,
      totalUsd: 0
    };
  }
  const q = quoteBuyBaseUnits(supply, tokens);
  const totalUsd = baseUnitsToUsd(q.totalDueBaseUnits);
  return {
    tokens,
    avgPrice: totalUsd / tokens,
    // Same correction as the zero branch: `q.rateAfterBaseUnits` is
    // `spotRateBaseUnits(S + n)`, the ORACLE rate, because `quoteBuyBaseUnits`
    // is a faithful mirror of the contract's own `quoteBuy` entrypoint and must
    // stay one. What belongs above a Buy button is what the NEXT token will
    // actually cost, so the conversion to a shown price happens here instead.
    priceAfter: baseUnitsToUsd(displayPricePerTokenBaseUnits(supply + tokens)),
    curveCostUsd: baseUnitsToUsd(q.costBaseUnits),
    tradeFeeUsd: baseUnitsToUsd(q.feeBaseUnits),
    totalUsd
  };
}

/**
 * THE SMALLEST BUDGET THAT BUYS ANYTHING AT THIS MARKET'S CURRENT SUPPLY — the
 * fee-inclusive TotalDue of exactly one token, rounded UP to the cent.
 *
 * `buyQuote` returns `tokens: 0` for every budget below this, and
 * `tokensAffordableForBudget`'s own doc says a caller "must surface rather than
 * rounding up into a transaction that reverts". This is the figure that
 * surfaces it: measured on the live supply-50 market, $0.50 and $1.00 both
 * quoted zero tokens under an ENABLED Buy button, with no statement anywhere on
 * screen of what a buy would actually take.
 *
 * IT MOVES. The curve rises with supply, so the threshold is only true of the
 * supply it was read at — never cache it, never hardcode it, always derive it
 * from the same market object the quote beside it came from.
 *
 * CEIL TO THE CENT, IN BASE UNITS. TotalDue is a 3-decimal HBD integer (1548 =
 * $1.548) and the modal has two decimals to print it in. Rounding to the nearest
 * cent would print "$1.54" — a budget that still buys nothing, because
 * usdToBaseUnits(1.54) is 1540 and 1540 < 1548. Only rounding UP keeps the
 * printed number a budget that actually works, which is what lets the modal
 * state it flatly rather than hedging it. The ceiling is taken on the INTEGER
 * base units (÷10 = milli-units to cents, ASSET_DECIMALS 3 → 2), never on the
 * divided float, so no representation error can push it a whole cent high.
 *
 * Returns 0 when there is no headroom left under the cap — buy.go's ErrCap
 * refuses a sold-out market outright, so it has no minimum, it has no buy at all
 * (the modal's own `soldOut` branch says so in those words).
 */
export function minBuyUsd(m: CurveMarketInput): number {
  const supply = supplyTokens(m);
  if (Math.max(0, Math.floor(m.cap) - supply) < 1) return 0;
  const cents = Math.ceil(quoteBuyBaseUnits(supply, 1).totalDueBaseUnits / 10);
  return cents / 100;
}

export interface SellQuote {
  curveProceedsUsd: number;
  exitFeePct: number;
  exitFeeUsd: number;
  tradeFeeUsd: number;
  receiveUsd: number;
}

/**
 * Preview selling `tokens`, held `holdDays`, itemised as the modal shows.
 *
 * ORDER MATTERS AND IT CHANGED: the exit tax and the trade fee are BOTH
 * charged on the gross curve proceeds (sell.go: tax = ceil(p·τ/1e4),
 * fee = floor(p·TradeFeeBps/1e4), net = p − tax − fee). The previous version
 * charged the trade fee on the post-tax remainder, which understated it and
 * therefore overstated what the seller receives.
 *
 * Returns an all-zero quote when the sell exceeds supply — core refuses there
 * rather than guessing, and so does this.
 */
export function sellQuote(tokens: number, m: CurveMarketInput, holdDays: number): SellQuote {
  const supply = supplyTokens(m);
  // Clamp to the CALLER'S OWN balance too, never just total supply — sell.go
  // checks bal >= ΔS before anything else ("insufficient credits"), so typing
  // more than you hold must quote what you'd actually receive (proceeds for
  // your real balance), never proceeds for an amount execution will refuse.
  const held = Math.max(0, Math.floor(m.position?.tokens ?? 0));
  const n = Math.max(0, Math.floor(Math.min(tokens, supply, held)));
  const heldBlocks = Math.max(0, Math.round(holdDays * BLOCKS_PER_DAY));
  // TWO BUCKETS (F2). sell.go:234-236 taxes only the MATURING share of the draw.
  // Pass the maturing BALANCE — quoteSellBaseUnits runs splitDraw (maturing
  // FIRST, core/matured.go:149-195) itself. Unknown ⇒ the whole position, which
  // reproduces this file's previous number exactly.
  const maturingHeld =
    m.position?.maturingTokens === undefined ? held : Math.max(0, Math.min(held, Math.floor(m.position.maturingTokens)));
  const q = n > 0 ? quoteSellBaseUnits(supply, n, heldBlocks, maturingHeld) : null;
  if (!q) return { curveProceedsUsd: 0, exitFeePct: exitFeeFraction(holdDays), exitFeeUsd: 0, tradeFeeUsd: 0, receiveUsd: 0 };
  return {
    curveProceedsUsd: baseUnitsToUsd(q.grossBaseUnits),
    exitFeePct: q.taxBps / 10_000,
    exitFeeUsd: baseUnitsToUsd(q.taxBaseUnits),
    tradeFeeUsd: baseUnitsToUsd(q.feeBaseUnits),
    receiveUsd: baseUnitsToUsd(q.netBaseUnits)
  };
}

export interface ServiceQuote {
  /** Whole tokens escrowed from the buyer's balance — priced off the TOKEN LEG only (88% of the posted face), never the full posted price. */
  tokens: number;
  /** The 12% platform commission — a SEPARATE HBD payment, never tokens. */
  commissionUsd: number;
  /** The token leg's USD value + commissionUsd — reconstructs the posted `usd` face, up to the floor/ceil residue. */
  totalUsd: number;
}

/**
 * The true cost of a USD-priced service (ask.go splitFace + creditsForAsk,
 * USER RULING 2026-07-27): the posted `usd` is the buyer's TOTAL, not a
 * token-only price. 12% is carved off as a SEPARATE HBD commission leg
 * (splitFaceBaseUnits); only the remaining 88% (the token leg) is what's
 * actually escrowed in tokens, ceil-divided by the live price — CEIL, and the
 * rounding favours the reserve, so a client that floors (or that divides
 * floats) quotes the buyer fewer tokens than the chain will actually escrow
 * and the ask trips their own maxCredits cap.
 *
 * Replaces the old serviceTokens(usd, priceUsd), which priced the FULL posted
 * amount in tokens while the commission was ALSO drawn as a separate HBD
 * leg — a posted "200" cost the buyer 224 with no line item ever showing the
 * extra 24 (splitFaceBaseUnits's own doc has the full autopsy).
 *
 * `priceUsd` here stands in for the settlement rate. The REAL rate is
 * min(TWAP_short, TWAP_long, spot) and the contract REFUSES when it cannot
 * price safely — a live surface must take the rate from the contract's own
 * `quote` entrypoint rather than from a displayed spot price.
 */
export function serviceQuote(usd: number, priceUsd: number): ServiceQuote {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || usd <= 0 || priceUsd <= 0) {
    return { tokens: 0, commissionUsd: 0, totalUsd: 0 };
  }
  const faceBaseUnits = usdToBaseUnits(usd);
  const { tokenLegBaseUnits, commissionBaseUnits } = splitFaceBaseUnits(faceBaseUnits);
  const rateBaseUnits = Math.max(1, Math.round(priceUsd * HBD_PER_USD * SCALE));
  return {
    tokens: creditsForAskBaseUnits(tokenLegBaseUnits, rateBaseUnits),
    commissionUsd: baseUnitsToUsd(commissionBaseUnits),
    totalUsd: baseUnitsToUsd(tokenLegBaseUnits + commissionBaseUnits)
  };
}

/**
 * ★★★ THE SUPPLY CAP IS PER-CREATOR AND A SERVICE PRICE WAS NEVER CHECKED
 * AGAINST IT (2026-08-27).
 *
 * `serviceQuote` above answers "how many tokens does this service cost", and
 * every screen that renders a price calls it. Nothing anywhere asked the next
 * question: how many tokens are there? Caps vary by three orders of magnitude
 * between live markets — 30 on `did:pkh:…0xB41f…980B`, 500 on `…0xc965…Cb6a`,
 * 100,000 on every `lumen.*` — and the creation forms accept a price with no
 * reference to the creator's own cap at all.
 *
 * WHY THE CHECK IS A CLIENT ONE. The contract does not refuse it: offerings.go
 * validates the title and the price band, and ask.go prices the escrow, but
 * nothing on chain relates an offering's price to `kCap`. So this is not a
 * mirror of a core rule — it is a creation-time guard against the creator
 * posting a service nobody can buy, and the message says how to fix it rather
 * than merely refusing.
 *
 * ★★ ONE FAULT NOW, NOT TWO (2026-08-30, studio checklist B2; decision by the
 * lead session, evidence by this one). Until today this reported a second,
 * softer fault, OVER-SHARE: fillable, but more than 10% of the cap. That 10%
 * was reasoned against a cap a creator had chosen from a 5k / 20k / 100k menu
 * (the escrow makes the share a concurrency limit: ten jobs at once at 10%).
 * The menu is gone and every market launches at the contract's MaxCap
 * (launch-money.ts), so on a new market the share test was dead code, and on
 * the three legacy markets it was punitive about a number nobody picked on
 * purpose. PROVEN on the live testnet state before it was removed (all 13
 * discovery markets, real cap / supply / face / offerings through this very
 * function): the owner's own `hive:hbd-temp` (cap 30, supply 30, face $25)
 * tripped it at 18 tokens = 60%, and ANY service price at or above $4.26 did
 * — every price a person types — while the Studio's create form re-evaluates
 * it on every keystroke (creator-studio.tsx NewOfferingRow). That is the
 * "offerings flashing an error because price set is too high" the owner
 * reported, and his ruling was that it should never fire. The launch path
 * could not fire at all (nothing up to MAX_PRICE_USD trips a 1e9 cap).
 *
 * UNFILLABLE SURVIVES because it is not a heuristic. `tokens > cap` means no
 * holder can ever own enough tokens to place the ask, at any supply — buy.go
 * refuses to mint past the cap — so the listing has no reachable buyer. That
 * is a fact about the chain, and refusing to post it is still the honest
 * thing. On a MaxCap market it needs a service priced in the trillions, so it
 * is silent there too; it exists for the legacy caps until their creators
 * raise them (the Studio keeps the Raise-cap control on the live cap).
 *
 * NEVER GUESSES. A cap or price we do not have returns `null` — "cannot judge"
 * — never a refusal. Blocking a creator's own pricing on a value that failed to
 * read is the same fault class this feature has been burned by repeatedly
 * (unavailable ≠ empty); a guard that fires on a missing number is worse than
 * no guard.
 */

export interface ServiceSupplyShare {
  /** Whole tokens the service costs at `priceUsd` — `serviceQuote(...).tokens`, never a second formula. */
  tokens: number;
  /** Share of `capTokens`, in basis points. Uncapped: an unfillable service exceeds 10,000. Informational; nothing refuses on it since 2026-08-30. */
  shareBps: number;
  /** More tokens than can ever exist. No buyer, at any supply. The only refusal. */
  unfillable: boolean;
}

/**
 * How much of a creator's whole supply one service costs, or `null` when the
 * inputs do not support an answer (no cap, no price, no price on the service).
 *
 * The token figure comes from `serviceQuote`, the same call the token page and
 * the Studio already render — a second cost formula here is exactly the
 * "third, wrong way to quote the same offering" this feature has already been
 * bitten by (creator-studio.tsx's own note, 2026-08-21).
 */
export function serviceSupplyShare(usd: number, priceUsd: number, capTokens: number): ServiceSupplyShare | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!Number.isFinite(capTokens) || capTokens <= 0) return null;

  const { tokens } = serviceQuote(usd, priceUsd);
  // serviceQuote returns 0 when it cannot price. That is "unknown", not "free",
  // and it must not be reported as a 0% share of supply.
  if (tokens <= 0) return null;

  const cap = Math.floor(capTokens);
  return {
    tokens,
    shareBps: Math.round((tokens / cap) * 10_000),
    unfillable: tokens > cap
  };
}

/**
 * The creation-time refusal sentence, or `null` when the price is fine or
 * cannot be judged. Since 2026-08-30 the only refusal is UNFILLABLE (see the
 * block above for what was removed and why).
 *
 * Wording follows the rule the rest of this feature's refusals follow: name the
 * fault in the creator's own numbers, then the way out. Both remedies are real:
 * the cap can be RAISED from the Studio at any time on a market below MaxCap,
 * so this is never a dead end.
 */
export function serviceSupplyShareProblem(usd: number, priceUsd: number, capTokens: number): string | null {
  const share = serviceSupplyShare(usd, priceUsd, capTokens);
  if (share === null || !share.unfillable) return null;

  const cap = Math.floor(capTokens).toLocaleString('en-US');
  const tokens = share.tokens.toLocaleString('en-US');
  return `At this price the service costs ${tokens} tokens, and only ${cap} can ever exist, so nobody could buy it. Lower the price, or raise your supply cap first.`;
}

/**
 * F4 fix (2026-08-19): use-live-token-market.ts's askMutation used to build
 * the asker's own spend cap as `humanToBaseUnits(input.maxCostUsd)` — an
 * HBD-MILLIUNIT number (contract-math.ts's x1000 scale), while
 * `AskInput.maxCreditsBaseUnits` is an INTEGER TOKEN COUNT (core/ask.go
 * creditsSpent/maxCredits; see that field's own doc in types.ts: "may ONLY
 * be derived from Quote.creditsRequiredBaseUnits... never
 * baseUnitsToHuman'd" — the exact mistake this replaces). Measured
 * 1,000x-18,000x too loose in production, which made the contract's own
 * anti-price-spike guard (core/ask.go:352-356,429-430) effectively
 * unlimited, because it was being fed a number a thousand-plus times bigger
 * than what it was ever meant to bound.
 *
 * `toleranceBps` is UI headroom, not protocol logic — see the exported
 * function's own doc below for why a little slack is safe.
 */
export const ASK_MAX_CREDITS_TOLERANCE_BPS = 200; // 2%

/**
 * The asker's signed cap, derived ONLY from the quote's own integer credits
 * figure (Quote.creditsRequiredBaseUnits) — never from the HBD/USD price the
 * modal shows. `toleranceBps` exists because vsc-data-source.ts's ask()
 * re-reads the SAME quote server-side and rejects if the price moved past
 * whatever cap it is handed (`quote.creditsRequiredBaseUnits >
 * input.maxCreditsBaseUnits`); a little headroom over the figure THIS read
 * just produced keeps an ordinary same-block rate tick from bouncing an
 * otherwise-legitimate ask. It is still tight — the asker's real protection
 * against a creator spiking `face` is the freshly-read quote itself, not
 * this buffer.
 */
export function resolveAskMaxCreditsBaseUnits(
  creditsRequiredBaseUnits: number,
  toleranceBps: number = ASK_MAX_CREDITS_TOLERANCE_BPS
): number {
  return Math.ceil((creditsRequiredBaseUnits * (10_000 + toleranceBps)) / 10_000);
}

/**
 * F5 fix (2026-08-19): the default headroom applied under a freshly-shown
 * sell/redeem quote when pre-filling the minNet/minRefund exit floor
 * (token-modals.tsx's SellModal, creator-studio.tsx's "Cash out"). The floor
 * now defaults ON rather than absent — see sell.go's checkMinNet, reused by
 * refund.go — but binding it to the EXACT previewed number would revert an
 * otherwise-fine exit on ordinary same-block noise: redeem mode's own figure
 * is a pro-rata SCALE of the position's floor value, not a fresh per-amount
 * recompute (see redeemUsd's own comment in token-modals.tsx), so it can
 * differ from the contract's real per-amount net by a base unit or two even
 * with no price movement at all. This bps of slack still catches a real
 * price move or front-run; it just isn't pixel-perfect about it.
 */
export const MIN_NET_DEFAULT_TOLERANCE_BPS = 100; // 1%
