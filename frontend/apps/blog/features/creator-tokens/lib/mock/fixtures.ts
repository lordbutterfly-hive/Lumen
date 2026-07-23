import type { DeliveryWindow } from '../../types';
import { BLOCKS_PER_DAY, MS_PER_BLOCK, RECLAIM_GRACE_BLOCKS } from '../contract-math';

// Fixture creators covering every state UI-BRIEF's build checklist (§2.4)
// requires. Any OTHER creator name resolves to "no market" (null) — which
// doubles as the real, common case of a profile that never became a creator.
// A reload keeps these fixed; simulated writes (prepay/ask/answer/...) persist
// on top of them to SESSION-TTL storage, same as
// prediction-market/lib/market-data-source.ts's MockMarketDataSource.
export const MOCK_ACTIVE = 'mock-active';
export const MOCK_OVERDUE = 'mock-overdue';
export const MOCK_FROZEN = 'mock-frozen';
export const MOCK_EMPTY = 'mock-empty';
export const MOCK_CLOSED = 'mock-closed';
export const MOCK_UNKNOWN = 'mock-unknown';

// A stable "now" block that advances in real time exactly like a real chain
// would, so countdowns tick live across a dev session — the same trick
// MockMarketDataSource.readRound() plays with nowPlus(). Anchored at module
// load so every fixture's *deltaBlocks below reads as "relative to right now."
const HEAD_BLOCK_BASE = 400_000_000;
const HEAD_ANCHOR_MS = Date.now();
export function mockHeadBlock(): number {
  return HEAD_BLOCK_BASE + Math.floor((Date.now() - HEAD_ANCHOR_MS) / MS_PER_BLOCK);
}

export interface MarketSeed {
  faceBaseUnits: number;
  capBaseUnits: number;
  supplyBaseUnits: number;
  reserveBaseUnits: number;
  paidUntilDeltaBlocks: number; // relative to head; negative = lapsed
  registeredAtDeltaBlocks: number; // negative = in the past
  faceSetAtDeltaBlocks: number; // negative = in the past
  closedStored: boolean;
  globalInflowPaused: boolean;
}

export const MARKET_SEEDS: Record<string, MarketSeed> = {
  // A healthy market. face=2.000 HBD, set 2 days ago (band still active),
  // matching UI-BRIEF Page 1's own example numbers exactly.
  [MOCK_ACTIVE]: {
    faceBaseUnits: 2_000,
    capBaseUnits: 500_000,
    supplyBaseUnits: 180_000,
    reserveBaseUnits: 180_000, // exact peg, as Prepay always leaves it
    paidUntilDeltaBlocks: 20 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -90 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -2 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false
  },
  // Lapsed 4.2 days ago; grace is 5 days, so ~19h of grace remain — matches
  // UI-BRIEF's "grace ends in 20h" example almost exactly.
  [MOCK_OVERDUE]: {
    faceBaseUnits: 1_500,
    capBaseUnits: 200_000,
    supplyBaseUnits: 64_000,
    reserveBaseUnits: 64_000,
    paidUntilDeltaBlocks: -Math.floor(4.2 * BLOCKS_PER_DAY),
    registeredAtDeltaBlocks: -40 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -20 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false
  },
  // Lapsed 10 days ago — well past the 5-day grace, so FROZEN. Supply is
  // nonzero (some holders have not yet claimed): "mid wind-down," not
  // CLOSED. New prepay/ask must both read as blocked.
  [MOCK_FROZEN]: {
    faceBaseUnits: 3_000,
    capBaseUnits: 150_000,
    supplyBaseUnits: 42_000, // ~part of an original ~150,000 already refunded
    reserveBaseUnits: 42_000,
    paidUntilDeltaBlocks: -10 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -120 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -60 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false
  },
  // Registered, priced, ACTIVE — nobody has prepaid yet.
  [MOCK_EMPTY]: {
    faceBaseUnits: 1_000,
    capBaseUnits: 100_000,
    supplyBaseUnits: 0,
    reserveBaseUnits: 0,
    paidUntilDeltaBlocks: 29 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -1 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -1 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false
  },
  // Terminal: wind-down complete, supply drained to 0, kState==CLOSED wins
  // regardless of paidUntil (market.go Phase: "the ONLY stored state that wins").
  [MOCK_CLOSED]: {
    faceBaseUnits: 1_800,
    capBaseUnits: 80_000,
    supplyBaseUnits: 0,
    reserveBaseUnits: 0,
    paidUntilDeltaBlocks: -200 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -260 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -200 * BLOCKS_PER_DAY,
    closedStored: true,
    globalInflowPaused: false
  }
};

export interface HolderSeed {
  holder: string;
  creditsBaseUnits: number;
}

export const HOLDER_SEEDS: Record<string, HolderSeed[]> = {
  [MOCK_ACTIVE]: [
    { holder: 'alice', creditsBaseUnits: 45_000 },
    { holder: 'bob', creditsBaseUnits: 12_500 },
    { holder: 'carol', creditsBaseUnits: 122_500 }
  ],
  [MOCK_OVERDUE]: [{ holder: 'alice', creditsBaseUnits: 64_000 }],
  [MOCK_FROZEN]: [
    { holder: 'alice', creditsBaseUnits: 30_000 },
    { holder: 'dave', creditsBaseUnits: 12_000 }
  ],
  [MOCK_EMPTY]: [],
  [MOCK_CLOSED]: []
};

export interface AskSeed {
  seq: number;
  asker: string;
  creditsBaseUnits: number;
  deadlineDeltaBlocks: number; // relative to head
  rawStatus: 'PENDING' | 'ANSWERED' | 'RECLAIMED';
  contentHash: string;
  answerHash: string | null;
}

// Covers all four required Ask states on one creator: awaiting, answered,
// reclaimable (past deadline+ReclaimGrace, unclaimed), reclaimed.
export const ASK_SEEDS: Record<string, AskSeed[]> = {
  [MOCK_ACTIVE]: [
    {
      seq: 0,
      asker: 'bob',
      creditsBaseUnits: 1_800,
      deadlineDeltaBlocks: 3 * BLOCKS_PER_DAY,
      rawStatus: 'PENDING',
      contentHash: 'cid-awaiting-1',
      answerHash: null
    },
    {
      seq: 1,
      asker: 'carol',
      creditsBaseUnits: 1_800,
      deadlineDeltaBlocks: -1 * BLOCKS_PER_DAY,
      rawStatus: 'ANSWERED',
      contentHash: 'cid-answered-1',
      answerHash: 'ans-hash-1'
    },
    {
      seq: 2,
      asker: 'bob',
      creditsBaseUnits: 1_800,
      // Past deadline + ReclaimGrace, still PENDING: reclaimable. Was
      // `-Math.floor(RECLAIM_GRACE_BLOCKS / BLOCKS_PER_DAY) - 2 *
      // BLOCKS_PER_DAY` — RECLAIM_GRACE_BLOCKS (1200, ~1h) is far smaller
      // than a day, so converting it to WHOLE DAYS and flooring always
      // evaluated to -0, a silent no-op that happened to still land on
      // "reclaimable" only because the `-2 * BLOCKS_PER_DAY` term was
      // already large enough on its own to clear the (much smaller)
      // 1200-block grace window regardless. Express the grace window
      // directly in blocks instead, so this seed is genuinely, deliberately
      // past its own reclaim window (with a full 2-day margin) rather than
      // past it by accident.
      deadlineDeltaBlocks: -RECLAIM_GRACE_BLOCKS - 2 * BLOCKS_PER_DAY,
      rawStatus: 'PENDING',
      contentHash: 'cid-reclaimable-1',
      answerHash: null
    },
    {
      seq: 3,
      asker: 'alice',
      creditsBaseUnits: 1_800,
      deadlineDeltaBlocks: -5 * BLOCKS_PER_DAY,
      rawStatus: 'RECLAIMED',
      contentHash: 'cid-reclaimed-1',
      answerHash: null
    }
  ],
  [MOCK_FROZEN]: [
    // In-flight ask that survives the freeze untouched (SPEC §1.7.5: "in-flight
    // asks are never cut off").
    {
      seq: 0,
      asker: 'dave',
      creditsBaseUnits: 2_800,
      deadlineDeltaBlocks: 2 * BLOCKS_PER_DAY,
      rawStatus: 'PENDING',
      contentHash: 'cid-frozen-inflight',
      answerHash: null
    }
  ]
};

export function buildDeliveryWindows(headMs: number, pattern: Array<'answered' | 'missed' | 'pending'>): DeliveryWindow[] {
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  return pattern.map((outcome, i) => {
    const windowStartAt = headMs - (pattern.length - i) * WINDOW_MS;
    const windowEndAt = windowStartAt + WINDOW_MS;
    return {
      windowStartAt,
      windowEndAt,
      outcome,
      responseMs: outcome === 'answered' ? 3 * 60 * 60 * 1000 + i * 17 * 60 * 1000 : null
    };
  });
}

export const DELIVERY_PATTERNS: Record<string, Array<'answered' | 'missed' | 'pending'>> = {
  [MOCK_ACTIVE]: ['answered', 'answered', 'missed', 'answered', 'answered', 'answered', 'missed', 'answered', 'answered', 'answered', 'answered', 'pending'],
  [MOCK_OVERDUE]: ['answered', 'answered', 'answered', 'answered', 'answered', 'missed', 'answered', 'answered', 'answered', 'missed', 'pending', 'pending'],
  [MOCK_FROZEN]: ['answered', 'answered', 'answered', 'missed', 'missed', 'missed', 'missed', 'pending', 'pending', 'pending', 'pending', 'pending']
};

// A rate demonstrating visible token appreciation (fewer credits per ask than
// at PAR) for the mock's 'ok'-oracle demo path — mock-data-source.ts's
// readQuote() uses this for any market with supply > 0 (some trading
// history), falling back to the SAME PAR-settlement path a real, freshly-
// registered market uses otherwise (contract-math.ts's
// settlementRateBaseUnits).
//
// PREVIOUSLY 1_111, with a comment claiming "10% above PAR... 2.000 HBD ...
// 1.8 credits" — internally inconsistent (finding, cleanup item): core's
// rate is NOT a 3-decimal-scaled ratio the way HBD/credit AMOUNTS are —
// ask.go's creditsForAsk is literally `ceil(face/rate)` with no extra
// ASSET_DECIMALS factor, and params.go's ParBaseUnitsPerCredit is the bare
// integer 1 (not 1000) — so a "10%-above-PAR" rate expressed as a raw
// integer is not achievable at this feature's face magnitude (2.000 HBD =
// 2000 base units) without landing on a degenerate result:
// creditsForAskBaseUnits(2000, 1111) = ceil(2000/1111) = 2 base units =
// 0.002 credits for a 2.000 HBD face, not the claimed 1.8. 2 is the exactly-
// divisible choice that stays sane at this magnitude instead:
// creditsForAskBaseUnits(2000, 2) = 1000 base units = 1.000 credit — a
// clean, visible 2x appreciation with no rounding surprise.
export const MOCK_RATE_BASE_UNITS = 2;
