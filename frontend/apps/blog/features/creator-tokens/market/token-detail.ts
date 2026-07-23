import type { DeliveryRecord } from './types';

/** One service a creator offers — priced in USD, spent in tokens at live price. */
export interface Service {
  key: string;
  name: string;
  desc: string;
  usd: number;
  /** 'live' renders the CTA; 'rolling_out' shows a muted "Rolling out" chip. */
  status: 'live' | 'rolling_out';
  cta: string;
}

/** The signed-in viewer's holding in this token (null when they hold none). */
export interface HolderPosition {
  tokens: number;
  valueUsd: number;
  floorValueUsd: number;
  /** Days since the viewer's last buy — drives the early-exit fee. */
  heldDays: number;
}

/** Full market detail for a single creator's token page. */
export interface TokenMarketDetail {
  handle: string;
  what: string;
  avatarColor: string;
  reputation: number;
  /** Current price, USD. */
  priceUsd: number;
  /** Weekly change, e.g. +6.2 / -3.1 — the one place up/down color is allowed. */
  changePctWeek: number;
  marketCapUsd: number;
  /** Reserve-backed downside per token — shown beside price, never colored. */
  floorUsd: number;
  supply: number;
  cap: number;
  /** Total reserve behind the token, USD (source of the floor). */
  reserveUsd: number;
  /** Price series for the chart (oldest→newest), plotted as a line. */
  chart: number[];
  delivery: DeliveryRecord;
  services: Service[];
  position: HolderPosition | null;
  /** Wind-down: Buy disabled, Sell/refund stays open. */
  windingDown?: boolean;
}

const marks = (s: string): boolean[] => s.split('').map((c) => c === 'A');

/**
 * Mock detail until the contract is deployed + indexed. Values are internally
 * consistent (cap ≈ supply/maxSupply, marketCap ≈ supply × price, reserve backs
 * the floor). TODO(live): replace with `useTokenMarket(handle)` reading the
 * indexer + contract `quote`.
 */
export const MOCK_TOKEN_DETAIL: TokenMarketDetail = {
  handle: 'ada',
  what: 'Hive core-dev — indexing, witness ops, and the occasional teardown.',
  avatarColor: 'linear-gradient(135deg,#3182ce,#4f9e6a)',
  reputation: 72,
  priceUsd: 4.2,
  changePctWeek: 6.2,
  marketCapUsd: 84000,
  floorUsd: 2.1,
  supply: 20000,
  cap: 50000,
  reserveUsd: 42000,
  chart: [3.6, 3.7, 3.55, 3.8, 3.75, 3.9, 4.05, 3.95, 4.1, 4.0, 4.15, 4.2],
  delivery: {
    answered: 47,
    total: 52,
    completionPct: 90,
    typicalResponse: '~6 hours',
    marks: marks('AAAAmAAAAAmAAAAmAA'),
    available: true
  },
  services: [
    { key: 'ask', name: 'Ask a question', desc: 'One private question, answered within your deadline — or your tokens back.', usd: 10, status: 'live', cta: 'Ask' },
    { key: 'dev-day', name: 'Hire me as a dev for a day', desc: 'A full day of focused development work.', usd: 600, status: 'live', cta: 'Book' },
    { key: 'code-review', name: 'Review my code', desc: 'A written review of a repo or pull request.', usd: 80, status: 'live', cta: 'Request' },
    { key: 'opinion', name: 'Give your opinion', desc: 'A candid take on your idea, plan or design.', usd: 25, status: 'live', cta: 'Ask' },
    { key: 'project-review', name: 'Write a project review', desc: 'A structured written assessment of your project.', usd: 150, status: 'rolling_out', cta: 'Request' }
  ],
  position: { tokens: 12, valueUsd: 50.4, floorValueUsd: 25.2, heldDays: 4 }
};
