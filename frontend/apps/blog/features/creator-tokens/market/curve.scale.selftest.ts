/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE CURVE AT SCALE — the path no token on the platform has ever taken.
 *
 * Nothing live is above supply 50, so every figure above that first runs in
 * production the day a creator succeeds. This file exercises the whole range up
 * to and including the protocol's own MaxCap.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/curve.scale.selftest.ts
 *
 * Same runner and same `check()` shape as curve.selftest.ts — apps/blog has no
 * unit test framework wired and this deliberately does not introduce one.
 *
 * ── THE QUESTION THIS FILE ANSWERS. A $1,000,000,000 quote was observed
 * returning ~99,749 tokens at a post-buy price of ~$26,932/token — roughly 32x
 * what a straight line drawn through S=31..50 predicts. Is the curve genuinely
 * that non-linear, or does the quote maths degrade at large N?
 *
 * IT IS THE CURVE, and the source says so before any number is run.
 * core/curve.go prices the i-th token as
 *
 *     price(i) = BasePrice + (CurveLinNum·i + CurveQuadNum·i²) / CurveDenom
 *              = 1000 + (63000·i + 21·i²) / 8000
 *
 * The QUADRATIC term is not a correction, it is the dominant term above a
 * supply this test pins exactly: the quadratic leg overtakes the linear leg
 * when 21·i² > 63000·i, i.e. at i > CurveLinNum/CurveQuadNum = 3000. Below
 * 3000 the curve looks near-linear, which is exactly the region S=31..50 sits
 * in — so a line fitted there and extended to ~100,000 is extrapolating from
 * the one stretch where the term that eventually dominates is still invisible.
 * At S = 99,799 the quadratic leg is 21·S/63000 = 33.27x the linear leg, and
 * that ratio IS the observed multiple. The maths is not degrading; a straight
 * line through the near-linear stretch is simply the wrong model.
 *
 * Section 2 reproduces the observation to the base unit; sections 3-8 then test
 * the properties a large market actually depends on.
 */

import {
  BASE_PRICE_BASE_UNITS,
  CURVE_LIN_NUM,
  CURVE_QUAD_NUM,
  CURVE_DENOM,
  MAX_CAP_CREDITS_BASE_UNITS,
  MIN_CAP_CREDITS_BASE_UNITS,
  areaBaseUnits,
  buyCostBaseUnits,
  sellProceedsBaseUnits,
  spotRateBaseUnits,
  displayPricePerTokenBaseUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  tokensAffordableForBudget,
  refundPayoutBaseUnits
} from '../lib/contract-math';
import { buyQuote } from './curve';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

// The independent BigInt reference, written from core/curve.go's published
// formulas using the exported protocol constants only — never by calling the
// functions under test, so the two are separate witnesses.
const REF_BASE = BigInt(BASE_PRICE_BASE_UNITS);
const REF_LIN = BigInt(CURVE_LIN_NUM);
const REF_QUAD = BigInt(CURVE_QUAD_NUM);
const REF_DEN = BigInt(CURVE_DENOM);

function refArea(s: bigint): bigint {
  if (s <= 0n) return 0n;
  const tri = (s * (s + 1n)) / 2n;
  const pyr = (s * (s + 1n) * (2n * s + 1n)) / 6n;
  return REF_BASE * s + (REF_LIN * tri + REF_QUAD * pyr) / REF_DEN;
}

function refSpot(s: bigint): bigint {
  if (s <= 0n) return 0n;
  return REF_BASE + (REF_LIN * s + REF_QUAD * s * s) / REF_DEN;
}

// ── 1. THE SHAPE OF THE CURVE, READ OFF THE CONSTANTS.
// CATCHES: any change to the curve parameters that silently alters where the
// quadratic takes over — the single fact that decides whether a high-supply
// price is "correct" or "a bug".
{
  const crossover = CURVE_LIN_NUM / CURVE_QUAD_NUM;
  check('the quadratic leg overtakes the linear leg at exactly S = 3000', crossover === 3000, `got ${crossover}`);
  check(
    'below the crossover the linear leg dominates (S=2999)',
    CURVE_QUAD_NUM * 2999 * 2999 < CURVE_LIN_NUM * 2999
  );
  check(
    'above the crossover the quadratic leg dominates (S=3001)',
    CURVE_QUAD_NUM * 3001 * 3001 > CURVE_LIN_NUM * 3001
  );
  // The observed multiple, as an exact integer statement rather than a
  // measurement: at S the quadratic/linear ratio is quad·S/lin = S/3000.
  const S = 99_799;
  check(
    'at S=99,799 the quadratic leg is between 33x and 34x the linear leg — this IS the observed ~32x',
    CURVE_QUAD_NUM * S >= 33 * CURVE_LIN_NUM && CURVE_QUAD_NUM * S < 34 * CURVE_LIN_NUM,
    `ratio = ${(CURVE_QUAD_NUM * S) / CURVE_LIN_NUM}`
  );
}

// ── 2. THE OBSERVATION, REPRODUCED TO THE BASE UNIT.
// CATCHES: a regression in the budget bisection or in the area maths at large
// N; also fixes the reported figures so a future change to any of them is
// visible rather than shrugged at.
{
  const budgetBaseUnits = 1_000_000_000 * 1000; // $1e9, at HBD's 3 decimals
  const n = tokensAffordableForBudget(0, budgetBaseUnits);
  check('a $1e9 budget on an empty market buys exactly 99,799 whole tokens', n === 99_799, `got ${n}`);

  const q = quoteBuyBaseUnits(0, n);
  check('its curve cost is exactly 909,064,484,028 base units', q.costBaseUnits === 909_064_484_028, `got ${q.costBaseUnits}`);
  check('its 10% fee is exactly 90,906,448,402 base units', q.feeBaseUnits === 90_906_448_402, `got ${q.feeBaseUnits}`);
  check('totalDue fits inside the budget, as the bisection promises', q.totalDueBaseUnits <= budgetBaseUnits, `${q.totalDueBaseUnits} vs ${budgetBaseUnits}`);
  check('one more token would NOT fit — the bisection lands on the true boundary', quoteBuyBaseUnits(0, n + 1).totalDueBaseUnits > budgetBaseUnits);

  const priceAfter = displayPricePerTokenBaseUnits(n);
  check(
    'the post-buy price is exactly 26,932,030 base units = $26,932.03/token — the observed figure',
    priceAfter === 26_932_030,
    `got ${priceAfter}`
  );
  check('the oracle spot at that supply is 26,931,498 base units', spotRateBaseUnits(n) === 26_931_498, `got ${spotRateBaseUnits(n)}`);

  // The straight line through the only region anyone has ever seen.
  const p31 = displayPricePerTokenBaseUnits(31);
  const p50 = displayPricePerTokenBaseUnits(50);
  const slope = (p50 - p31) / (50 - 31);
  const linearPrediction = p50 + slope * (n - 50);
  const multiple = priceAfter / linearPrediction;
  check(
    'a line through S=31..50 predicts ~$804.65 and is wrong by 33.4x — the reported ~32x is REAL',
    multiple > 33 && multiple < 34,
    `p31=${p31} p50=${p50} slope=${slope} prediction=${linearPrediction} actual=${priceAfter} multiple=${multiple.toFixed(4)}`
  );
  // And it is the curve, not the quote path: the production number equals the
  // independent reference exactly. If the quote maths were degrading at large
  // N, THIS is the check that would fail, and the one above would not.
  check(
    'the production price at S=99,799 equals the independent BigInt reference EXACTLY (no degradation)',
    BigInt(priceAfter) === refArea(BigInt(n) + 1n) - refArea(BigInt(n)) && BigInt(spotRateBaseUnits(n)) === refSpot(BigInt(n)),
    `production=${priceAfter} reference=${refArea(BigInt(n) + 1n) - refArea(BigInt(n))}`
  );
}

// ── 3. MONOTONICITY — cost in N, and price in S — across the whole range.
// CATCHES: a sign error or an overflow wrap in the quadratic leg, which would
// show up as a price that stops rising (or falls) somewhere above the region
// anyone has ever tested.
{
  let costBreak: string | null = null;
  for (const S of [0, 1, 50, 1000, 3000, 50_000, 283_000, 1_000_000]) {
    let prev = -1;
    for (let N = 1; N <= 300; N += 1) {
      const c = buyCostBaseUnits(S, N);
      if (c <= prev) { costBreak = `S=${S} N=${N}: cost ${c} did not exceed ${prev}`; break; }
      prev = c;
    }
    if (costBreak) break;
  }
  check('buyCost is STRICTLY increasing in N at every tested supply', costBreak === null, costBreak ?? undefined);

  let spotBreak: string | null = null;
  let prevSpot = -1;
  for (let S = 1; S <= 20_000; S += 1) {
    const r = spotRateBaseUnits(S);
    if (r < prevSpot) { spotBreak = `S=${S}: spot ${r} below ${prevSpot}`; break; }
    prevSpot = r;
  }
  // Sparse continuation to the protocol's own MaxCap — the dense loop above
  // covers the shape, this covers the magnitude.
  if (!spotBreak) {
    prevSpot = spotRateBaseUnits(20_000);
    for (let S = 25_000; S <= MAX_CAP_CREDITS_BASE_UNITS; S = Math.min(S * 2, S + 250_000_000)) {
      const r = spotRateBaseUnits(S);
      if (r <= prevSpot) { spotBreak = `S=${S}: spot ${r} did not exceed ${prevSpot}`; break; }
      prevSpot = r;
      if (S === MAX_CAP_CREDITS_BASE_UNITS) break;
    }
  }
  check('spot price is monotone non-decreasing from S=1 through MaxCap (1e9 tokens)', spotBreak === null, spotBreak ?? undefined);

  let supplyBreak: string | null = null;
  let prevCost = -1;
  for (const S of [0, 1, 10, 100, 1000, 10_000, 100_000, 283_000, 1_000_000]) {
    const c = buyCostBaseUnits(S, 100);
    if (c <= prevCost) { supplyBreak = `S=${S}: cost of 100 tokens ${c} did not exceed ${prevCost}`; break; }
    prevCost = c;
  }
  check('the cost of a FIXED token count rises with supply — the curve never gets cheaper', supplyBreak === null, supplyBreak ?? undefined);
}

// ── 4. BUY AND SELL AGREE AT THE SAME BOUNDARY, AT SCALE (curve.go L5).
// CATCHES: an area step that is exact for small slices but drifts for large
// ones — the precise failure mode "the quote maths degrades at large N" would
// take. Deliberately uses slices far larger than anything ever traded.
{
  const mismatches: string[] = [];
  const pairs: [number, number][] = [
    [0, 283_000],
    [50, 100_000],
    [1000, 99_799],
    [50_000, 50_000],
    [99_799, 1],
    [283_000, 10_000],
    [1_000_000, 100_000],
    [2_000_000, 1]
  ];
  for (const [S, N] of pairs) {
    const cost = buyCostBaseUnits(S, N);
    const proceeds = sellProceedsBaseUnits(S + N, N);
    const ref = refArea(BigInt(S) + BigInt(N)) - refArea(BigInt(S));
    if (proceeds !== cost || BigInt(cost) !== ref) {
      mismatches.push(`S=${S} N=${N} cost=${cost} proceeds=${proceeds} reference=${ref}`);
    }
    if (!Number.isSafeInteger(cost)) mismatches.push(`S=${S} N=${N}: cost ${cost} is not a safe integer`);
  }
  check('buyCost === sellProceeds === the reference area step on slices up to 283k tokens', mismatches.length === 0, mismatches.join('\n      '));

  // The full round trip still nets exactly the fee schedule at scale.
  const S = 99_799, N = 50_000;
  const C = buyCostBaseUnits(S, N);
  const loss = quoteBuyBaseUnits(S, N).totalDueBaseUnits - quoteSellBaseUnits(S + N, N, 0)!.netBaseUnits;
  const expected = 2 * Math.floor(C / 10) + Math.ceil((C * 2000) / 10_000);
  check(
    'a 50,000-token round trip at supply 99,799 loses exactly the stated fees',
    loss === expected,
    `C=${C} expected=${expected} actual=${loss}`
  );
}

// ── 5. NO PRECISION LOSS IN THE BIGINT PATHS OVER THE REACHABLE RANGE.
// contract-math.ts:234 warns that the pyramidal number P(S) is already near
// Number.MAX_SAFE_INTEGER at the ~283k practical ceiling, which is why the
// primitives are BigInt internally. They return `number`, so the conversion at
// the boundary is the thing to prove.
// CATCHES: a "simplification" of any curve primitive back to float arithmetic,
// which would misprice large markets silently rather than fail.
{
  const mismatches: string[] = [];
  const probes = [
    1, 2, 50, 999, 1000, 2999, 3000, 3001, 10_000, 99_799, 100_000,
    282_990, 282_999, 283_000, 283_001, 283_010, // around the documented practical ceiling
    500_000, 1_000_000, 2_000_000, 2_173_840
  ];
  for (const S of probes) {
    if (BigInt(areaBaseUnits(S)) !== refArea(BigInt(S))) mismatches.push(`Area(${S}) = ${areaBaseUnits(S)}, reference ${refArea(BigInt(S))}`);
    if (BigInt(spotRateBaseUnits(S)) !== refSpot(BigInt(S))) mismatches.push(`SpotRate(${S}) = ${spotRateBaseUnits(S)}, reference ${refSpot(BigInt(S))}`);
    if (!Number.isSafeInteger(areaBaseUnits(S))) mismatches.push(`Area(${S}) is not a safe integer`);
  }
  check(`Area and SpotRate are EXACT against the BigInt reference at ${probes.length} probes through S=2,173,840`, mismatches.length === 0, mismatches.slice(0, 6).join('\n      '));

  // WHY THE BIGINT PATH EXISTS, measured rather than taken on trust.
  //
  // ★ AND IT CORRECTS THE FILE THAT CLAIMS IT. contract-math.ts:234-236 states
  // that at S = 283,000 "the pyramidal number P(S) = S(S+1)(2S+1)/6 is ~1.5e16
  // — already past Number.MAX_SAFE_INTEGER (9.007e15) BEFORE the x21 multiply."
  // P(283,000) is 7,555,102,377,880,500 (7.56e15), which is BELOW
  // MAX_SAFE_INTEGER, not past it — the comment overstates P by about 2x. The
  // CONCLUSION is still right, for two reasons the comment does not give: the
  // raw product S(S+1)(2S+1) is 4.53e16 and blows the float boundary before the
  // /6, and P·21 is 1.59e17 and blows it after. BigInt is required either way.
  // Pinned here as numbers so the claim cannot drift again.
  const rawProduct = 283_000n * 283_001n * 566_001n;
  const pyr283k = rawProduct / 6n;
  check(
    'P(283,000) = 7,555,102,377,880,500 — BELOW MAX_SAFE_INTEGER, unlike the header comment\'s ~1.5e16',
    pyr283k === 7_555_102_377_880_500n && pyr283k < BigInt(Number.MAX_SAFE_INTEGER),
    `P = ${pyr283k}`
  );
  check(
    'but the raw S(S+1)(2S+1) product (4.53e16) and P·21 (1.59e17) BOTH exceed it — BigInt is required',
    rawProduct === 45_330_614_267_283_000n &&
      rawProduct > BigInt(Number.MAX_SAFE_INTEGER) &&
      pyr283k * 21n > BigInt(Number.MAX_SAFE_INTEGER),
    `raw=${rawProduct} P*21=${pyr283k * 21n}`
  );

  // The safe range must never SHRINK. Area(S) is exact for every S at or below
  // 2,173,840; above that the Number return can no longer hold it (see the
  // report accompanying this file for the exact threshold and its economic
  // reachability). This check guards the floor of that range, not the defect
  // above it.
  check(
    'Area stays exact right up to S = 2,173,840 — the last supply a JS number can hold',
    BigInt(areaBaseUnits(2_173_840)) === refArea(2_173_840n) && refArea(2_173_840n) <= BigInt(Number.MAX_SAFE_INTEGER),
    `Area = ${areaBaseUnits(2_173_840)}`
  );
  // buyCost is a DIFFERENCE of two areas, so it stays exact far longer than the
  // areas themselves. Single-token pricing is exact all the way to MaxCap.
  check(
    'buyCost(S,1) is exact at MaxCap−1 (1e9 tokens) — single-token pricing never degrades in range',
    BigInt(buyCostBaseUnits(999_999_999, 1)) === refArea(1_000_000_000n) - refArea(999_999_999n),
    `got ${buyCostBaseUnits(999_999_999, 1)}`
  );
}

// ── 6. THE CAP REFUSES, IT DOES NOT PARTIAL-FILL (core/buy.go ErrCap).
// buy.go rejects outright when supply+n > cap; the quote layer must therefore
// never hand the user a token count that would trip it.
// CATCHES: a quote that ignores the cap (which would show more tokens than a
// real buy could mint and push the refusal onto the execution path), and an
// off-by-one at the cap that either wastes the last token or overshoots it.
{
  const chainWouldReject = (supply: number, cap: number, n: number): boolean => supply + n > cap;
  const violations: string[] = [];
  for (const [supply, cap] of [[0, 1], [0, 50], [40, 50], [49, 50], [50, 50], [0, 283_000], [283_000, 283_000], [0, MAX_CAP_CREDITS_BASE_UNITS]] as [number, number][]) {
    for (const usd of [0.001, 1, 10, 100, 1_000_000, 1e9]) {
      const q = buyQuote(usd, { supply, cap, position: null });
      if (chainWouldReject(supply, cap, q.tokens)) {
        violations.push(`supply=${supply} cap=${cap} usd=${usd}: quoted ${q.tokens}, chain rejects (${supply}+${q.tokens} > ${cap})`);
      }
      if (q.tokens < 0) violations.push(`supply=${supply} cap=${cap} usd=${usd}: negative token count ${q.tokens}`);
    }
  }
  check('no quote ever trips buy.go ErrCap — supply + quoted <= cap, always', violations.length === 0, violations.slice(0, 5).join('\n      '));

  // Exactly ON the cap is ALLOWED — buy.go's gate is `newSupply > cap`, not
  // `>=`. A quote that stopped one short would strand the last token forever.
  const atCap = buyQuote(1e9, { supply: 40, cap: 50, position: null });
  check('an unlimited budget fills the market to exactly the cap, not one token short', atCap.tokens === 10, `got ${atCap.tokens}`);
  check('and the quote it hands back is the cost of exactly those 10 tokens', Math.round(atCap.totalUsd * 1000) === quoteBuyBaseUnits(40, 10).totalDueBaseUnits, `${atCap.totalUsd}`);
  check('a market already at its cap quotes 0 tokens, not a refusal-shaped negative', buyQuote(1e9, { supply: 50, cap: 50, position: null }).tokens === 0);
  check('a market at its cap still shows a real price, never $0.00', buyQuote(1e9, { supply: 50, cap: 50, position: null }).priceAfter === 1.408);

  // Where the gate LIVES, pinned deliberately: the ported quote primitive has
  // no cap parameter, so the cap is enforced entirely by the caller
  // (market/curve.ts buyQuote). A refactor that moves the gate must move this
  // check with it.
  check(
    'quoteBuyBaseUnits itself is cap-blind by design — the gate is the caller\'s',
    quoteBuyBaseUnits(50, 1_000_000).costBaseUnits > 0
  );
  check('MinCap/MaxCap are the protocol range a cap must sit in', MIN_CAP_CREDITS_BASE_UNITS === 1 && MAX_CAP_CREDITS_BASE_UNITS === 1_000_000_000);
}

// ── 7. THE RESERVE INVARIANT AT SCALE (curve.go C-9, R === Area(S)).
// CATCHES: any drift between what the curve charges and what the wind-down
// pays back — the equality the whole anti-dilution theorem rests on.
{
  const mismatches: string[] = [];
  for (const S of [1, 31, 40, 50, 100, 1000, 10_000, 99_799, 283_000, 1_000_000]) {
    const reserve = areaBaseUnits(S);
    // The EXACT invariant: the whole supply's pro-rata claim is the whole
    // reserve, to the base unit (refund.go refundPayout = floor(R·k/S)).
    if (refundPayoutBaseUnits(reserve, S, S) !== reserve) {
      mismatches.push(`S=${S}: refundPayout(R,S,S) = ${refundPayoutBaseUnits(reserve, S, S)}, reserve = ${reserve}`);
    }
    // And the reserve is exactly what a buy from zero would have paid in.
    if (reserve !== buyCostBaseUnits(0, S)) mismatches.push(`S=${S}: Area ${reserve} != buyCost(0,S) ${buyCostBaseUnits(0, S)}`);
  }
  check('the whole supply\'s pro-rata claim is EXACTLY the whole reserve at every scale', mismatches.length === 0, mismatches.join('\n      '));

  // THE PER-TOKEN FLOOR IS NOT AN EXACT DIVISOR OF THE RESERVE, and saying so
  // matters: floorPricePerToken is floor(R/S), so floor·S recovers the reserve
  // MINUS (R mod S), never the reserve itself. The residual is real money
  // (247,748 base units = $247.75 at S=283,000) and it belongs to nobody until
  // it is claimed pro-rata — which is why refundPayout floors ONCE against a
  // holder's real balance instead of multiplying a per-token price back out.
  const floorResiduals: string[] = [];
  for (const S of [31, 50, 1000, 99_799, 283_000]) {
    const reserve = areaBaseUnits(S);
    const floorPerToken = refundPayoutBaseUnits(reserve, 1, S);
    if (floorPerToken * S !== reserve - (reserve % S)) {
      floorResiduals.push(`S=${S}: floor·S = ${floorPerToken * S}, expected ${reserve - (reserve % S)}`);
    }
  }
  check(
    'floor(R/S)·S === R − (R mod S) exactly — the per-token floor UNDER-states the reserve, it does not equal it',
    floorResiduals.length === 0,
    floorResiduals.join('\n      ')
  );
  check(
    'and the residual is non-zero at real scale — S=283,000 leaves 247,748 base units unrecovered by floor·S',
    areaBaseUnits(283_000) % 283_000 === 247_748,
    `got ${areaBaseUnits(283_000) % 283_000}`
  );
}

// ── 8. NEGATIVE CONTROLS. Each of these would pass trivially under a
// degenerate curve, so they are asserted to FAIL under one — proving the checks
// above have something to bite on.
{
  // A purely linear curve (quad = 0) would put the price at S=99,799 at
  // 1000 + 63000·99799/8000 = 786,917 base units, not 26,932,030. The 34x gap
  // between the two is the whole of section 2's answer.
  const linearOnly = BASE_PRICE_BASE_UNITS + Math.floor((CURVE_LIN_NUM * 99_799) / CURVE_DENOM);
  check(
    'a quad=0 curve would price S=99,799 at 786,917 — 34x below the real 26,931,498',
    linearOnly === 786_917 && spotRateBaseUnits(99_799) / linearOnly > 30,
    `linearOnly=${linearOnly} real=${spotRateBaseUnits(99_799)}`
  );
  // Independent legs rounded separately is the exact refactor curve.go's own
  // recheck measured as breaking L5 in 65% of cases. It must produce a
  // DIFFERENT number here, or section 4's L5 check is not pinning the single
  // floor down.
  let legSplitDiffers = false;
  for (const S of [7, 31, 1000, 99_799]) {
    const s = BigInt(S);
    const tri = (s * (s + 1n)) / 2n;
    const pyr = (s * (s + 1n) * (2n * s + 1n)) / 6n;
    const splitLegs = REF_BASE * s + (REF_LIN * tri) / REF_DEN + (REF_QUAD * pyr) / REF_DEN;
    if (splitLegs !== refArea(s)) legSplitDiffers = true;
  }
  check('rounding the linear and quadratic legs separately gives a DIFFERENT area — the single floor is load-bearing', legSplitDiffers);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
