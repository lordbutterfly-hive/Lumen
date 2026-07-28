import type { DeliveryWindow } from '../../types';
import { BLOCKS_PER_DAY, EXIT_TAX_DECAY_BLOCKS, MS_PER_BLOCK, RECLAIM_GRACE_BLOCKS, areaBaseUnits } from '../contract-math';

// Fixture creators covering every state UI-BRIEF's build checklist (§2.4)
// requires. Any OTHER creator name resolves to "no market" (null) — which
// doubles as the real, common case of a profile that never became a creator.
// A reload keeps these fixed; simulated writes (buy/sell/refund/ask/...)
// persist on top of them to SESSION-TTL storage, same as
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

// =====================================================================
// ★ CURVE-PIVOT REWRITE (2026-07-24). See types.ts's / contract-math.ts's own
// "THE 1000x UNIT TRAP" doc before touching anything below: capTokens/
// supplyTokens/HolderSeed.tokens are WHOLE INTEGER token counts (curve.go),
// never a 3-decimal PAR credit amount.
// =====================================================================

export interface MarketSeed {
  faceBaseUnits: number;
  /** market.go kCap — INTEGER token ceiling. */
  capTokens: number;
  /** market.go kSupply — INTEGER tokens outstanding (held + escrowed). */
  supplyTokens: number;
  /**
   * HBD backing this market (market.go kReserve). Seeded below as
   * areaBaseUnits(supplyTokens) — curve.go's R === Area(S) EQUALITY
   * invariant, satisfied AT REGISTRATION/SEED TIME by construction — and then
   * MAINTAINED by the mock's own buy()/sell() as exact area-step deltas
   * (+cost / −gross), which is what KEEPS it equal to Area(supplyTokens)
   * through ordinary trading, exactly like the real curve.
   *
   * refund()/refundHolder() (the WIND-DOWN rail) debit this by the FLAT
   * pro-rata amount instead (refund.go refundPayout), which is deliberately
   * NOT an area step — see refund.go's own C-22 "ratio rises" doc for why the
   * reserve legitimately drifts ABOVE Area(remaining supply) once wind-down
   * is underway. So this field is genuinely separate, mutable state — not a
   * pure function of supplyTokens — exactly mirroring how the real chain
   * reads kReserve directly rather than re-deriving it from kSupply.
   */
  reserveBaseUnits: number;
  paidUntilDeltaBlocks: number; // relative to head; negative = lapsed
  registeredAtDeltaBlocks: number; // negative = in the past
  faceSetAtDeltaBlocks: number; // negative = in the past
  closedStored: boolean;
  globalInflowPaused: boolean;
  /**
   * market.go RetiredAt/kRetiredAt — an ABSOLUTE block, unlike every
   * *DeltaBlocks field above. Those are deliberately re-evaluated against the
   * CURRENT mockHeadBlock() on every buildMarket() call, so a fixture's "paid
   * up for 20 more days" or "lapsed 10 days ago" stays true forever across a
   * dev session. retiredAtBlock is the opposite: a PERMANENT historical mark
   * once Retire() is called — recomputing it relative to a moving "now" would
   * make the 5-day OVERDUE notice window never expire to FROZEN. null = never
   * retired.
   */
  retiredAtBlock: number | null;
}

export const MARKET_SEEDS: Record<string, MarketSeed> = {
  // A healthy, actively-traded market. face=2.000 HBD, set 2 days ago (band
  // still active). supplyTokens/capTokens are modest integers — the curve's
  // price is quadratic in supply, so a PAR-era "180,000 credits" scale would
  // be an absurd multi-billion-HBD reserve under the curve (see params.go's
  // own "Reserve at S=1,000 is 5,817.750 HBD" reference point).
  [MOCK_ACTIVE]: {
    faceBaseUnits: 2_000,
    capTokens: 5_000,
    supplyTokens: 620,
    reserveBaseUnits: areaBaseUnits(620), // R === Area(S), exactly, at seed time
    paidUntilDeltaBlocks: 20 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -90 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -2 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false,
    retiredAtBlock: null
  },
  // Lapsed 4.2 days ago; grace is 5 days, so ~19h of grace remain — matches
  // UI-BRIEF's "grace ends in 20h" example almost exactly. A NATURAL lapse,
  // not a Retire() — the curve rail (buy/sell) stays open throughout OVERDUE
  // (market.go: only a deliberate Retire closes it early, RULING K3).
  [MOCK_OVERDUE]: {
    faceBaseUnits: 1_500,
    capTokens: 2_000,
    supplyTokens: 240,
    reserveBaseUnits: areaBaseUnits(240),
    paidUntilDeltaBlocks: -Math.floor(4.2 * BLOCKS_PER_DAY),
    registeredAtDeltaBlocks: -40 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -20 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false,
    retiredAtBlock: null
  },
  // Lapsed 10 days ago — well past the 5-day grace, so FROZEN. Supply is
  // nonzero (some holders have not yet claimed): "mid wind-down," not
  // CLOSED. New buy/ask must both read as blocked; the curve Sell rail is
  // CLOSED too (sell.go's rail switch) — only refund()/refundHolder() work.
  [MOCK_FROZEN]: {
    faceBaseUnits: 3_000,
    capTokens: 1_500,
    supplyTokens: 95, // part of an original larger supply already refunded out
    reserveBaseUnits: areaBaseUnits(95),
    paidUntilDeltaBlocks: -10 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -120 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -60 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false,
    retiredAtBlock: null
  },
  // Registered, priced, ACTIVE — nobody has bought yet. supplyTokens===0 =>
  // reserveBaseUnits===areaBaseUnits(0)===0, the genesis case of the equality
  // invariant (curve.go: "the hypothesis is established at genesis").
  [MOCK_EMPTY]: {
    faceBaseUnits: 1_000,
    capTokens: 1_000,
    supplyTokens: 0,
    reserveBaseUnits: areaBaseUnits(0),
    paidUntilDeltaBlocks: 29 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -1 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -1 * BLOCKS_PER_DAY,
    closedStored: false,
    globalInflowPaused: false,
    retiredAtBlock: null
  },
  // Terminal: wind-down complete, supply drained to 0, kState==CLOSED wins
  // regardless of paidUntil (market.go Phase: "the ONLY stored state that wins").
  // refund.go's C-24: a complete wind-down drains the reserve to EXACTLY 0.
  [MOCK_CLOSED]: {
    faceBaseUnits: 1_800,
    capTokens: 800,
    supplyTokens: 0,
    reserveBaseUnits: 0,
    paidUntilDeltaBlocks: -200 * BLOCKS_PER_DAY,
    registeredAtDeltaBlocks: -260 * BLOCKS_PER_DAY,
    faceSetAtDeltaBlocks: -200 * BLOCKS_PER_DAY,
    closedStored: true,
    globalInflowPaused: false,
    retiredAtBlock: null
  }
};

export interface HolderSeed {
  holder: string;
  /** core/keys.go kBal — INTEGER tokens held. */
  tokens: number;
  /**
   * How long this position has been held, in blocks, as of "now"
   * (mockHeadBlock()) — drives exittax.go's ExitTaxBpsAt(heldBlocks) on
   * either exit door (curve Sell, sell.go; wind-down Refund, refund.go).
   * Spans the full range deliberately: a fresh position (near 0, near-max
   * 20% tax) alongside a fully-decayed one (>= EXIT_TAX_DECAY_BLOCKS, 0% tax)
   * so both mock scenarios (ACTIVE's curve-sell preview, FROZEN's wind-down
   * refund preview) demonstrate the whole tax curve, not just one point on it.
   */
  heldBlocks: number;
}

export const HOLDER_SEEDS: Record<string, HolderSeed[]> = {
  [MOCK_ACTIVE]: [
    { holder: 'alice', tokens: 150, heldBlocks: 10 * BLOCKS_PER_DAY }, // partway decayed
    { holder: 'bob', tokens: 40, heldBlocks: 2 * BLOCKS_PER_DAY }, // fresh, near-max tax
    { holder: 'carol', tokens: 300, heldBlocks: EXIT_TAX_DECAY_BLOCKS + 5 * BLOCKS_PER_DAY } // fully decayed, 0% tax
  ],
  [MOCK_OVERDUE]: [{ holder: 'alice', tokens: 200, heldBlocks: 30 * BLOCKS_PER_DAY }],
  [MOCK_FROZEN]: [
    { holder: 'alice', tokens: 60, heldBlocks: EXIT_TAX_DECAY_BLOCKS + 10 * BLOCKS_PER_DAY }, // fully decayed — 0% wind-down tax
    { holder: 'dave', tokens: 30, heldBlocks: 5 * BLOCKS_PER_DAY } // still fresh — pays most of the wind-down tax
  ],
  [MOCK_EMPTY]: [],
  [MOCK_CLOSED]: []
};

export interface AskSeed {
  seq: number;
  asker: string;
  /** WHOLE TOKENS (ask.go escrows against the same kBal balance Buy/Sell move) — not a 3-decimal amount, despite the legacy field name. */
  creditsBaseUnits: number;
  deadlineDeltaBlocks: number; // relative to head
  rawStatus: 'PENDING' | 'ANSWERED' | 'RECLAIMED' | 'DECLINED';
  /** The asker's hold clock, carried through the escrow (packEscrow field 6). Optional in fixtures; absent reads as 0 == maximally fresh, the safe direction. */
  acqBlock?: number;
  contentHash: string;
  answerHash: string | null;
}

// Covers all four required Ask states on one creator: awaiting, answered,
// reclaimable (past deadline+ReclaimGrace, unclaimed), reclaimed.
//
// NOT rewritten for the curve pivot: ask.go's escrowed "credits" now share
// the SAME whole-token balance Buy/Sell operate on (kBal) rather than a
// 3-decimal PAR quantity, but this feature's Ask read path
// (lib/vsc/reads.ts's buildAskFromParsed, an ALREADY-VERIFIED building block
// this task does not touch) still converts creditsBaseUnits via
// baseUnitsToHuman() — so these seeds are kept in that SAME pre-pivot scale
// deliberately, to stay a faithful stand-in for whatever readCreatorAsks()
// actually returns today, not a corrected value that would disagree with it.
// See the report for the flagged discrepancy.
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
      // Past deadline + ReclaimGrace, still PENDING: reclaimable. Expressed
      // directly in blocks (RECLAIM_GRACE_BLOCKS is far smaller than a day, so
      // converting it to whole days first would floor to 0) with a full 2-day
      // margin so this seed is genuinely, deliberately past its own reclaim
      // window rather than past it by accident.
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

// A rate demonstrating visible token appreciation (fewer tokens per ask than
// the market's own spot rate would otherwise imply) for the mock's
// 'ok'-oracle demo path — mock-data-source.ts's readQuote() uses this for any
// market with supply > 0 (some trading history), matching the shape
// settlementRateBaseUnits(estimate, supplyTokens) expects: min(estimate.rate,
// SpotRate(supply)). Kept as the exactly-divisible integer 2 (unchanged by
// the curve pivot — ask.go's creditsForAsk is still literally
// ceil(face/rate) with no extra scaling factor either side of the pivot):
// creditsForAskBaseUnits(2000, 2) = 1000 (tokens under the curve; credits
// under the old PAR scale) either way — a clean, visible 2x appreciation with
// no rounding surprise regardless of which era's units `2000` is read as.
export const MOCK_RATE_BASE_UNITS = 2;
