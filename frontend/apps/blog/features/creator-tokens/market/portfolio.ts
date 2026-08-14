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

export const MOCK_HOLDINGS: TokenHolding[] = [
  // ★ CURVE-CONSISTENT (2026-07-27 fix): @ada's market now seeds through
  // synthDetail (store.ts) at ~$1,208.50/token, not the old hand-picked $4.20
  // — this row's own priceUsd/valueUsd/floorValueUsd/spark are rescaled to
  // match, so the fixture doesn't sit at a stale price a real reseed can't
  // reach. Superseded at render time by store.ts's live derivation either way.
  { handle: 'ada', what: 'Hive core-dev', avatarColor: 'linear-gradient(135deg,#3182ce,#4f9e6a)', tokens: 14.5, valueUsd: 17523.25, floorValueUsd: 6231.81, priceUsd: 1208.5, changePctWeek: 6.2, spark: [1064.63, 1093.4, 1079.02, 1136.57, 1165.34, 1208.5] },
  // ★ `rgb(var(--surface-brand-12))`, not `#c0392b` (2026-08-14): a FILL swatch
  // takes the same token `launch-wizard.tsx`'s placeholder avatar uses for the
  // identical gradient shape, so this fixture's colour tracks the app's brand red
  // (and its dark-mode lift) instead of staying pinned to the old literal.
  { handle: 'delm', what: 'Witness ops & infra', avatarColor: 'linear-gradient(135deg,rgb(var(--surface-brand-12)),#e07b3e)', tokens: 9.2, valueUsd: 90.16, floorValueUsd: 55.2, priceUsd: 9.8, changePctWeek: 3.1, spark: [9.1, 9.3, 9.2, 9.5, 9.6, 9.8] },
  { handle: 'favour', what: 'Growth & newsletters', avatarColor: '#e07b3e', tokens: 12.0, valueUsd: 73.2, floorValueUsd: 42.0, priceUsd: 6.1, changePctWeek: -2.4, spark: [6.4, 6.3, 6.25, 6.2, 6.15, 6.1] },
  { handle: 'quill', what: 'Technical writing', avatarColor: '#3182ce', tokens: 8.6, valueUsd: 46.44, floorValueUsd: 27.9, priceUsd: 5.4, changePctWeek: 1.8, spark: [5.2, 5.25, 5.3, 5.35, 5.35, 5.4] },
  { handle: 'sora', what: 'Travel & film', avatarColor: '#2f7d4f', tokens: 18.1, valueUsd: 41.63, floorValueUsd: 24.44, priceUsd: 2.3, changePctWeek: -5.0, spark: [2.5, 2.45, 2.4, 2.35, 2.32, 2.3], windingDown: true }
];

export const MOCK_ASKS: PortfolioAsk[] = [
  { id: 'a1', handle: 'ada', service: 'Ask a question', state: 'awaiting', costUsd: 10, tokens: 2.38, dueLabel: 'Answer due in 3d 4h' },
  { id: 'a2', handle: 'delm', service: 'Ask a question', state: 'awaiting', costUsd: 25, tokens: 2.55, dueLabel: 'Answer due in 18h', urgent: true },
  { id: 'a3', handle: 'favour', service: 'Ask a question', state: 'answered', costUsd: 15, tokens: 2.46, answer: 'Run your launch as a 3-part series — teaser, drop, recap. Seed the teaser to your top 20 engaged holders first.' },
  { id: 'a4', handle: 'quill', service: 'Review my code', state: 'reclaimable', costUsd: 80, tokens: 14.81 },
  { id: 'a5', handle: 'sora', service: 'Ask a question', state: 'reclaimed', costUsd: 6, tokens: 2.61 }
];

export const portfolioTotals = (h: TokenHolding[]) => ({
  valueUsd: h.reduce((s, x) => s + x.valueUsd, 0),
  floorUsd: h.reduce((s, x) => s + x.floorValueUsd, 0),
  creators: h.length
});
