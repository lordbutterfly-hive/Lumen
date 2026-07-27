import type { TokenMarketDetail } from './token-detail';
import {
  ASSET_DECIMALS,
  BLOCKS_PER_DAY,
  MAX_EXIT_TAX_BPS,
  TRADE_FEE_BPS,
  exitTaxBpsAt,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  spotRateBaseUnits,
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
function supplyTokens(m: TokenMarketDetail): number {
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
 */
export function buyQuote(usdGross: number, m: TokenMarketDetail): BuyQuote {
  const supply = supplyTokens(m);
  const budgetBaseUnits = usdToBaseUnits(usdGross);
  const tokens = tokensAffordableForBudget(supply, budgetBaseUnits);
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
export function sellQuote(tokens: number, m: TokenMarketDetail, holdDays: number): SellQuote {
  const supply = supplyTokens(m);
  const n = Math.max(0, Math.floor(Math.min(tokens, supply)));
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

/**
 * Tokens needed for a USD-priced service. ask.go's creditsForAsk is
 * ceil(face/rate) — CEIL, and the rounding favours the reserve, so a client
 * that floors (or that divides floats) quotes the buyer fewer tokens than the
 * chain will actually escrow and the ask trips their own maxCredits cap.
 *
 * `priceUsd` here stands in for the settlement rate. The REAL rate is
 * min(TWAP_short, TWAP_long, spot) and the contract REFUSES when it cannot
 * price safely — a live surface must take the rate from the contract's own
 * `quote` entrypoint rather than from a displayed spot price.
 */
export function serviceTokens(usd: number, priceUsd: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || usd <= 0 || priceUsd <= 0) return 0;
  const faceBaseUnits = usdToBaseUnits(usd);
  const rateBaseUnits = Math.max(1, Math.round(priceUsd * HBD_PER_USD * SCALE));
  return Math.ceil(faceBaseUnits / rateBaseUnits);
}
