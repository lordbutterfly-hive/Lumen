import {
  ASSET_DECIMALS,
  BLOCKS_PER_DAY,
  MAX_EXIT_TAX_BPS,
  TRADE_FEE_BPS,
  creditsForAskBaseUnits,
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
  position: { tokens: number } | null;
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
  /** Average $/token actually paid across the curve move. */
  avgPrice: number;
  /** $/token after your buy (the curve moves up). */
  priceAfter: number;
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
    return { tokens: 0, avgPrice: 0, priceAfter: baseUnitsToUsd(spotRateBaseUnits(supply)), tradeFeeUsd: 0, totalUsd: 0 };
  }
  const q = quoteBuyBaseUnits(supply, tokens);
  const totalUsd = baseUnitsToUsd(q.totalDueBaseUnits);
  return {
    tokens,
    avgPrice: totalUsd / tokens,
    priceAfter: baseUnitsToUsd(q.rateAfterBaseUnits),
    tradeFeeUsd: baseUnitsToUsd(q.feeBaseUnits),
    totalUsd
  };
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
  const q = n > 0 ? quoteSellBaseUnits(supply, n, heldBlocks) : null;
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
