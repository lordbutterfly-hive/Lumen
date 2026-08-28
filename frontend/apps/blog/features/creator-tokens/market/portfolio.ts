/** Portfolio view-model for `/wallet/tokens` (Your Tokens). USD + tokens only. */

export interface TokenHolding {
  handle: string;
  what: string;
  avatarColor: string;
  tokens: number;
  valueUsd: number;
  /** NET of this holding's own hold-time exit tax — see token-detail.ts's HolderPosition.floorValueUsd doc; this fixture field is superseded at render time by store.ts's own live derivation (deriveHolding), kept here only so the fixture stays internally honest. */
  floorValueUsd: number;
  priceUsd: number;
  changePctWeek: number;
  /** Tiny price sparkline (oldest→newest). */
  spark: number[];
  /** Market winding down/frozen — a status dot; Sell/reclaim still work. */
  windingDown?: boolean;
}

export type AskState = 'awaiting' | 'answered' | 'reclaimable' | 'reclaimed';

export interface PortfolioAsk {
  id: string;
  handle: string;
  service: string;
  state: AskState;
  costUsd: number;
  tokens: number;
  /** e.g. "Answer due in 3d 4h" (awaiting). */
  dueLabel?: string;
  /** amber < 24h. */
  urgent?: boolean;
  /** The buyer's question/brief (captured at ask time; shown to the creator). */
  question?: string;
  /** The answer text (answered). */
  answer?: string;
}

/**
 * MOCK_HOLDINGS and MOCK_ASKS were removed 2026-08-28. They were fabricated
 * portfolio rows (@ada at $1,208.50/token, a $17,523.25 position) left behind
 * when the demo store they seeded, `store.ts`, was deleted. Nothing imported
 * them: the two live consumers of this file, `live/adapt.ts` and
 * `live/use-live-studio.ts`, import only the `PortfolioAsk` TYPE.
 *
 * They shipped in the production bundle as dead exports, which is one import
 * away from a screen of invented money. The types below are the real product of
 * this file; the numbers were not.
 */
export const portfolioTotals = (h: TokenHolding[]) => ({
  valueUsd: h.reduce((s, x) => s + x.valueUsd, 0),
  floorUsd: h.reduce((s, x) => s + x.floorValueUsd, 0),
  creators: h.length
});
