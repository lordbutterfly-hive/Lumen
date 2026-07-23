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
export const REGISTRATION_FEE_BASE_UNITS = 10_000; // 10.000 HBD
export const SUBSCRIPTION_FEE_BASE_UNITS = 10_000;
export const SUBSCRIPTION_PERIOD_BLOCKS = 30 * BLOCKS_PER_DAY;
export const MAX_PREPAID_PERIODS = 12;

export const GRACE_BLOCKS = 5 * BLOCKS_PER_DAY; // OVERDUE -> FROZEN

export const FACE_BAND_NUMERATOR = 2; // 2x/7d anti-rug band
export const FACE_BAND_WINDOW_BLOCKS = 7 * BLOCKS_PER_DAY;
export const MIN_FACE_BASE_UNITS = 100;
export const MAX_FACE_BASE_UNITS = 10_000_000;

export const MIN_CAP_CREDITS_BASE_UNITS = 1;
export const MAX_CAP_CREDITS_BASE_UNITS = 1_000_000_000;

export const MIN_ASK_DEADLINE_BLOCKS = BLOCKS_PER_DAY;
export const MAX_ASK_DEADLINE_BLOCKS = 30 * BLOCKS_PER_DAY;
export const RECLAIM_GRACE_BLOCKS = 1_200; // ~1h — I6 disjoint answer/reclaim windows

export const OBS_WINDOW = 32;
export const MIN_OBS_BLOCKS = 1_200;
export const MIN_OBS_COUNT = 8;
export const MAX_RATE_DEVIATION_BPS = 2_000; // 20%, measured against the window MEDIAN
export const MAX_OBS_WEIGHT_BLOCKS = 2_400; // ~2h dwell clamp per observation
export const MAX_STALE_BLOCKS = 3 * BLOCKS_PER_DAY;

export const PAR_BASE_UNITS_PER_CREDIT = 1;

// ---- money: base-unit integer <-> human 3-decimal number ----
// Mirrors features/prediction-market/lib/vsc-money.ts's ASSET_DECIMALS/SCALE
// convention exactly (HBD and credits both carry 3 decimals; PAR is 1:1 so
// credits inherit HBD's own granularity — prepay.go: "PAR performs NO division").

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
// Derivation — faithful ports of the pure logic in core/*.go.
// =====================================================================

/** market.go Phase(), the 4 real contract values only — UNKNOWN is assigned by the caller on read failure, never by this function. */
export function derivePhase(closedStored: boolean, paidUntilBlock: number, block: number): Exclude<MarketPhase, 'UNKNOWN'> {
  if (closedStored) return 'CLOSED';
  if (block <= paidUntilBlock) return 'ACTIVE';
  if (block < paidUntilBlock + GRACE_BLOCKS) return 'OVERDUE';
  return 'FROZEN';
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
export function refundPayoutBaseUnits(reserveBaseUnits: number, creditsBaseUnits: number, supplyBaseUnits: number): number {
  const uncapped = mulDivFloor(reserveBaseUnits, creditsBaseUnits, supplyBaseUnits);
  return Math.min(uncapped, creditsBaseUnits * PAR_BASE_UNITS_PER_CREDIT);
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
export function contractRefundPriceBaseUnits(reserveBaseUnits: number, supplyBaseUnits: number): number {
  if (supplyBaseUnits <= 0) return 0;
  return refundPayoutBaseUnits(reserveBaseUnits, PAR_BASE_UNITS_PER_CREDIT, supplyBaseUnits);
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
export function floorRatioForDisplay(reserveBaseUnits: number, supplyBaseUnits: number): number {
  if (supplyBaseUnits <= 0) return 0;
  return Math.min(reserveBaseUnits / supplyBaseUnits, PAR_BASE_UNITS_PER_CREDIT);
}

/** ask.go creditsForAsk: ceil(face/rate). rate is HBD base units per credit; caller guarantees rate > 0. */
export function creditsForAskBaseUnits(faceBaseUnits: number, rateBaseUnitsPerCredit: number): number {
  return mulDivCeil(faceBaseUnits, 1, rateBaseUnitsPerCredit);
}

/** ask.go commissionOwedFor: floor(face * CommissionBps / 10000). */
export function commissionOwedForBaseUnits(faceBaseUnits: number): number {
  return mulBpsFloor(faceBaseUnits, COMMISSION_BPS);
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
export function deriveAskStatus(rawStatus: 'PENDING' | 'ANSWERED' | 'RECLAIMED', deadlineBlock: number, block: number): AskStatus {
  if (rawStatus === 'ANSWERED') return 'answered';
  if (rawStatus === 'RECLAIMED') return 'reclaimed';
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
export function askRateFromObservations(points: RawObservation[], block: number): AskRateEstimate {
  if (points.length < MIN_OBS_COUNT) return { rateBaseUnits: null, status: 'insufficient_observations' };

  const oldest = points[0].block;
  if (block < oldest) return { rateBaseUnits: null, status: 'unavailable' };

  const newest = points[points.length - 1].block;
  if (block > newest && block - newest > MAX_STALE_BLOCKS) return { rateBaseUnits: null, status: 'stale' };

  const windowBlocks = block - oldest;
  if (windowBlocks < MIN_OBS_BLOCKS) return { rateBaseUnits: null, status: 'insufficient_span' };

  let weighted = 0n;
  let totalW = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let w: number;
    if (i === points.length - 1) {
      if (block < p.block) return { rateBaseUnits: null, status: 'unavailable' };
      w = block - p.block;
    } else {
      const next = points[i + 1].block;
      if (next < p.block) return { rateBaseUnits: null, status: 'unavailable' };
      w = next - p.block;
    }
    if (w > MAX_OBS_WEIGHT_BLOCKS) w = MAX_OBS_WEIGHT_BLOCKS;
    if (w === 0) continue;
    totalW += w;
    weighted += BigInt(Math.trunc(p.rateBaseUnits)) * BigInt(w);
  }
  if (totalW < MIN_OBS_BLOCKS) return { rateBaseUnits: null, status: 'insufficient_span' };

  const twap = weighted / BigInt(totalW); // floor, favours the reserve (fewer credits per HBD of face means MORE credits spent — see ask.go creditsForAsk comment)

  const ref = medianRateBaseUnits(points);
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
  rateBaseUnits: number;
  /** True when AskRate's guards failed and this is the PAR fallback, not a live TWAP — mirrors ask.go's SettlementRate: `if rate, err := AskRate(...); err == nil { return rate }; return PAR` (ANY non-nil AskRate error, whatever its specific reason, takes the PAR branch). */
  usedPar: boolean;
}

/** ask.go SettlementRate, ported term for term: `estimate` is whatever askRateFromObservations (or an 'unavailable' stand-in for a decode failure) already computed. */
export function settlementRateBaseUnits(estimate: AskRateEstimate): SettlementRateResult {
  if (estimate.status === 'ok' && estimate.rateBaseUnits !== null && estimate.rateBaseUnits > 0) {
    return { rateBaseUnits: estimate.rateBaseUnits, usedPar: false };
  }
  return { rateBaseUnits: PAR_BASE_UNITS_PER_CREDIT, usedPar: true };
}
