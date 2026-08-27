/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * ROUND-TRIP CONSERVATION — buy N at supply S, immediately sell the same N
 * back, and prove the loss is EXACTLY the stated fees with no unexplained
 * residual.
 *
 * apps/blog has no unit test runner wired (see curve.selftest.ts's own header,
 * and lib/vsc/payload-contract.selftest.ts's for the full audit of why — no
 * jest/vitest anywhere, packages/ui and packages/transaction are separate
 * packages that cannot import apps/blog code). This follows the established
 * fallback exactly: a plain script, the same `check()` shape, run by hand.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/curve.roundtrip.selftest.ts
 *
 * WHY THIS FILE EXISTS. Every existing check in this feature prices ONE
 * direction. Nothing had ever asserted that a buy and the matching sell agree,
 * which is the single property a holder's money depends on: if the two legs
 * disagree by even one base unit in the reserve's favour, the difference is
 * ownerless dust of exactly the class curve.go's own header calls "THE bug
 * class, not hygiene" ("every unallocated pot, however small, is a pot someone
 * can buy into pro-rata at wind-down").
 *
 * ── THE DERIVATION (from the contract's own rounding rules, not a tolerance).
 *
 * Buy n at supply S (core/buy.go buyCompute, ported at
 * lib/contract-math.ts:386 quoteBuyBaseUnits):
 *
 *     C        = BuyCost(S,n) = Area(S+n) − Area(S)        exact integer area step (L1)
 *     feeBuy   = floor(C · TradeFeeBps / 10000) = floor(C/10)   tradefee.go, FLOOR
 *     totalDue = C + feeBuy                                 fee sits ON TOP of the curve leg
 *
 * Sell the same n back, now at supply S+n (core/sell.go sellCompute, ported at
 * lib/contract-math.ts:414 quoteSellBaseUnits):
 *
 *     p        = SellProceeds(S+n, n) = Area(S+n) − Area(S) = C   the SAME area step (L5)
 *     tax      = ceil(p · tau / 10000)                      exittax.go, CEIL
 *     feeSell  = floor(p · TradeFeeBps / 10000) = floor(C/10)     tradefee.go, FLOOR
 *     net      = p − tax − feeSell                          fee comes OUT OF the payout
 *
 * So the round-trip loss is
 *
 *     loss = totalDue − net = 2·floor(C/10) + ceil(C·tau/10000)
 *
 * and NOT floor(2C/10) + anything: the two trade-fee floors are taken
 * separately, one per leg, and they do not merge. This script asserts that
 * exact integer, and separately proves the non-merging is real (section 4) so a
 * future "simplification" to a single floor cannot pass.
 *
 * The curve leg itself contributes EXACTLY ZERO to the loss — that is
 * curve.go's L5, and section 1 asserts it as an equality across the sweep.
 *
 * ── HOW THIS IS KEPT FROM BEING A TAUTOLOGY. The expected C is recomputed here
 * from the params.go constants through a LOCAL BigInt Area written straight
 * from curve.go's published formula, never by calling the function under test.
 * If contract-math's area, its rounding site, or either fee direction moves,
 * the two disagree and this file fails. Verified by deliberate perturbation —
 * see the report accompanying this file for the mutation runs.
 */

import {
  BASE_PRICE_BASE_UNITS,
  CURVE_LIN_NUM,
  CURVE_QUAD_NUM,
  CURVE_DENOM,
  TRADE_FEE_BPS,
  MAX_EXIT_TAX_BPS,
  EXIT_TAX_DECAY_BLOCKS,
  areaBaseUnits,
  buyCostBaseUnits,
  sellProceedsBaseUnits,
  exitTaxBpsAt,
  quoteBuyBaseUnits,
  quoteSellBaseUnits
} from '../lib/contract-math';

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

// ── The INDEPENDENT reference. Written from core/curve.go's published formula
// (area(S) = S·BasePrice + floor((lin·T(S) + quad·P(S))/den)) using only the
// exported protocol constants — deliberately not by calling areaBaseUnits, so
// the two are separate witnesses to the same number.
const REF_BASE = BigInt(BASE_PRICE_BASE_UNITS);
const REF_LIN = BigInt(CURVE_LIN_NUM);
const REF_QUAD = BigInt(CURVE_QUAD_NUM);
const REF_DEN = BigInt(CURVE_DENOM);

function refArea(s: bigint): bigint {
  if (s <= 0n) return 0n;
  const tri = (s * (s + 1n)) / 2n; // T(S) — exact, S(S+1) is always even
  const pyr = (s * (s + 1n) * (2n * s + 1n)) / 6n; // P(S) — exact, always divisible by 6
  return REF_BASE * s + (REF_LIN * tri + REF_QUAD * pyr) / REF_DEN; // THE one floor
}

/** The expected round-trip loss, derived from the contract's rounding rules alone. */
function refExpectedLoss(costBaseUnits: bigint, taxBps: number): bigint {
  const feePerLeg = (costBaseUnits * BigInt(TRADE_FEE_BPS)) / 10_000n; // floor, ONCE PER LEG
  const tax = taxBps <= 0 ? 0n : (costBaseUnits * BigInt(taxBps) + 9_999n) / 10_000n; // ceil
  return 2n * feePerLeg + tax;
}

// The sweep. Supplies span an empty market through the practical ~283k ceiling
// contract-math.ts:234 names; counts span a single token through a whole small
// market; holds span the worst case (0 blocks, full 20%) through past the point
// the tax has decayed to nothing (exittax.go ExitTaxDecayBlocks).
const SUPPLIES = [0, 1, 2, 3, 7, 31, 40, 50, 100, 999, 1000, 3000, 10_000, 50_000, 99_799, 283_000];
const COUNTS = [1, 2, 3, 7, 10, 100, 1000, 10_000];
const HOLDS = [
  0, // worst case: the full MaxExitTaxBps
  1,
  14_400, // half a day
  EXIT_TAX_DECAY_BLOCKS / 2, // half decayed
  EXIT_TAX_DECAY_BLOCKS - 1, // 1 bps — the last taxed block
  EXIT_TAX_DECAY_BLOCKS, // exactly decayed to zero
  EXIT_TAX_DECAY_BLOCKS + 1,
  5_000_000 // long past
];

// ── 1. THE CURVE LEG ROUND-TRIPS TO EXACTLY ZERO (curve.go L5).
// CATCHES: any drift between the buy and sell area steps — a per-leg rounding
// scheme, an off-by-one in the S−k argument, or a quadratic/linear leg rounded
// independently (which curve.go's own recheck measured as breaking L5 in 65%
// of cases).
{
  const mismatches: string[] = [];
  let cases = 0;
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      cases += 1;
      const cost = buyCostBaseUnits(S, N);
      const proceeds = sellProceedsBaseUnits(S + N, N);
      const ref = refArea(BigInt(S + N)) - refArea(BigInt(S));
      if (proceeds !== cost || BigInt(cost) !== ref) {
        mismatches.push(`S=${S} N=${N} buyCost=${cost} sellProceeds=${proceeds} reference=${ref}`);
      }
    }
  }
  check(
    `L5: sellProceeds(S+N,N) === buyCost(S,N) === the independent Area step, ${cases} cases`,
    mismatches.length === 0,
    mismatches.slice(0, 5).join('\n      ')
  );
}

// ── 2. THE RESERVE MOVES EXACTLY ALONG THE AREA FUNCTION (curve.go C-9,
// R === Area(S) with EQUALITY). A buy adds exactly the step it now has to back;
// the matching sell removes exactly the step it no longer backs, returning the
// reserve to the byte it started on.
// CATCHES: any scheme that books the fee into the reserve (which would fake
// over-collateralisation and pay it back out at wind-down — curve.go C-19
// forbids exactly that), or any per-trade rounding remainder left behind.
{
  const mismatches: string[] = [];
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      const before = areaBaseUnits(S);
      const afterBuy = before + buyCostBaseUnits(S, N);
      const afterSell = afterBuy - (sellProceedsBaseUnits(S + N, N) ?? NaN);
      if (afterBuy !== areaBaseUnits(S + N) || afterSell !== before) {
        mismatches.push(`S=${S} N=${N} before=${before} afterBuy=${afterBuy} Area(S+N)=${areaBaseUnits(S + N)} afterSell=${afterSell}`);
      }
    }
  }
  check(
    'reserve returns to the exact byte it started on: Area(S) +cost −proceeds === Area(S)',
    mismatches.length === 0,
    mismatches.slice(0, 5).join('\n      ')
  );
}

// ── 3. THE ROUND-TRIP LOSS IS EXACTLY THE STATED FEES — the whole point of
// this file. loss === 2·floor(C/10) + ceil(C·tau/1e4), asserted as an integer
// equality against the independent derivation, with NO tolerance anywhere.
// CATCHES: a fee direction flipped (floor -> ceil) on either leg; the exit tax
// floored instead of ceiled; the tax applied to the post-fee remainder instead
// of the gross; the buy fee folded into the reserve; or any residual the fee
// schedule does not account for.
{
  const mismatches: string[] = [];
  let cases = 0;
  let worstLossBps = 0;
  let worstExcess = 0n;
  const overSchedule: string[] = [];
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      for (const h of HOLDS) {
        cases += 1;
        const cost = BigInt(buyCostBaseUnits(S, N));
        const buy = quoteBuyBaseUnits(S, N);
        const sell = quoteSellBaseUnits(S + N, N, h);
        if (sell === null) {
          mismatches.push(`S=${S} N=${N} h=${h}: sell quote was null selling back exactly what was just bought`);
          continue;
        }
        const actualLoss = BigInt(buy.totalDueBaseUnits) - BigInt(sell.netBaseUnits);
        const expectedLoss = refExpectedLoss(cost, exitTaxBpsAt(h));
        if (actualLoss !== expectedLoss) {
          mismatches.push(
            `S=${S} N=${N} h=${h} C=${cost} taxBps=${exitTaxBpsAt(h)} expected=${expectedLoss} actual=${actualLoss} residual=${actualLoss - expectedLoss}`
          );
        }
        // The stated schedule, floored throughout: 10% + 10% + tau. The real
        // loss may exceed it by AT MOST the exit tax's own single ceil unit
        // (exittax.go: "the only ceil residue left is <= 1 base unit of
        // over-charge per sell, seller-adverse"). Anything above that is an
        // unexplained residual.
        const scheduleFloored =
          2n * ((cost * BigInt(TRADE_FEE_BPS)) / 10_000n) + (cost * BigInt(exitTaxBpsAt(h))) / 10_000n;
        const excess = actualLoss - scheduleFloored;
        if (excess < 0n || excess > 1n) {
          overSchedule.push(`S=${S} N=${N} h=${h} C=${cost} loss=${actualLoss} flooredSchedule=${scheduleFloored} excess=${excess}`);
        }
        if (excess > worstExcess) worstExcess = excess;
        // The same bound stated as a closed-form inequality on integers:
        // loss <= 0.4·C + 1, i.e. 10000·loss <= (2·TradeFeeBps + tau)·C + 10000.
        if (10_000n * actualLoss > BigInt(2 * TRADE_FEE_BPS + exitTaxBpsAt(h)) * cost + 10_000n) {
          overSchedule.push(`S=${S} N=${N} h=${h}: loss ${actualLoss} exceeds 0.4·C+1 on C=${cost}`);
        }
        const bps = cost > 0n ? Number((actualLoss * 10_000n) / cost) : 0;
        if (bps > worstLossBps) worstLossBps = bps;
      }
    }
  }
  check(
    `round-trip loss === 2·floor(C/10) + ceil(C·tau/1e4) EXACTLY, ${cases} cases, zero residual`,
    mismatches.length === 0,
    mismatches.slice(0, 6).join('\n      ')
  );
  // The loss never exceeds the stated schedule by more than the ONE base unit
  // the exit tax's ceil is allowed to add. Note this is why the worst observed
  // ratio is 4005 bps and not 4000: at S=3, N=1, h=0 the cost is 1031, the
  // floored schedule is 2·103 + 206 = 412 and the ceil makes it 413 — one base
  // unit ($0.001), exactly as exittax.go documents. That is NOT a residual.
  check(
    `no loss exceeds the stated schedule by more than the exit tax's 1-unit ceil (worst excess ${worstExcess}, worst ratio ${worstLossBps} bps)`,
    overSchedule.length === 0,
    overSchedule.slice(0, 6).join('\n      ')
  );
}

// ── 4. THE TWO TRADE-FEE FLOORS DO NOT CANCEL, AND THAT IS LOAD-BEARING.
// A reader (or a refactor) may assume the buy fee and the sell fee merge into
// one floor(2C/10). They do not: each leg floors on its own, and the pair
// exceeds the merged figure by one base unit whenever C mod 10 >= 5.
// CATCHES: exactly that "simplification". Without this check the section-3
// identity could be rewritten with a single floor and still pass on the ~60%
// of inputs where the two happen to agree.
{
  const disagreeing: string[] = [];
  let compared = 0;
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      const C = buyCostBaseUnits(S, N);
      compared += 1;
      if (2 * Math.floor((C * TRADE_FEE_BPS) / 10_000) !== Math.floor((2 * C * TRADE_FEE_BPS) / 10_000)) {
        disagreeing.push(`S=${S} N=${N} C=${C}`);
      }
    }
  }
  check(
    'two per-leg floors are NOT one merged floor — the difference is real, not theoretical',
    disagreeing.length > 0,
    `they agreed in all ${compared} swept cases, which would make the per-leg rule untested`
  );
  // The canonical single case, spelled out so the arithmetic is auditable by eye.
  // S=0, N=1: C = 1007. floor(1007/10) = 100 per leg -> 200. floor(2014/10) = 201.
  check(
    'S=0 N=1: per-leg fees are 100+100=200 where a merged floor would be 201',
    2 * Math.floor(1007 / 10) === 200 && Math.floor(2014 / 10) === 201
  );
}

// ── 5. THE EXIT TAX AT EVERY HOLD BOUNDARY (exittax.go ExitTaxBpsAt).
// CATCHES: an off-by-one at the decay edge (a >= written as >), a floor where
// the contract ceils, or a schedule that does not reach exactly 0 and exactly
// MaxExitTaxBps at its endpoints.
{
  check('h=0 is exactly MaxExitTaxBps (2000)', exitTaxBpsAt(0) === MAX_EXIT_TAX_BPS, `got ${exitTaxBpsAt(0)}`);
  check('h = decay−1 is exactly 1 bps, still taxed', exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS - 1) === 1, `got ${exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS - 1)}`);
  check('h = decay is exactly 0 — the boundary is inclusive', exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS) === 0, `got ${exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS)}`);
  check('h past decay stays 0', exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS * 10) === 0);
  check('the rate is monotone non-increasing across the whole decay window', (() => {
    let prev = MAX_EXIT_TAX_BPS + 1;
    for (let h = 0; h <= EXIT_TAX_DECAY_BLOCKS + 5000; h += 997) {
      const bps = exitTaxBpsAt(h);
      if (bps > prev) return false;
      prev = bps;
    }
    return true;
  })());

  // With the tax fully decayed the loss is the two trade-fee floors and NOTHING
  // else. This is the cleanest possible statement of "no unexplained residual".
  const taxFreeMismatch: string[] = [];
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      const C = buyCostBaseUnits(S, N);
      const buy = quoteBuyBaseUnits(S, N);
      const sell = quoteSellBaseUnits(S + N, N, EXIT_TAX_DECAY_BLOCKS)!;
      const loss = buy.totalDueBaseUnits - sell.netBaseUnits;
      const expected = 2 * Math.floor((C * TRADE_FEE_BPS) / 10_000);
      if (loss !== expected || sell.taxBaseUnits !== 0) {
        taxFreeMismatch.push(`S=${S} N=${N} C=${C} loss=${loss} expected=${expected} tax=${sell.taxBaseUnits}`);
      }
    }
  }
  check(
    'a fully-matured round trip loses EXACTLY 2·floor(C/10) and nothing else',
    taxFreeMismatch.length === 0,
    taxFreeMismatch.slice(0, 5).join('\n      ')
  );
}

// ── 6. THE EDGES THE SWEEP CANNOT REACH BY ITSELF.
{
  // S = 0, N = 1 — the very first token of a brand-new market, worst-case tax.
  // Every figure below is written out so a reviewer can check the arithmetic
  // without running anything: C = Area(1) = 1000 + floor(63021/8000) = 1007.
  const firstBuy = quoteBuyBaseUnits(0, 1);
  const firstSell = quoteSellBaseUnits(1, 1, 0)!;
  check('S=0 N=1: cost is exactly 1007 base units', firstBuy.costBaseUnits === 1007, `got ${firstBuy.costBaseUnits}`);
  check('S=0 N=1: buy fee is floor(1007/10) = 100', firstBuy.feeBaseUnits === 100, `got ${firstBuy.feeBaseUnits}`);
  check('S=0 N=1: totalDue is 1107', firstBuy.totalDueBaseUnits === 1107, `got ${firstBuy.totalDueBaseUnits}`);
  check('S=0 N=1: sell gross is the same 1007 (L5)', firstSell.grossBaseUnits === 1007, `got ${firstSell.grossBaseUnits}`);
  check('S=0 N=1 h=0: tax is ceil(1007·2000/10000) = 202', firstSell.taxBaseUnits === 202, `got ${firstSell.taxBaseUnits}`);
  check('S=0 N=1: sell fee is floor(1007/10) = 100', firstSell.feeBaseUnits === 100, `got ${firstSell.feeBaseUnits}`);
  check('S=0 N=1: net is 1007 − 202 − 100 = 705', firstSell.netBaseUnits === 705, `got ${firstSell.netBaseUnits}`);
  check('S=0 N=1: round-trip loss is exactly 402 base units', firstBuy.totalDueBaseUnits - firstSell.netBaseUnits === 402);

  // S = 1, N = 1.
  const s1 = quoteBuyBaseUnits(1, 1);
  check('S=1 N=1: cost is exactly 1016 base units', s1.costBaseUnits === 1016, `got ${s1.costBaseUnits}`);

  // N equal to the WHOLE supply — buy the market out from empty, then sell all
  // of it back. The sell takes supply to exactly 0, the deepest slice the curve
  // can price.
  const wholeMarketMismatch: string[] = [];
  for (const N of [1, 2, 50, 1000, 99_799, 283_000]) {
    const buy = quoteBuyBaseUnits(0, N);
    const sell = quoteSellBaseUnits(N, N, 0)!;
    const C = BigInt(buy.costBaseUnits);
    const loss = BigInt(buy.totalDueBaseUnits) - BigInt(sell.netBaseUnits);
    const expected = refExpectedLoss(C, MAX_EXIT_TAX_BPS);
    if (loss !== expected || BigInt(sell.grossBaseUnits) !== refArea(BigInt(N))) {
      wholeMarketMismatch.push(`N=${N} gross=${sell.grossBaseUnits} refArea=${refArea(BigInt(N))} loss=${loss} expected=${expected}`);
    }
  }
  check(
    'N === the whole supply: buying a market out and selling all of it back holds the same identity',
    wholeMarketMismatch.length === 0,
    wholeMarketMismatch.join('\n      ')
  );

  // Selling MORE than exists is refused, never guessed (curve.go
  // curveSellProceedsIn returns a typed error; the port returns null).
  check('selling more than supply returns null, never a number', sellProceedsBaseUnits(10, 11) === null);
  check('quoteSell beyond supply returns null, never a zero-valued quote', quoteSellBaseUnits(10, 11, 0) === null);
  check('selling exactly the whole supply is allowed', sellProceedsBaseUnits(10, 10) === areaBaseUnits(10));

  // Zero legs.
  check('buying 0 tokens costs 0', buyCostBaseUnits(50, 0) === 0);
  check('selling 0 tokens returns 0, not null', sellProceedsBaseUnits(50, 0) === 0);
  check('Area(0) is 0 — an empty market backs nothing', areaBaseUnits(0) === 0);
}

// ── 7. A NEGATIVE CONTROL. If the assertion in section 3 were satisfied by a
// WRONG rounding rule too, it would not be testing anything. These are the two
// rules the contract explicitly rejected (exittax.go RULING F: ceil never
// floor; tradefee.go: floor per leg) — the real figure must DISAGREE with both
// somewhere in the sweep, or section 3 is not pinning the rounding down.
{
  let taxFloorDiffers = false;
  let feeCeilDiffers = false;
  for (const S of SUPPLIES) {
    for (const N of COUNTS) {
      const C = buyCostBaseUnits(S, N);
      const real = quoteSellBaseUnits(S + N, N, 0)!;
      if (real.taxBaseUnits !== Math.floor((C * MAX_EXIT_TAX_BPS) / 10_000)) taxFloorDiffers = true;
      if (real.feeBaseUnits !== Math.ceil((C * TRADE_FEE_BPS) / 10_000)) feeCeilDiffers = true;
    }
  }
  check('the exit tax is provably CEIL — a floored tax gives a different number in the sweep', taxFloorDiffers);
  check('the trade fee is provably FLOOR — a ceiled fee gives a different number in the sweep', feeCeilDiffers);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
