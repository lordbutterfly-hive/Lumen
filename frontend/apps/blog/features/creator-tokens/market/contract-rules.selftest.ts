/**
 * contract-rules.selftest.ts — the client half of the A5 lockstep, checked
 * against the contract's own semantics under BOTH rule sets.
 *
 * Plain assertions, no test runner (this repo has none). Run with:
 *   cd apps/blog && npx tsx features/creator-tokens/market/contract-rules.selftest.ts
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the pure functions say what
 * market/contract-rules.ts's header says the contract does, that the v1 column
 * is the pre-A5 client formula unchanged, that the health vocabulary and
 * the reader-facing vocabulary is consistent, and that the reserve comparison is
 * exact where it matters. It does NOT prove agreement with the Go core: that
 * is the phase-ladder twin (Go dumps the grid, the compiled client is run over
 * it; findings/59-P25-seam-family.md), which must be re-run whenever either
 * side changes. A green run here with a red twin is a wrong client.
 *
 * Section 0 is the degeneracy check: the assertion helper detects a false
 * condition, and rulesForCode discriminates its inputs, so a constant function
 * could not pass the sections below by accident.
 */
import { areaBaseUnitsBig } from '../lib/contract-math';
import type { ContractRules, MarketPhase } from '../types';
import {
  V1_CODE_CID,
  V2_CODE_CIDS,
  V2_FAST_TWIN_CODE_CID,
  closesIfDrainedUnder,
  reserveVersusCurve,
  rulesForCode,
  windingDownUnder
} from './contract-rules';
import { buyWordFor, healthWordFor, marketHealthOf, windingDownOf } from './market-health';

let passed = 0;
const failures: string[] = [];
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`ok    ${name}${detail ? `\n        ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ---- 0. the instrument ----
{
  const before = failures.length;
  check('instrument: a false condition is recorded as a failure', false);
  const caught = failures.length === before + 1;
  failures.pop();
  check('instrument: check() detects false', caught);
  const v2 = [...V2_CODE_CIDS][0];
  check('rulesForCode discriminates: v1 cid -> v1, v2 cid -> v2, null/empty/garbage -> v1',
    rulesForCode(V1_CODE_CID) === 'v1' && rulesForCode(v2) === 'v2' && rulesForCode(null) === 'v1' && rulesForCode('') === 'v1' && rulesForCode('bafy-not-a-known-build') === 'v1' && rulesForCode(undefined) === 'v1');
  check('V2_CODE_CIDS never contains the v1 bytecode', !V2_CODE_CIDS.has(V1_CODE_CID));
  check('the Stage D fast twin (same v2 source, short periods) maps to v2, and is a distinct CID from v2 proper',
    rulesForCode(V2_FAST_TWIN_CODE_CID) === 'v2' && V2_CODE_CIDS.has(V2_FAST_TWIN_CODE_CID) && v2 !== V2_FAST_TWIN_CODE_CID && V2_CODE_CIDS.size === 4);
  // ★ THE SIZE IS PINNED, AND IT MOVES ONLY WITH A REAL BUILD. 4 since
  // 2026-09-12: the commission/subscription update's CID was added here BEFORE
  // the contract was deployed, which is the order this module's own header
  // demands (frontend first — an unlisted CID pins every client to v1 rules
  // silently and forever).
  check('every listed v2 CID is a CIDv1 raw/base32 string of the same shape as the live v1 one',
    [...V2_CODE_CIDS].every((c) => /^bafkrei[a-z2-7]{52}$/.test(c)) && /^bafkrei[a-z2-7]{52}$/.test(V1_CODE_CID));
}

// ---- 1. wind-down: core/market.go inWindDown under each rule set ----
const PHASES: MarketPhase[] = ['ACTIVE', 'OVERDUE', 'FROZEN', 'CLOSED'];
for (const rules of ['v1', 'v2'] as ContractRules[]) {
  for (const phase of PHASES) {
    const natural = windingDownUnder(rules, { phase, retiredAtBlock: null });
    const retired = windingDownUnder(rules, { phase, retiredAtBlock: 123 });
    const expectNatural = phase === 'CLOSED' || (rules === 'v1' && phase === 'FROZEN');
    check(`${rules} natural ${phase}: windingDown=${expectNatural}`, natural === expectNatural);
    check(`${rules} retired ${phase}: windingDown=true (retire is a wind-down from the retire block, RULING K3)`, retired === true);
  }
}
// the pre-A5 client formula, verbatim, is the v1 column
{
  const legacy = (m: { phase: MarketPhase; retiredAtBlock: number | null }): boolean => m.retiredAtBlock !== null || m.phase === 'FROZEN' || m.phase === 'CLOSED';
  let same = 0;
  for (const phase of PHASES) for (const retiredAtBlock of [null, 5]) if (legacy({ phase, retiredAtBlock }) === windingDownUnder('v1', { phase, retiredAtBlock })) same++;
  check('v1 wind-down is the pre-A5 inline predicate, all 8 cells', same === 8);
  check('windingDownOf(market-health) is windingDownUnder under the market\'s rules',
    windingDownOf({ phase: 'FROZEN', retiredAtBlock: null, rules: 'v1' }) === true && windingDownOf({ phase: 'FROZEN', retiredAtBlock: null, rules: 'v2' }) === false);
}

// ---- 2. THE RENEW GATE IS GONE ----
//
// This section proved renewGateUnder cell by cell: ACTIVE/OVERDUE admitted,
// CLOSED/retired/paused refused with the right reason, v1's terminal FROZEN,
// and v2's revival check (reserve == area admitted, +1 surplus, −1 deficit),
// plus a 16-cell agreement with the pre-A5 client formula. The 10 HBD monthly
// subscription was removed from the contract on 2026-09-12 (OWNER RULING;
// creator-tokens/core/params.go), taking core.Renew and renewGateUnder with it.
// reserveVersusCurve — the surplus/deficit comparison the revival check used —
// SURVIVES and is still proven exactly, in section 3 immediately below.

const SUPPLY = 95;
const AREA = Number(areaBaseUnitsBig(SUPPLY));

// ---- 3. the reserve comparison is exact where it is used ----
{
  check('reserveVersusCurve: equal -> 0, above -> 1, below -> -1', reserveVersusCurve(AREA, SUPPLY) === 0 && reserveVersusCurve(AREA + 1, SUPPLY) === 1 && reserveVersusCurve(AREA - 1, SUPPLY) === -1);
  const big = 10_000;
  const bigArea = areaBaseUnitsBig(big);
  check('the instrument is not vacuous: area(10,000 tokens) is below 2^53, so a Number reserve is exact there', bigArea <= BigInt(Number.MAX_SAFE_INTEGER), `area=${bigArea}`);
  check('at 10,000 tokens: reserve == area is still detected exactly, and +-1 base unit is not equal', reserveVersusCurve(Number(bigArea), big) === 0 && reserveVersusCurve(Number(bigArea) + 1, big) === 1 && reserveVersusCurve(Number(bigArea) - 1, big) === -1);
  // area(S) is cubic: at 1e9 (MaxCap) it exceeds 2^53, so the Number boundary would be inexact there. Record the fact.
  const cap = areaBaseUnitsBig(1_000_000_000);
  console.log(`info  area(MaxCap 1e9) = ${cap} (${cap > BigInt(Number.MAX_SAFE_INTEGER) ? 'above' : 'below'} 2^53; reserves that large do not exist)`);
}

// ---- 4. closeIfDrained ----
check('v1: natural FROZEN with zero supply closes', closesIfDrainedUnder('v1', { phase: 'FROZEN', retiredAtBlock: null, supplyTokens: 0 }) === true);
check('v2: natural FROZEN with zero supply does NOT close (a recoverable lapse must never become terminal by accident)', closesIfDrainedUnder('v2', { phase: 'FROZEN', retiredAtBlock: null, supplyTokens: 0 }) === false);
check('v2: retired FROZEN with zero supply closes', closesIfDrainedUnder('v2', { phase: 'FROZEN', retiredAtBlock: 3, supplyTokens: 0 }) === true);
check('both: CLOSED is already closed; FROZEN with supply does not close', (['v1', 'v2'] as ContractRules[]).every((r) => closesIfDrainedUnder(r, { phase: 'CLOSED', retiredAtBlock: null, supplyTokens: 4 }) && !closesIfDrainedUnder(r, { phase: 'FROZEN', retiredAtBlock: 3, supplyTokens: 1 })));

// ---- 5. the health vocabulary, and its agreement with market/lapse.ts ----
{
  const health = (rules: ContractRules, phase: MarketPhase, retiredAtBlock: number | null, canBuy: boolean) =>
    marketHealthOf({ phase, canBuy, windingDown: windingDownUnder(rules, { phase, retiredAtBlock }) });
  check('v2 natural FROZEN -> delisted', health('v2', 'FROZEN', null, false) === 'delisted');
  check('v1 natural FROZEN -> closed (the word the old client drew)', health('v1', 'FROZEN', null, false) === 'closed');
  check('retired FROZEN -> closed under both', health('v1', 'FROZEN', 1, false) === 'closed' && health('v2', 'FROZEN', 1, false) === 'closed');
  check('retired OVERDUE (notice window) -> closed, not lapsed, under both', health('v1', 'OVERDUE', 1, false) === 'closed' && health('v2', 'OVERDUE', 1, false) === 'closed');
  check('natural OVERDUE, buyable -> lapsed', health('v2', 'OVERDUE', null, true) === 'lapsed');
  check('ACTIVE, delinquent (canBuy false) -> paused', health('v2', 'ACTIVE', null, false) === 'paused');
  check('ACTIVE, buyable -> open', health('v2', 'ACTIVE', null, true) === 'open');
  check('the words: Delisted / Lapsed / Closed / Paused / Buy', buyWordFor('delisted') === 'Delisted' && buyWordFor('lapsed') === 'Lapsed' && buyWordFor('closed') === 'Closed' && buyWordFor('paused') === 'Paused' && buyWordFor('open') === 'Buy' && healthWordFor('open') === null && healthWordFor('delisted') === 'Delisted');
  // ★ THE 24-CELL AGREEMENT WITH market/lapse.ts IS GONE WITH THAT MODULE. It
  // proved the creator-facing lapse vocabulary and this reader-facing one named
  // the same fact in every phase/paid-offset/retired combination. Nothing
  // lapses since 2026-09-12 (OWNER RULING), so market/lapse.ts was deleted and
  // there is no second vocabulary to agree with.
  //
  // What replaces it is the statement that matters now: 'delisted' and 'lapsed'
  // are UNREACHABLE on the new contract, because the only road to FROZEN or
  // OVERDUE is Retire and a retired market is winding down, which the first
  // branch of marketHealthOf catches. They are kept in the union — and asserted
  // here — because this client still serves the OLD contract during the flip
  // window, where a market genuinely can lapse.
  {
    const retired = windingDownUnder('v2', { phase: 'FROZEN', retiredAtBlock: 1 });
    check('a retired FROZEN market is winding down, so it reads closed, never delisted', retired === true && health('v2', 'FROZEN', 1, false) === 'closed');
    check('a retired OVERDUE market (the notice) reads closed too, never lapsed', health('v2', 'OVERDUE', 1, false) === 'closed');
    check('the delisted/lapsed words still exist for the OLD contract this client may still be reading', buyWordFor('delisted') === 'Delisted' && buyWordFor('lapsed') === 'Lapsed');
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
