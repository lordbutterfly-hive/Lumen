/**
 * settle-spend-status.selftest.ts — the client port of core/settlement.go
 * settleSpend's four post-rate guards (H1, 2026-08-31).
 *
 * Run: cd apps/blog && npx tsx features/creator-tokens/market/settle-spend-status.selftest.ts
 *
 * WHAT THIS PROVES. That settleSpendStatus fires each refusal EXACTLY at the
 * boundary the contract's own formula sets — lo = ceil(rate/2), hi =
 * area(S)*MaxServiceFaceAreaBps/10000 — and reproduces settlement.go's SET-3
 * skip (a 1-credit spend is never spend-capped). It does NOT prove agreement
 * with a running contract; that is the twin/lifecycle run. A green here with a
 * red lifecycle is a wrong port (the H17 lesson: hand-mirrored logic drifts).
 *
 * Section 0 is the degeneracy check: the function must DISCRIMINATE (return all
 * five of its outcomes over the grid), or the boundary assertions below could
 * pass on a constant.
 */
import {
  MAX_SERVICE_FACE_AREA_BPS,
  MAX_SPEND_SUPPLY_BPS,
  areaBaseUnitsBig,
  settleSpendStatus
} from '../lib/contract-math';
import type { QuoteOracleStatus } from '../types';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`ok    ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

// The contract formula, restated here INDEPENDENTLY so the test is not the
// implementation checking itself: lo/hi computed from first principles.
function lo(rate: number): bigint { return BigInt(Math.ceil(rate / 2)); }
function hi(supply: number): bigint { return (areaBaseUnitsBig(supply) * BigInt(MAX_SERVICE_FACE_AREA_BPS)) / 10000n; }
// credits = ceil(tokenLeg / rate), same as creditsForAsk.
function credits(leg: number, rate: number): number { return Math.ceil(leg / rate); }

// ---- 0. degeneracy ----
{
  const before = failures.length;
  check('instrument: a false condition fails', false);
  const caught = failures.length === before + 1; failures.pop();
  check('instrument detects false', caught);
  const seen = new Set<QuoteOracleStatus>();
  for (const rate of [2, 100, 5000]) for (const supply of [1, 50, 5000]) for (const leg of [1, 100, 100000, 1_000_000_000]) {
    seen.add(settleSpendStatus(leg, rate, supply, credits(leg, rate)));
  }
  check('discriminates: produces ok, market_too_small, price_below_floor, price_above_ceiling, spend_cap over the grid',
    ['ok', 'market_too_small', 'price_below_floor', 'price_above_ceiling', 'spend_cap'].every((s) => seen.has(s as QuoteOracleStatus)),
    `saw: ${[...seen].join(', ')}`);
}

// ---- 1. market_too_small: whenever the floor rises above the ceiling ----
{
  // Depends on rate AND supply, not on S alone: lo = ceil(rate/2) must exceed
  // hi = area(S)/2. At S=1 (area 1006, hi 503) a rate above ~1006 does it.
  const supply = 1, rate = 5000; // lo = 2500 > hi = 503
  check('floor above ceiling -> market_too_small (any face)',
    lo(rate) > hi(supply) && settleSpendStatus(600, rate, supply, credits(600, rate)) === 'market_too_small',
    `lo=${lo(rate)} hi=${hi(supply)}`);
  // And a market where the floor sits BELOW the ceiling is NOT too small.
  check('floor below ceiling -> not market_too_small', lo(1000) <= hi(1) && settleSpendStatus(503, 1000, 1, credits(503, 1000)) !== 'market_too_small',
    `lo=${lo(1000)} hi=${hi(1)}`);
}

// ---- 2. minimum-price floor: leg < ceil(rate/2) ----
{
  const rate = 1000, supply = 5000; // hi is large here, so the floor is what binds
  const floor = Number(lo(rate)); // 500
  check(`floor=${floor}: leg one below refuses price_below_floor`, settleSpendStatus(floor - 1, rate, supply, credits(floor - 1, rate)) === 'price_below_floor');
  check(`floor=${floor}: leg exactly at floor is admitted (not below)`, settleSpendStatus(floor, rate, supply, credits(floor, rate)) !== 'price_below_floor');
  // odd rate -> ceil rounds up
  check('odd rate 999: floor is ceil(999/2)=500, leg 499 below, 500 ok', lo(999) === 500n && settleSpendStatus(499, 999, supply, credits(499, 999)) === 'price_below_floor' && settleSpendStatus(500, 999, supply, credits(500, 999)) !== 'price_below_floor');
}

// ---- 3. depth ceiling: leg > area(S)/2 ----
{
  const rate = 2, supply = 5000; // tiny rate so the floor never binds; ceiling is the test
  const ceil = hi(supply);
  check(`ceiling=${ceil}: leg one above refuses price_above_ceiling`, settleSpendStatus(Number(ceil) + 1, rate, supply, credits(Number(ceil) + 1, rate)) === 'price_above_ceiling');
  check(`ceiling=${ceil}: leg exactly at ceiling is admitted`, settleSpendStatus(Number(ceil), rate, supply, credits(Number(ceil), rate)) !== 'price_above_ceiling');
}

// ---- 4. spend cap: credits>1 && credits*10000 > supply*MaxSpendSupplyBps ----
{
  // SET-3: a market with 1..19 tokens can still sell a 1-credit spend.
  for (const supply of [1, 5, 19]) {
    const rate = 1000; const leg = Number(lo(rate)); // exactly one token's worth -> credits 1
    const st = settleSpendStatus(leg, rate, supply, credits(leg, rate));
    check(`S=${supply}: a 1-credit spend is NOT spend-capped (SET-3), got ${st}`, credits(leg, rate) === 1 && st !== 'spend_cap');
  }
  // credits>1 boundary: supply*500/10000 = supply/20 credits allowed.
  const supply = 400; const rate = 100;
  // allowed credits = floor(supply*500/10000) = 20. leg for exactly 20 credits = 20*rate.
  const legAt20 = 20 * rate;
  check('S=400, exactly 20 credits: at the cap, admitted', credits(legAt20, rate) === 20 && settleSpendStatus(legAt20, rate, supply, 20) !== 'spend_cap');
  check('S=400, 21 credits: over the cap, spend_cap', settleSpendStatus(21 * rate, rate, supply, 21) === 'spend_cap',
    `21*10000=${21 * 10000} vs 400*${MAX_SPEND_SUPPLY_BPS}=${400 * MAX_SPEND_SUPPLY_BPS}`);
}

// ---- 5. a healthy mid-market price is 'ok' ----
{
  const rate = 1000, supply = 1000, leg = 5000; // above floor 500, below ceiling area(1000)/2 (large), credits 5 within cap
  check('healthy market, in-window price -> ok', settleSpendStatus(leg, rate, supply, credits(leg, rate)) === 'ok');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
