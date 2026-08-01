import type { AskStatus, FaceBand, MarketPhase, QuoteOracleStatus } from '../types';

// Faithful ports of the pure logic in /mnt/o/CREATOR-TOKENS/core/*.go. Both
// mock and vsc data sources call these; neither re-implements them, for the
// same reason CloseIfDrained (refund.go) calls Phase() instead of re-deriving
// lapse timing locally: "a second, independently-maintained copy... could
// silently drift." This file is the ONE place that drift-risk is retired for
// the whole feature — a reviewer diffing this against core/*.go should not
// need to wade through fixtures (mock/) or GQL plumbing (vsc/) to do it.
//
// REVIEWED AGAINST GO 2026-07-20 (this split): derivePhase (market.go Phase),
// refundPayoutBaseUnits (refund.go refundPayout — the exact
// mMulDiv(reserve, credits, supply) capped at credits*PAR, never a
// price-per-credit × balance shortcut), creditsForAskBaseUnits (ask.go
// creditsForAsk), and the TWAP replication below (twap.go AskRate — median
// reference, per-observation weight clamp, staleness refusal) were all
// checked term-for-term against core/*.go and MATCH. See the report for the
// two items noted, neither of which is in this file's ported math itself.
//
// RE-VERIFIED AGAINST GO 2026-07-20 (guard-wiring pass, later the same day):
// deriveFaceBandBaseUnits WAS STALE and has been rewritten below.
// market.go's SetFace changed its anti-rug band from "measured against the
// immediately preceding change" to "measured against a rolling WINDOW anchor
// (kFaceAnchor/kFaceAnchorAt, market.go:303-331) that persists across
// multiple calls" — same-day fix, documented in market.go's own SetFace
// comment ("THE BAND ANCHORS TO A WINDOW, NOT TO THE LAST CHANGE"). The old
// version of this function used (oldFace, faceSetAtBlock) as the band's
// center, which matched the PRE-fix compounding behaviour core itself
// disowns. Fixed below; see deriveFaceBandBaseUnits's own doc for the exact
// mirror. deriveAskStatus was also revised (not merely re-verified) to give
// the dead zone (deadline < block <= deadline+ReclaimGrace) its own status
// instead of folding it into 'awaiting' — see that function's doc.

// =====================================================================
// Protocol constants — ported 1:1 from /mnt/o/CREATOR-TOKENS/core/params.go.
// This is the ONLY place they are defined in this feature; mock and vsc both
// import from here so a constant can never drift between the two the way
// twap.go itself warns against ("a second, independently-maintained copy...
// could silently drift").
// =====================================================================

export const BLOCKS_PER_DAY = 28_800; // ~3s/block
export const MS_PER_BLOCK = 3_000;

export const COMMISSION_BPS = 1_200; // 12%
// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED 2026-07-21):
// core/launch.go deleted both the RegistrationFee constant and `register`'s
// own feePaid parameter — the spam filter is the Hive account cost plus the
// identity binding. The old REGISTRATION_FEE_BASE_UNITS export is gone rather
// than zeroed: a caller that still sent a feePaid field would now be REJECTED
// by main.go's register entrypoint (it no longer reads that key, and
// assertPayloadShape treats an unread key as a violation).
export const SUBSCRIPTION_FEE_BASE_UNITS = 10_000;
export const SUBSCRIPTION_PERIOD_BLOCKS = 30 * BLOCKS_PER_DAY;
export const MAX_PREPAID_PERIODS = 12;

export const GRACE_BLOCKS = 5 * BLOCKS_PER_DAY; // OVERDUE -> FROZEN

export const FACE_BAND_NUMERATOR = 2; // 2x/7d anti-rug band
export const FACE_BAND_WINDOW_BLOCKS = 7 * BLOCKS_PER_DAY;
// MinFace was raised 100 -> 500 (SET-2) -> 508 (LIVE-1) -> 577 (2026-07-27,
// grossed up for the commission carve-out): it is pinned to the GLOBAL-MINIMUM
// reachable settlement floor (the C4 face*2 >= rate guard at S == 2), grossed up so
// that only 100%-CommissionBps of the posted price still clears it. A client that
// validates against a STALE lower value lets a creator sign a `register`/`setFace`
// the contract rejects, burning their RC for a guaranteed revert.
// F-C5: kept in lockstep with Go core/params.go `MinFace int64 = 577`; a face in
// 508–576 passed this client and reverted on chain.
export const MIN_FACE_BASE_UNITS = 577;
export const MAX_FACE_BASE_UNITS = 10_000_000;

export const MIN_CAP_CREDITS_BASE_UNITS = 1;
export const MAX_CAP_CREDITS_BASE_UNITS = 1_000_000_000;

export const MIN_ASK_DEADLINE_BLOCKS = BLOCKS_PER_DAY;
export const MAX_ASK_DEADLINE_BLOCKS = 30 * BLOCKS_PER_DAY;
export const RECLAIM_GRACE_BLOCKS = 1_200; // ~1h — I6 disjoint answer/reclaim windows

export const OBS_WINDOW = 32;
export const MIN_OBS_BLOCKS = 1_200;
export const MIN_OBS_COUNT = 8;
export const MAX_RATE_DEVIATION_BPS = 2_000; // 20%, measured against the window MEDIAN (shared by both rings)
export const MAX_OBS_WEIGHT_BLOCKS = 2_400; // ~2h dwell clamp per observation
export const MAX_STALE_BLOCKS = 3 * BLOCKS_PER_DAY;

// F-C3: LONG (7-day) ring constants — mirror core/params.go EXACTLY. The long arm is
// coarser-sampled with a longer required span; it is the second arm of settlement's
// min(short, long, spot). Verified against params.go: LongObsSpacing 6300,
// LongMinObsCount 8, LongMinObsBlocks 2·BlocksPerDay, LongMaxObsWeightBlocks 2·spacing,
// LongMaxStaleBlocks MaxStaleBlocks+spacing.
export const LONG_OBS_SPACING = 6_300;
export const LONG_MIN_OBS_COUNT = 8;
export const LONG_MIN_OBS_BLOCKS = 2 * BLOCKS_PER_DAY; // 57_600
export const LONG_MAX_OBS_WEIGHT_BLOCKS = 2 * LONG_OBS_SPACING; // 12_600
export const LONG_MAX_STALE_BLOCKS = MAX_STALE_BLOCKS + LONG_OBS_SPACING; // 92_700

/** The per-ring parameters twapWindowRead (Go) reads with — mirrors core/twap.go's
 *  twapRingCfg so the client's short/long arms are byte-parameterised the same way. */
export interface TwapRingCfg {
  minCount: number;
  minSpan: number;
  maxStale: number;
  maxWeight: number;
  /** Samples recorded before this block are DROPPED (the long ring's re-registration
   *  epoch, `kRegisteredAt`). 0/undefined = keep all — the short ring is epoch-clean by
   *  its own kObsIdx reset, so it passes nothing here. */
  sinceBlock?: number;
}
export const SHORT_RING_CFG: TwapRingCfg = {
  minCount: MIN_OBS_COUNT,
  minSpan: MIN_OBS_BLOCKS,
  maxStale: MAX_STALE_BLOCKS,
  maxWeight: MAX_OBS_WEIGHT_BLOCKS
};
export const LONG_RING_CFG: TwapRingCfg = {
  minCount: LONG_MIN_OBS_COUNT,
  minSpan: LONG_MIN_OBS_BLOCKS,
  maxStale: LONG_MAX_STALE_BLOCKS,
  maxWeight: LONG_MAX_OBS_WEIGHT_BLOCKS
};

// =====================================================================
// THE BONDING CURVE (core/curve.go + params.go) — the 2026-07-21 pivot.
// PAR IS GONE. There is no PAR_BASE_UNITS_PER_CREDIT any more: core/prepay.go
// was DELETED, and with it the "1 credit == 1 HBD base unit at issuance"
// identity this file used to encode. A token's price now MOVES along
//
//     price(i) = BasePrice + (CurveLinNum·i + CurveQuadNum·i²) / CurveDenom
//
// and the reserve is the exact integer area under it.
//
// ★ UNIT CHANGE — THE 1000x TRAP. Under PAR a "credit" was a 3-decimal
// quantity that shared HBD's own granularity, so baseUnitsToHuman() applied
// to both. Under the curve, SUPPLY AND TOKEN AMOUNTS ARE WHOLE INTEGER
// TOKENS (curve.go indexes price by the token ordinal i; area(S) multiplies
// S by BasePrice directly), while HBD stays 3-decimal base units. One token
// costs ~1.008 HBD at launch. Passing a token count through
// baseUnitsToHuman() would understate it by exactly 1000x — never do it.
// Use the *Tokens helpers for token quantities and baseUnitsToHuman() only
// for HBD.
// =====================================================================

export const BASE_PRICE_BASE_UNITS = 1_000; // params.go BasePrice — 1.000 HBD, the RULING-H anti-snipe intercept
export const CURVE_LIN_NUM = 63_000; // params.go CurveLinNum   (a = 63/8)
export const CURVE_QUAD_NUM = 21; // params.go CurveQuadNum     (b = 21/8000)
export const CURVE_DENOM = 8_000; // params.go CurveDenom — the ONE rounding site

export const TRADE_FEE_BPS = 1_000; // params.go TradeFeeBps — 10%, split 5/5 creator/platform
export const MAX_EXIT_TAX_BPS = 2_000; // params.go MaxExitTaxBps — 20% at h == 0
export const EXIT_TAX_DECAY_BLOCKS = 42 * BLOCKS_PER_DAY; // params.go ExitTaxDecayBlocks — 6 weeks to 0

// ---- money: base-unit integer <-> human 3-decimal number ----
// Mirrors features/prediction-market/lib/vsc-money.ts's ASSET_DECIMALS/SCALE
// convention exactly. HBD carries 3 decimals. TOKENS DO NOT — see the unit
// note above; they are whole integers on the curve.

export const ASSET_DECIMALS = 3;
const SCALE = 10 ** ASSET_DECIMALS;

export function baseUnitsToHuman(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n / SCALE : 0;
}

export function humanToBaseUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * SCALE);
}

// ---- strict integer parsing for raw chain state (finding M-f) ----
// Every numeric value core/*.go stores is EITHER a u64 formatted via
// strconv.FormatUint/ParseUint (util.go getU64/setU64: block heights,
// sequence counters, the "...At" markers) OR a *big.Int formatted via
// big.Int.String()/SetString (money.go parseMoney, util.go getMoney/
// setMoney: face/cap/supply/reserve/credits/commission/twap-rate amounts) —
// see each function's own doc. NEITHER shape is ever a decimal point, an
// exponent, or any other float notation; `Number(v)` alone is looser than
// both (`Number("5.5")` is finite and would silently pass a naive
// `Number.isFinite` guard even though neither Go reader would ever accept
// "5.5"). This is that stricter check, shared by every raw-state numeric
// parse in this feature (reads.ts's toU64/parseEscrow, this file's own
// parseObsSlot) so a corrupt or malformed chain value is rejected the same
// way core's own readers would reject it, not silently coerced.
//
// Slightly LOOSER than strconv.ParseUint in one respect: ParseUint never
// accepts a leading '+'/'-' at all, while this accepts a leading '-' (then
// rejects the result for being negative) to also cover big.Int.SetString's
// grammar (which does allow a sign). Real chain state never emits a leading
// sign either way (FormatUint/big.Int.String() never produce one), so this
// is a defensive parser for state that is already malformed by definition —
// the one shape both real formats agree can never legitimately appear (a
// decimal point) is what this function exists to catch; sharing one parser
// for both u64 and money fields is a deliberate, documented simplification
// rather than maintaining two near-identical regexes for a divergence with
// no fund-safety consequence.
export function parseStrictBaseUnits(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '' || !/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

// ---- exact integer money math ----
// mulDivFloor/mulDivCeil mirror money.go's mMulDiv/mMulDivCeil exactly,
// including WHY: reserve*credits (both boundable up to ~1e9 base units) can
// reach ~1e18, past Number.MAX_SAFE_INTEGER (~9.007e15) — a plain `number`
// multiply here would silently lose precision on a fund-outflow computation.
// BigInt is used for the multiply-then-divide step only; every input/output
// at this feature's boundary stays `number` (matching vsc-money.ts's own
// convention) since it is always safe once the division has run.

function mulDivFloor(a: number, b: number, c: number): number {
  if (c <= 0) return 0;
  const product = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
  return Number(product / BigInt(Math.trunc(c)));
}

function mulDivCeil(a: number, b: number, c: number): number {
  if (c <= 0) return 0;
  const cc = BigInt(Math.trunc(c));
  const product = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
  return Number((product + cc - 1n) / cc);
}

function mulBpsFloor(total: number, bps: number): number {
  return mulDivFloor(total, bps, 10_000);
}

// =====================================================================
// Curve primitives — ported term-for-term from core/curve.go.
//
// ALL of this is BigInt internally and that is NOT defensive habit: the
// quadratic leg alone overflows JS safe-integer arithmetic well inside the
// protocol's own reachable range. At S = 283,000 (params.go's practical
// ceiling) the pyramidal number P(S) = S(S+1)(2S+1)/6 is ~1.5e16 — already
// past Number.MAX_SAFE_INTEGER (9.007e15) BEFORE the x21 multiply. A float
// port would silently misprice large markets rather than fail.
//
// NEVER round the linear and quadratic legs independently: curve.go's own
// recheck PROVED that breaks the round-trip equality (L5) in 65% of cases.
// There is exactly ONE floor, on the single common-denominator division.
// =====================================================================

const BIG_BASE = BigInt(BASE_PRICE_BASE_UNITS);
const BIG_LIN = BigInt(CURVE_LIN_NUM);
const BIG_QUAD = BigInt(CURVE_QUAD_NUM);
const BIG_DEN = BigInt(CURVE_DENOM);

/** T(S) = S(S+1)/2 — exact (S(S+1) is always even). */
function curveTri(s: bigint): bigint {
  return (s * (s + 1n)) / 2n;
}

/** P(S) = S(S+1)(2S+1)/6 — exact (the product is always divisible by 6). */
function curvePyr(s: bigint): bigint {
  return (s * (s + 1n) * (2n * s + 1n)) / 6n;
}

/** curve.go Area(S): S·BasePrice + floor((lin·T(S) + quad·P(S))/den), in HBD base units. */
function areaBig(s: bigint): bigint {
  if (s <= 0n) return 0n;
  return BIG_BASE * s + (BIG_LIN * curveTri(s) + BIG_QUAD * curvePyr(s)) / BIG_DEN;
}

/**
 * curve.go Area(S) — the integer HBD reserve backing supply S. THE invariant
 * of the whole mechanism is R === Area(S) with EQUALITY at every reachable
 * trading state, so this doubles as "what the reserve must currently hold".
 */
export function areaBaseUnits(supplyTokens: number): number {
  return Number(areaBig(BigInt(Math.trunc(supplyTokens))));
}

/** curve.go BuyCost(S,n) = Area(S+n) − Area(S) — the EXACT integer area step (L1). */
export function buyCostBaseUnits(supplyTokens: number, tokens: number): number {
  const s = BigInt(Math.trunc(supplyTokens));
  const n = BigInt(Math.trunc(tokens));
  if (n <= 0n) return 0;
  return Number(areaBig(s + n) - areaBig(s));
}

/**
 * curve.go SellProceeds(S,k) = Area(S) − Area(S−k) (L2). Returns null when
 * k > S — core returns a TYPED ERROR there rather than a number, and a
 * silently-wrong payout preview on a fund path is the one failure mode this
 * feature never accepts.
 */
export function sellProceedsBaseUnits(supplyTokens: number, tokens: number): number | null {
  const s = BigInt(Math.trunc(supplyTokens));
  const k = BigInt(Math.trunc(tokens));
  if (k <= 0n) return 0;
  if (k > s) return null;
  return Number(areaBig(s) - areaBig(s - k));
}

/** curve.go SpotRate(S) = base + floor((lin·S + quad·S²)/den); 0 at S == 0, deliberately. */
export function spotRateBaseUnits(supplyTokens: number): number {
  const s = BigInt(Math.trunc(supplyTokens));
  if (s <= 0n) return 0;
  return Number(BIG_BASE + (BIG_LIN * s + BIG_QUAD * s * s) / BIG_DEN);
}

/**
 * exittax.go ExitTaxBpsAt: 0 once held >= 6 weeks, else
 * ceil(MaxExitTaxBps·(D−h)/D) — CEIL, and seller-adverse by at most 1 bps.
 */
export function exitTaxBpsAt(heldBlocks: number): number {
  const h = Math.max(0, Math.trunc(heldBlocks));
  if (h >= EXIT_TAX_DECAY_BLOCKS) return 0;
  return mulDivCeil(MAX_EXIT_TAX_BPS, EXIT_TAX_DECAY_BLOCKS - h, EXIT_TAX_DECAY_BLOCKS);
}

/**
 * exittax.go ExitTaxOn: ceil(p·taxBps/10000) — RULING F: CEIL, never floor
 * (floor made the tax evadable by splitting a sell into <=4-token chunks),
 * and RULING K: on GROSS proceeds with NO realized-gain cap, which is what
 * makes it un-splittable (proceeds are path-independent, ceil superadditive).
 */
export function exitTaxOnBaseUnits(grossBaseUnits: number, taxBps: number): number {
  if (taxBps <= 0 || grossBaseUnits <= 0) return 0;
  return mulDivCeil(grossBaseUnits, taxBps, 10_000);
}

export interface TradeFeeSplit {
  feeBaseUnits: number;
  feeCreatorBaseUnits: number;
  feePlatformBaseUnits: number;
}

/** tradefee.go tradeFeeOn: floor(amount·TradeFeeBps/1e4), split floor(fee/2) to the creator, the odd unit to the platform. */
export function tradeFeeOn(amountBaseUnits: number): TradeFeeSplit {
  const feeBaseUnits = mulBpsFloor(amountBaseUnits, TRADE_FEE_BPS);
  const feeCreatorBaseUnits = Math.floor(feeBaseUnits / 2);
  return { feeBaseUnits, feeCreatorBaseUnits, feePlatformBaseUnits: feeBaseUnits - feeCreatorBaseUnits };
}

export interface BuyQuoteBaseUnits {
  tokens: number;
  costBaseUnits: number;
  feeBaseUnits: number;
  /** cost + fee — the single HiveDraw the buyer signs, and the transfer.allow cap they must approve. */
  totalDueBaseUnits: number;
  rateAfterBaseUnits: number;
}

/** buy.go's own arithmetic: cost = BuyCost(S,n); fee = floor(cost·TradeFeeBps/1e4); TotalDue = cost + fee. Mirrors the contract's `quoteBuy` entrypoint. */
export function quoteBuyBaseUnits(supplyTokens: number, tokens: number): BuyQuoteBaseUnits {
  const costBaseUnits = buyCostBaseUnits(supplyTokens, tokens);
  const { feeBaseUnits } = tradeFeeOn(costBaseUnits);
  return {
    tokens: Math.trunc(tokens),
    costBaseUnits,
    feeBaseUnits,
    totalDueBaseUnits: costBaseUnits + feeBaseUnits,
    rateAfterBaseUnits: spotRateBaseUnits(supplyTokens + Math.trunc(tokens))
  };
}

export interface SellQuoteBaseUnits {
  tokens: number;
  grossBaseUnits: number;
  taxBaseUnits: number;
  feeBaseUnits: number;
  /** gross − tax − fee — what the seller actually receives, and the number they feed back as `sell`'s minNet floor. */
  netBaseUnits: number;
  taxBps: number;
  heldBlocks: number;
}

/**
 * sell.go's own arithmetic: p = SellProceeds(S,ΔS); tax = ceil(p·τ/1e4) to the
 * TREASURY; fee = floor(p·TradeFeeBps/1e4); Net = p − tax − fee. Returns null
 * when the sell exceeds supply (core refuses rather than guessing).
 */
export function quoteSellBaseUnits(supplyTokens: number, tokens: number, heldBlocks: number): SellQuoteBaseUnits | null {
  const grossBaseUnits = sellProceedsBaseUnits(supplyTokens, tokens);
  if (grossBaseUnits === null) return null;
  const taxBps = exitTaxBpsAt(heldBlocks);
  const taxBaseUnits = exitTaxOnBaseUnits(grossBaseUnits, taxBps);
  const { feeBaseUnits } = tradeFeeOn(grossBaseUnits);
  return {
    tokens: Math.trunc(tokens),
    grossBaseUnits,
    taxBaseUnits,
    feeBaseUnits,
    netBaseUnits: grossBaseUnits - taxBaseUnits - feeBaseUnits,
    taxBps,
    heldBlocks: Math.max(0, Math.trunc(heldBlocks))
  };
}

/**
 * Inverse of quoteBuy for a budget-first UI ("spend 25 HBD"): the largest
 * WHOLE token count whose TotalDue (cost + trade fee) fits inside `budget`.
 *
 * Exact integer bisection over the real quote function — never an algebraic
 * approximation of the curve. TotalDue is strictly increasing in n (area is
 * monotone and the fee is a monotone function of it), so bisection is sound
 * and lands on the true boundary. Returns 0 when even one token is
 * unaffordable, which the caller must surface rather than rounding up into a
 * transaction that reverts.
 */
export function tokensAffordableForBudget(supplyTokens: number, budgetBaseUnits: number): number {
  if (budgetBaseUnits <= 0) return 0;
  if (quoteBuyBaseUnits(supplyTokens, 1).totalDueBaseUnits > budgetBaseUnits) return 0;
  let lo = 1;
  let hi = 2;
  while (quoteBuyBaseUnits(supplyTokens, hi).totalDueBaseUnits <= budgetBaseUnits) {
    lo = hi;
    hi *= 2;
    if (hi > 1e9) return lo; // params.go's own practical ceiling is ~283k tokens
  }
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (quoteBuyBaseUnits(supplyTokens, mid).totalDueBaseUnits <= budgetBaseUnits) lo = mid;
    else hi = mid;
  }
  return lo;
}

// =====================================================================
// Derivation — faithful ports of the pure logic in core/*.go.
// =====================================================================

const PHASE_RANK: Record<Exclude<MarketPhase, 'UNKNOWN'>, number> = { ACTIVE: 0, OVERDUE: 1, FROZEN: 2, CLOSED: 3 };

/** market.go naturalPhase — the subscription ladder alone, with no retire input. */
function naturalPhase(paidUntilBlock: number, block: number): Exclude<MarketPhase, 'UNKNOWN'> {
  if (block <= paidUntilBlock) return 'ACTIVE';
  if (block < paidUntilBlock + GRACE_BLOCKS) return 'OVERDUE';
  return 'FROZEN';
}

/**
 * market.go Phase(), the 4 real contract values only — UNKNOWN is assigned by
 * the caller on read failure, never by this function.
 *
 * ★ RULING D (2026-07-21), MISSING FROM THIS PORT UNTIL NOW: Phase is
 * MAX(naturalPhase, retiredPhase) over ACTIVE < OVERDUE < FROZEN < CLOSED,
 * where a retired market is OVERDUE for its 5-day notice window and FROZEN
 * after. The MAX is load-bearing on the contract side (retiring may only ever
 * make a market MORE frozen, never un-freeze it); here it is what stops the
 * UI showing a retired market as tradeable ACTIVE and inviting a buy that
 * core.Buy's own RequireInflowOpen gate would revert.
 *
 * `retiredAtBlock` is the DECODED height (0/null when never retired) — note
 * the chain stores block+1 so that 0 can mean "never"; see reads.ts's
 * decodeRetiredAt.
 */
export function derivePhase(closedStored: boolean, paidUntilBlock: number, block: number, retiredAtBlock: number | null = null): Exclude<MarketPhase, 'UNKNOWN'> {
  if (closedStored) return 'CLOSED';
  const natural = naturalPhase(paidUntilBlock, block);
  if (retiredAtBlock === null) return natural;
  const forced: Exclude<MarketPhase, 'UNKNOWN'> = block < retiredAtBlock + GRACE_BLOCKS ? 'OVERDUE' : 'FROZEN';
  return PHASE_RANK[forced] > PHASE_RANK[natural] ? forced : natural;
}

/** market.go RequireInflowOpen: phase ACTIVE or OVERDUE, AND the global pause clear. Gates Prepay and Ask identically. */
export function canInflowOpen(phase: MarketPhase, globalInflowPaused: boolean): boolean {
  return !globalInflowPaused && (phase === 'ACTIVE' || phase === 'OVERDUE');
}

/** paidUntilBlock + GraceBlocks — the block OVERDUE becomes FROZEN. Always defined; only meaningful once the market has actually lapsed. No kFrozenAt read needed (see types.ts Market.graceExpiresAtBlock doc: the key exists in keys.go but no core module ever writes it). */
export function deriveGraceExpiresAtBlock(paidUntilBlock: number): number {
  return paidUntilBlock + GRACE_BLOCKS;
}

/**
 * market.go SetFace's anti-rug band, in base units — mirrors market.go:303-331
 * EXACTLY, including the two-step anchor resolution:
 *
 *  1. (market.go:303-308) If no anchor has ever been persisted
 *     (kFaceAnchor == 0, `anchorFaceBaseUnits` param here), the window opens
 *     at the face/block CURRENTLY in effect (`currentFaceBaseUnits`/
 *     `faceSetAtBlock`) — this is the only place those two params are used.
 *  2. (market.go:310-323) If the resolved anchor's window has fully elapsed
 *     (`block - anchorAt >= FaceBandWindow`), a NEW window opens anchored at
 *     the face currently in effect, at `block` — "waiting out the window
 *     earns another 2x of headroom, not a licence to jump anywhere"
 *     (market.go's own comment). This is what makes bandActive effectively
 *     ALWAYS true for any registered market: the band never lifts to
 *     [MinFace, MaxFace] only, it just re-centers.
 *
 * `anchorFaceBaseUnits`/`anchorAtBlock` are the raw kFaceAnchor/
 * kFaceAnchorAt reads (0 if never written — same "missing key -> 0" default
 * every getMoney/getU64 read in core/util.go already uses).
 *
 * minHbd/maxHbd are the intersection of this band with the separate,
 * unconditional [MinFace, MaxFace] protocol range (market.go:132-134/
 * 282-284) — the two are independent AND conditions on-chain, so a
 * client-side guard needs their intersection to know what SetFace will
 * actually accept.
 */
export function deriveFaceBandBaseUnits(currentFaceBaseUnits: number, faceSetAtBlock: number, anchorFaceBaseUnits: number, anchorAtBlock: number, block: number): FaceBand {
  let effectiveAnchorFace = anchorFaceBaseUnits;
  let effectiveAnchorAt = anchorAtBlock;
  if (effectiveAnchorFace === 0) {
    // market.go:305-308.
    effectiveAnchorFace = currentFaceBaseUnits;
    effectiveAnchorAt = faceSetAtBlock;
  }

  // market.go:310-313 — defensive: a non-monotone block keeps the band
  // ACTIVE rather than lifting it (mirrors core's own "elapsed = 0" default).
  const elapsed = block > effectiveAnchorAt ? block - effectiveAnchorAt : 0;
  if (elapsed >= FACE_BAND_WINDOW_BLOCKS) {
    // market.go:314-323 — re-anchor at the CURRENT face, now.
    effectiveAnchorFace = currentFaceBaseUnits;
    effectiveAnchorAt = block;
  }

  const windowEndsAtBlock = effectiveAnchorAt + FACE_BAND_WINDOW_BLOCKS;

  if (effectiveAnchorFace <= 0) {
    // market.go:324 `if anchorFace.Sign() > 0`. Unreachable for any actually
    // registered market — Register always writes a positive kFace
    // (market.go:168), so the bootstrap branch above can never leave
    // effectiveAnchorFace at 0 either. Mirrored anyway for fidelity rather
    // than assuming the on-chain guard can't fire.
    return { minHbd: MIN_FACE_BASE_UNITS, maxHbd: MAX_FACE_BASE_UNITS, bandActive: false, windowEndsAtBlock };
  }

  // market.go:326-329.
  const lower = Math.floor(effectiveAnchorFace / FACE_BAND_NUMERATOR);
  const upper = effectiveAnchorFace * FACE_BAND_NUMERATOR;
  return {
    minHbd: Math.max(lower, MIN_FACE_BASE_UNITS),
    maxHbd: Math.min(upper, MAX_FACE_BASE_UNITS),
    bandActive: true,
    windowEndsAtBlock
  };
}

/**
 * refund.go refundPayout: floor(reserve*credits/supply), capped at
 * credits*PAR. Caller guarantees supply > 0.
 *
 * VERIFIED 2026-07-20: this is `mMulDiv(reserve, credits, supply)` capped at
 * `credits` (PAR == 1), exactly refund.go's own `refundPayout`, and NOT
 * `credits * refundPricePerCredit` — that shortcut would compound two
 * separate floor-roundings (one baked into a per-credit price, a second
 * multiplying it back out) and can understate a real payout. The single
 * floor happens here, once, matching refund.go's own comment: "the single
 * place the solvency-critical rounding happens, so RefundPrice, Refund and
 * RefundHolder can never disagree... about what a given (reserve, credits,
 * supply) triple is worth."
 */
export function refundPayoutBaseUnits(reserveBaseUnits: number, tokens: number, supplyTokens: number): number {
  return mulDivFloor(reserveBaseUnits, tokens, supplyTokens);
}

/**
 * refund.go's K2 leg — THE WIND-DOWN IS TAXED. The same hold-time-decaying
 * exit tax the curve charges is carved from the pro-rata payout to the
 * treasury, so a fresh whale who triggers Retire to escape the curve tax pays
 * the identical rate on the way out. Unlike Sell there is NO trade fee here
 * (charging a fee to exit a dying market is holder-hostile).
 *
 *     gross = floor(reserve·tokens/supply)
 *     net   = gross − ceil(gross·τ(h)/1e4)
 *
 * A UI that shows `gross` as "you will receive" overstates a fresh holder's
 * payout by up to 20%.
 */
export function refundNetBaseUnits(
  reserveBaseUnits: number,
  tokens: number,
  supplyTokens: number,
  heldBlocks: number,
  maturingTokens?: number
): { grossBaseUnits: number; taxBaseUnits: number; netBaseUnits: number; taxBps: number } {
  const grossBaseUnits = refundPayoutBaseUnits(reserveBaseUnits, tokens, supplyTokens);
  const taxBps = exitTaxBpsAt(heldBlocks);
  // TWO BUCKETS (F-C5 / H-FE-4). refund.go taxes only the MATURING share of the
  // draw — matured tokens are 0% by definition — apportioned pro rata by token
  // count:
  //     _, fromMaturing := splitDraw(...)                    // maturing FIRST
  //     tax = ExitTaxOn(maturingGrossShare(gross, fromMaturing, credits), τ)
  // Taxing the whole gross would overstate the tax (understate the payout) for
  // any holder with matured tokens.
  //
  // maturingTokens omitted ⇒ treat the entire position as maturing, which is
  // exactly what this function computed before and what every existing caller
  // means; the whole-gross path is preserved bit-for-bit via the
  // fromMaturing === total shortcut below.
  const maturing = maturingTokens === undefined ? tokens : maturingTokens;
  const fromMaturing = Math.min(tokens, Math.max(0, maturing)); // splitDraw, maturing-first
  const taxableBaseUnits = maturingGrossShareBaseUnits(grossBaseUnits, fromMaturing, tokens);
  const taxBaseUnits = exitTaxOnBaseUnits(taxableBaseUnits, taxBps);
  return { grossBaseUnits, taxBaseUnits, netBaseUnits: grossBaseUnits - taxBaseUnits, taxBps };
}

/**
 * matured.go maturingGrossShare, ported exactly — pro rata by token count,
 * rounded UP (ceil keeps the residue in the more-tax direction, RULING F).
 *
 * The shortcuts are not optimisations, they are the contract's own: an
 * all-maturing draw returns the FULL gross rather than a mulDivCeil that could
 * round differently, and any zero returns zero.
 */
export function maturingGrossShareBaseUnits(grossBaseUnits: number, fromMaturing: number, totalTokens: number): number {
  if (fromMaturing <= 0 || grossBaseUnits <= 0 || totalTokens <= 0) return 0;
  if (fromMaturing === totalTokens) return grossBaseUnits;
  return mulDivCeil(grossBaseUnits, fromMaturing, totalTokens);
}

/**
 * refund.go RefundPrice literally ported: floor(reserve*1/supply), capped at
 * PAR. VERIFIED against refund_test.go's own TestRefundPrice_NormalRatio,
 * which asserts this floors to 0 at reserve=700/supply=1000 — a real 70%
 * ratio — with the test's own comment "NOT a bug." Kept for fidelity, but
 * this is a near-useless DISPLAY value at any realistic scale (it floors to 0
 * or 1 for almost every reserve/supply pair, because it evaluates the payout
 * for a single base-unit credit). Do not wire this to a UI "floor price"
 * field — see floorRatioForDisplay below for what Market.refundPricePerCredit
 * actually uses, and refundPayoutBaseUnits above for the exact, contract-
 * faithful amount a specific holder's balance would redeem for.
 */
export function contractRefundPriceBaseUnits(reserveBaseUnits: number, supplyTokens: number): number {
  if (supplyTokens <= 0) return 0;
  return refundPayoutBaseUnits(reserveBaseUnits, 1, supplyTokens);
}

/**
 * NOT a contract function. The true, unrounded reserve/supply ratio (capped
 * at PAR = 1), for the "floor" figure UI-BRIEF shows beside the ask price
 * (Page 1 point 5: "shown next to the price at equal weight") and beside cap
 * remaining (Page 5). contractRefundPriceBaseUnits() above is what the
 * contract's own RefundPrice() literally returns and is unusable for this —
 * it floors to 0 or 1 at realistic scale (proven above). This ratio carries
 * no fund-moving weight of its own (nothing pays out "the market's floor
 * price" as such); a holder's actual redemption always goes through
 * refundPayoutBaseUnits() against their real balance, which is exact.
 *
 * SEMANTICS CHECKED AGAINST core/read.go's RefundRatioBps (added to Go
 * 2026-07-20, after this function was first written): both compute the same
 * quantity — min(reserve/supply, PAR), zero when supply <= 0, floor-rounded
 * (never overstates coverage). RefundRatioBps discretizes it to whole basis
 * points (0..10000) for a wasm/log caller that can't return a float; this
 * function deliberately stays a full-precision JS number (reserve and supply
 * are both bounded well under Number.MAX_SAFE_INTEGER at this protocol's
 * caps, so plain float division loses no precision here) so the UI can show
 * a coverage percentage finer than 0.01% if it ever wants to. Aligned, not
 * duplicated-and-drifted: no change needed.
 */
export function reserveCoverageRatio(reserveBaseUnits: number, supplyTokens: number): number {
  if (supplyTokens <= 0) return 0;
  const area = areaBaseUnits(supplyTokens);
  if (area <= 0) return 0;
  return Math.min(reserveBaseUnits / area, 1);
}

/**
 * The market's FLOOR in HBD per token — floor(reserve/supply), the pro-rata
 * value a wind-down pays before the exit tax. Under PAR this was a useless
 * display value (it floored to 0 or 1 at any realistic scale, because a
 * "credit" was a single base unit); under the curve a token is a whole unit
 * backed by ~1 HBD or more, so this is now a genuinely meaningful number and
 * IS the floor the UI shows beside the market price.
 *
 * NOT what a specific holder receives: that goes through refundNetBaseUnits()
 * against their real balance AND their own hold clock (the exit tax is
 * per-holder). Showing this as "you will receive" overstates a fresh
 * holder's payout.
 */
export function floorPricePerTokenBaseUnits(reserveBaseUnits: number, supplyTokens: number): number {
  return contractRefundPriceBaseUnits(reserveBaseUnits, supplyTokens);
}

/** ask.go creditsForAsk: ceil(face/rate). rate is HBD base units per credit; caller guarantees rate > 0. */
export function creditsForAskBaseUnits(faceBaseUnits: number, rateBaseUnitsPerCredit: number): number {
  return mulDivCeil(faceBaseUnits, 1, rateBaseUnitsPerCredit);
}

/** ask.go commissionOwedFor: floor(face * CommissionBps / 10000). */
export function commissionOwedForBaseUnits(faceBaseUnits: number): number {
  return mulBpsFloor(faceBaseUnits, COMMISSION_BPS);
}

export interface FaceSplit {
  /** What creditsForAsk actually prices — NEVER the raw face. */
  tokenLegBaseUnits: number;
  /** The 12% platform commission — a SEPARATE HBD leg, paid alongside the token leg, never added on top of it. */
  commissionBaseUnits: number;
}

/**
 * ask.go splitFace (USER RULING 2026-07-27): the posted face is the buyer's
 * TOTAL, not a token-only price. commission = floor(face·CommissionBps/10000);
 * the token leg is the REMAINDER, so the two always re-sum to the posted face
 * exactly — the rounding can only ever favour the CREATOR (at most 1 base
 * unit), never overcharge the buyer.
 *
 * THE BUG THIS CLOSES: callers used to feed the raw `faceBaseUnits` straight
 * into creditsForAskBaseUnits (pricing the FULL posted amount in tokens)
 * while the commission was ALSO drawn as a separate HBD leg — so a posted
 * "200" cost the buyer 224 (200 in tokens + 24 in HBD), a surcharge that
 * appeared on no screen and in no spec (ask.go's own splitFace doc). Every
 * caller that needs "how many tokens does this ask cost" must split first and
 * price tokenLegBaseUnits — never the raw face.
 */
export function splitFaceBaseUnits(faceBaseUnits: number): FaceSplit {
  const commissionBaseUnits = commissionOwedForBaseUnits(faceBaseUnits);
  return { tokenLegBaseUnits: faceBaseUnits - commissionBaseUnits, commissionBaseUnits };
}

/**
 * ask.go's I6 disjoint-window guard, restated as a status instead of a
 * legality check. REVISED 2026-07-20 (guard-wiring pass): PENDING now splits
 * into THREE states, not two — the previous version folded the dead zone
 * (deadline < block <= deadline+ReclaimGrace, where NEITHER action is legal)
 * into `awaiting`, which meant a creator could see "awaiting", try to
 * answer, and get a guaranteed on-chain revert. That gap is now its own
 * `expired` status:
 *
 *  - `awaiting`    block <= deadlineBlock                          (ask.go:368 Answer's own bound, inverted)
 *  - `expired`     deadlineBlock < block <= deadlineBlock+ReclaimGrace  (dead zone — I6's own gap)
 *  - `reclaimable` block > deadlineBlock+ReclaimGrace               (ask.go:414 Reclaim's own bound, inverted)
 */
export function deriveAskStatus(rawStatus: 'PENDING' | 'ANSWERED' | 'RECLAIMED' | 'DECLINED', deadlineBlock: number, block: number): AskStatus {
  if (rawStatus === 'ANSWERED') return 'answered';
  if (rawStatus === 'RECLAIMED') return 'reclaimed';
  // DECLINED is terminal and block-independent, exactly like the two above.
  if (rawStatus === 'DECLINED') return 'declined';
  if (block <= deadlineBlock) return 'awaiting';
  if (block > deadlineBlock + RECLAIM_GRACE_BLOCKS) return 'reclaimable';
  return 'expired';
}

/** Block height -> epoch ms estimate, identical shape to vsc-market-data-source.ts's deriveClosesAt: falls back to "now" when the chain head is unavailable, so a stalled countdown reads as "happening now" rather than a wrong future/past time. */
export function blockToEpochMs(targetBlock: number, headBlock: number | null): number {
  if (headBlock === null) return Date.now();
  return Date.now() + (targetBlock - headBlock) * MS_PER_BLOCK;
}

// =====================================================================
// TWAP replication (twap.go AskRate) — the only way to preview an ask price,
// since the contract stores raw observations, never a cached rate.
// =====================================================================

export interface RawObservation {
  block: number;
  rateBaseUnits: number;
}

/**
 * Ring-buffer physical-slot math, mirrored from twap.go's RecordObs/AskRate
 * doc comment: "the physical slot for the n-th write is always n % ObsWindow."
 * `slotValues` must be the raw packed "<block>|<rate>" strings for physical
 * slots 0..ObsWindow-1 (or null where a slot was never read/never written).
 * Returns null — the whole read fails — if any slot inside the live window is
 * missing or corrupt, matching AskRate()'s own hard ErrState rather than
 * silently producing a partially-wrong weighted average.
 *
 * SPLIT NOTE (checked, not changed): Go's AskRate rejects on `count <
 * MinObsCount` BEFORE it ever reads a single slot, so a corrupt slot inside a
 * too-small window never surfaces there — it reads as plain
 * 'insufficient_observations'. This function, by contrast, always decodes the
 * full [startSeq, n) range regardless of MIN_OBS_COUNT, so the same corrupt
 * slot instead surfaces as this function returning null ->
 * askRateFromObservations never even gets called -> the caller (vsc/reads.ts)
 * reports 'unavailable'. The two only disagree when a slot that SHOULD hold
 * valid data (RecordObs only ever writes valid packed values) is somehow
 * unparseable — an already-Byzantine precondition on either side of this
 * split. Both outcomes are honest refusals to price (Quote.rate stays null;
 * see types.ts's own "never authoritative" doc), so no fund-moving or
 * on-chain-authoritative behaviour is affected either way — the real AskRate
 * on-chain is untouched by anything in this frontend. Left as-is rather than
 * re-coupling decode and threshold-check back together, since 'unavailable'
 * is if anything the more honest of the two labels for state that is
 * actually corrupt. Flagged in the report per the task brief.
 */
export function decodeObservationRing(slotValues: Array<string | null>, obsIdxCount: number): RawObservation[] | null {
  const n = obsIdxCount;
  if (n <= 0) return [];
  const startSeq = n > OBS_WINDOW ? n - OBS_WINDOW : 0;
  const points: RawObservation[] = [];
  for (let seq = startSeq; seq < n; seq++) {
    const raw = slotValues[seq % OBS_WINDOW];
    const parsed = raw ? parseObsSlot(raw) : null;
    if (!parsed) return null;
    points.push(parsed);
  }
  return points;
}

function parseObsSlot(v: string): RawObservation | null {
  const i = v.indexOf('|');
  if (i < 0) return null;
  // twap.go packTwapObs: "<block>|<rate>" — block via strconv.FormatUint,
  // rate via big.Int.String(). Both integer-strict (M-f) — see
  // parseStrictBaseUnits's own doc.
  const block = parseStrictBaseUnits(v.slice(0, i));
  const rateBaseUnits = parseStrictBaseUnits(v.slice(i + 1));
  if (block === null || rateBaseUnits === null || rateBaseUnits <= 0) return null;
  return { block, rateBaseUnits };
}

function medianRateBaseUnits(points: RawObservation[]): bigint {
  const rates = points.map((p) => BigInt(Math.trunc(p.rateBaseUnits))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = rates.length;
  if (n === 0) return 0n;
  if (n % 2 === 1) return rates[(n - 1) / 2];
  return (rates[n / 2 - 1] + rates[n / 2]) / 2n;
}

export interface AskRateEstimate {
  rateBaseUnits: number | null;
  status: QuoteOracleStatus;
}

/**
 * twap.go AskRate, ported term for term — same guards, same order, same
 * clamps. `points` must already be chronological (decodeObservationRing's
 * contract).
 *
 * VERIFIED 2026-07-20 against twap.go line for line: the MinObsCount gate,
 * the oldest/newest staleness checks (in the same order Go runs them —
 * staleness before span), the per-observation weight clamp at
 * MaxObsWeightBlocks, the floor division for the TWAP itself (favours the
 * reserve, matching mMulDiv's own rounding convention), the deviation cap
 * measured against the window MEDIAN (never the newest observation — the
 * self-referential case twap.go's own comment warns about), and the final
 * non-positive-twap refusal. No divergence found.
 */
export function askRateFromObservations(
  points: RawObservation[],
  block: number,
  cfg: TwapRingCfg = SHORT_RING_CFG
): AskRateEstimate {
  // F-C3: drop samples from before the ring's registration epoch. The long ring's write
  // counter survives re-registration, so a re-registered market would otherwise price off
  // the DEAD incarnation's rates (mirrors core/twap.go twapWindowRead's `o.block <
  // cfg.sinceBlock` drop). The short ring passes sinceBlock 0 (its kObsIdx is reset per
  // incarnation) and keeps every sample.
  const since = cfg.sinceBlock ?? 0;
  const pts = since > 0 ? points.filter((p) => p.block >= since) : points;

  if (pts.length < cfg.minCount) return { rateBaseUnits: null, status: 'insufficient_observations' };

  const oldest = pts[0].block;
  if (block < oldest) return { rateBaseUnits: null, status: 'unavailable' };

  const newest = pts[pts.length - 1].block;
  if (block > newest && block - newest > cfg.maxStale) return { rateBaseUnits: null, status: 'stale' };

  const windowBlocks = block - oldest;
  if (windowBlocks < cfg.minSpan) return { rateBaseUnits: null, status: 'insufficient_span' };

  let weighted = 0n;
  let totalW = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    let w: number;
    if (i === pts.length - 1) {
      if (block < p.block) return { rateBaseUnits: null, status: 'unavailable' };
      w = block - p.block;
    } else {
      const next = pts[i + 1].block;
      if (next < p.block) return { rateBaseUnits: null, status: 'unavailable' };
      w = next - p.block;
    }
    if (w > cfg.maxWeight) w = cfg.maxWeight;
    if (w === 0) continue;
    totalW += w;
    weighted += BigInt(Math.trunc(p.rateBaseUnits)) * BigInt(w);
  }
  if (totalW < cfg.minSpan) return { rateBaseUnits: null, status: 'insufficient_span' };

  const twap = weighted / BigInt(totalW); // floor, favours the reserve (fewer credits per HBD of face means MORE credits spent — see ask.go creditsForAsk comment)

  const ref = medianRateBaseUnits(pts);
  if (ref <= 0n) return { rateBaseUnits: null, status: 'unavailable' };
  const diff = twap > ref ? twap - ref : ref - twap;
  const lhs = diff * 10_000n;
  const rhs = ref * BigInt(MAX_RATE_DEVIATION_BPS);
  if (lhs > rhs) return { rateBaseUnits: null, status: 'deviation_capped' };

  if (twap <= 0n) return { rateBaseUnits: null, status: 'unavailable' };
  return { rateBaseUnits: Number(twap), status: 'ok' };
}

// =====================================================================
// Settlement rate (ask.go SettlementRate) — finding C-C. NOT previously
// ported: this file only had AskRate (TWAP-or-null), never the PAR fallback
// ask.go's own SettlementRate wraps it in. On a live deployment today no DEX
// pool feeds RecordObs, so AskRate ALWAYS returns a non-ok status and PAR (1
// credit base unit per HBD base unit, PAR_BASE_UNITS_PER_CREDIT) is what
// every real ask actually settles at — see ask.go's own SettlementRate doc
// for the full "this is a safe, EXPLICIT default, not a silent fallback to
// something attacker-controlled" argument. Never returns null and never <=
// 0, matching core exactly.
// =====================================================================

export interface SettlementRateResult {
  /** null means REFUSED — there is no safe rate. Never substitute a number here. */
  rateBaseUnits: number | null;
  status: QuoteOracleStatus;
}

/**
 * settlement.go SettlementRate — ★ REWRITTEN 2026-07-24 for RULING C.
 *
 * THE PAR FALLBACK IS DELETED. This function used to return
 * PAR_BASE_UNITS_PER_CREDIT (1) whenever the TWAP guards failed, mirroring
 * the old `if err == nil { return rate }; return PAR` shape. RULING C removed
 * that branch from the contract because PAR was wrong by exactly the factor
 * `spot`, ALWAYS in the asker-robbing direction: a 0.1 HBD service cost 100
 * tokens where correct pricing costs 1. The contract now returns a typed
 * ERROR instead, and a refusal only ever blocks a NEW service inflow — no
 * outflow consults settlement, so refusing can never trap anyone's funds.
 *
 * A client that kept the PAR fallback would quote a price the chain would
 * never charge and invite an ask that reverts (or, worse, one that succeeds
 * against a maxCredits cap the user signed on a 100x-wrong preview). So this
 * refuses too.
 *
 * ⚠️ NOT A COMPLETE PORT, DELIBERATELY. The contract's rate is
 * min(TWAP_short, TWAP_long_7d, SpotRate(supply)) plus the C5 divergence
 * tripwire, and SettleSpend adds the C4 minimum-price guard and the C2 depth
 * ceiling. Only the SHORT ring and the SPOT arm are replicated here (the
 * 7-day long ring is read from a separate "twl|" key family that this client
 * does not yet fetch). Taking a min over FEWER arms can only ever return a
 * rate >= the true one, and a too-high rate makes an ask look CHEAPER in
 * credits than it really is — so this reports the shortfall as a status
 * rather than pretending to authority it does not have. The drift-proof fix
 * is to call the contract's own `quote` entrypoint, which returns the real
 * rate with refusal semantics baked in; see READ_PAYLOAD_SPECS in
 * vsc/payload-contract.ts.
 */
export function settlementRateBaseUnits(
  short: AskRateEstimate,
  long: AskRateEstimate,
  supplyTokens: number
): SettlementRateResult {
  // F-C3: the contract's SettlementRate refuses if EITHER TWAP arm refuses, then takes
  // min(short, long, spot) (core/settlement.go). Previously only the short arm + spot
  // were replicated here, so a preview could OVERSTATE the rate — and thus understate
  // the credits an ask would spend — whenever the LONG arm was the binding (lowest)
  // constraint, diverging from what a real ask() settles at. Surface the first refusing
  // arm's status so the preview reads 'unavailable' exactly when execution would refuse.
  if (short.status !== 'ok' || short.rateBaseUnits === null || short.rateBaseUnits <= 0) {
    return { rateBaseUnits: null, status: short.status === 'ok' ? 'unavailable' : short.status };
  }
  if (long.status !== 'ok' || long.rateBaseUnits === null || long.rateBaseUnits <= 0) {
    return { rateBaseUnits: null, status: long.status === 'ok' ? 'unavailable' : long.status };
  }
  const spot = spotRateBaseUnits(supplyTokens);
  if (spot <= 0) {
    // S == 0: no supply, no traded rate. core's own convention — an empty
    // market records no observation rather than a synthetic one.
    return { rateBaseUnits: null, status: 'insufficient_observations' };
  }
  return { rateBaseUnits: Math.min(short.rateBaseUnits, long.rateBaseUnits, spot), status: 'ok' };
}
