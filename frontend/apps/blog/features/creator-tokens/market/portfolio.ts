/** Portfolio view-model for `/wallet/tokens` (Your Tokens). USD + tokens only. */

export interface TokenHolding {
  handle: string;
  what: string;
  avatarColor: string;
  tokens: number;
  valueUsd: number;
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
  { handle: 'ada', what: 'Hive core-dev', avatarColor: 'linear-gradient(135deg,#3182ce,#4f9e6a)', tokens: 14.5, valueUsd: 60.9, floorValueUsd: 30.45, priceUsd: 4.2, changePctWeek: 6.2, spark: [3.7, 3.8, 3.75, 3.95, 4.05, 4.2] },
  { handle: 'delm', what: 'Witness ops & infra', avatarColor: 'linear-gradient(135deg,#c0392b,#e07b3e)', tokens: 9.2, valueUsd: 90.16, floorValueUsd: 55.2, priceUsd: 9.8, changePctWeek: 3.1, spark: [9.1, 9.3, 9.2, 9.5, 9.6, 9.8] },
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
