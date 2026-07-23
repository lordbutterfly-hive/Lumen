import type { TokenMarketDetail } from './token-detail';

/**
 * UI-PREVIEW bonding-curve math for the Buy/Sell modals.
 *
 * The contract (`/mnt/o/CREATOR-TOKENS`) is the source of truth — it exports
 * `quoteBuy`/`quoteSell` over `price(i) = BasePrice + a·i + b·i²`, reserve =
 * area(S). These helpers reproduce the SHAPE (price rises with supply on buy,
 * falls on sell; a 10% trade fee; an early-exit fee that decays to 0 over ~6
 * weeks) for a realistic preview against mock data. On deploy, swap these for
 * the contract's `quoteBuy`/`quoteSell` reads — the modal API is quote-in /
 * numbers-out, so the swap is data-only.
 */

export const TRADE_FEE = 0.1; // 10% (5% creator, 5% Lumen)
export const EXIT_FEE_MAX = 0.15; // early-exit fee at day 0
export const EXIT_FEE_DAYS = 42; // decays linearly to 0 over ~6 weeks

/** Early-exit fee fraction for a holding aged `holdDays` (0 once ≥ ~6 weeks). */
export function exitFeeFraction(holdDays: number): number {
  return Math.max(0, EXIT_FEE_MAX * (1 - holdDays / EXIT_FEE_DAYS));
}

export interface BuyQuote {
  /** Tokens received for the USD amount, after the trade fee. */
  tokens: number;
  /** Average $/token paid across the curve move. */
  avgPrice: number;
  /** $/token after your buy (the curve moves up). */
  priceAfter: number;
  tradeFeeUsd: number;
}

/** Preview a buy of `usdGross` dollars (fee-inclusive, as the button shows). */
export function buyQuote(usdGross: number, m: TokenMarketDetail): BuyQuote {
  const tradeFeeUsd = usdGross * TRADE_FEE;
  const usdNet = usdGross - tradeFeeUsd;
  const supply = Math.max(m.supply, 1);
  // Linear-curve approximation: avg price is the mid-point of the curve move.
  const roughTokens = usdNet / m.priceUsd;
  const avgPrice = m.priceUsd * (1 + roughTokens / supply / 2);
  const tokens = usdNet / avgPrice;
  const priceAfter = m.priceUsd * (1 + tokens / supply);
  return { tokens, avgPrice, priceAfter, tradeFeeUsd };
}

export interface SellQuote {
  curveProceedsUsd: number;
  exitFeePct: number;
  exitFeeUsd: number;
  tradeFeeUsd: number;
  receiveUsd: number;
}

/** Preview selling `tokens`, held `holdDays`, itemised as the modal shows. */
export function sellQuote(tokens: number, m: TokenMarketDetail, holdDays: number): SellQuote {
  const supply = Math.max(m.supply, 1);
  const avgPrice = m.priceUsd * (1 - Math.min(tokens, supply) / supply / 2);
  const curveProceedsUsd = tokens * avgPrice;
  const exitFeePct = exitFeeFraction(holdDays);
  const exitFeeUsd = curveProceedsUsd * exitFeePct;
  const afterExit = curveProceedsUsd - exitFeeUsd;
  const tradeFeeUsd = afterExit * TRADE_FEE;
  return { curveProceedsUsd, exitFeePct, exitFeeUsd, tradeFeeUsd, receiveUsd: afterExit - tradeFeeUsd };
}

/** Tokens for a USD-priced service at the current price (spend = USD ÷ price). */
export const serviceTokens = (usd: number, priceUsd: number): number => usd / priceUsd;
