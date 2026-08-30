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
 * market/lapse.ts agree on every phase, and that the reserve comparison is
 * exact where it matters. It does NOT prove agreement with the Go core: that
 * is the phase-ladder twin (Go dumps the grid, the compiled client is run over
 * it; findings/59-P25-seam-family.md), which must be re-run whenever either
 * side changes. A green run here with a red twin is a wrong client.
 *
 * Section 0 is the degeneracy check: the assertion helper detects a false
 * condition, and rulesForCode discriminates its inputs, so a constant function
 * could not pass the sections below by accident.
 */
import { areaBaseUnitsBig, derivePhase, GRACE_BLOCKS } from '../lib/contract-math';
import type { ContractRules, MarketPhase } from '../types';
import {
  V1_CODE_CID,
  V2_CODE_CIDS,
  V2_FAST_TWIN_CODE_CID,
  closesIfDrainedUnder,
  renewGateUnder,
  reserveVersusCurve,
  rulesForCode,
  windingDownUnder
} from './contract-rules';
import { buyWordFor, healthWordFor, marketHealthOf, windingDownOf } from './market-health';
import { lapseStateOf } from './lapse';

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
    rulesForCode(V2_FAST_TWIN_CODE_CID) === 'v2' && V2_CODE_CIDS.has(V2_FAST_TWIN_CODE_CID) && v2 !== V2_FAST_TWIN_CODE_CID && V2_CODE_CIDS.size === 2);
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

// ---- 2. the renew gate ----
const SUPPLY = 95;
const AREA = Number(areaBaseUnitsBig(SUPPLY));
const base = { retiredAtBlock: null as number | null, globalInflowPaused: false, supplyTokens: SUPPLY, reserveBaseUnits: AREA };
for (const rules of ['v1', 'v2'] as ContractRules[]) {
  check(`${rules} ACTIVE renews`, renewGateUnder(rules, { ...base, phase: 'ACTIVE' }).canRenew === true);
  check(`${rules} OVERDUE renews (inside grace)`, renewGateUnder(rules, { ...base, phase: 'OVERDUE' }).canRenew === true);
  check(`${rules} CLOSED refused: closed`, renewGateUnder(rules, { ...base, phase: 'CLOSED' }).renewRefusal === 'closed');
  check(`${rules} retired refused: retired, and it outranks the pause`, renewGateUnder(rules, { ...base, phase: 'ACTIVE', retiredAtBlock: 7, globalInflowPaused: true }).renewRefusal === 'retired');
  check(`${rules} paused refused: paused`, renewGateUnder(rules, { ...base, phase: 'ACTIVE', globalInflowPaused: true }).renewRefusal === 'paused');
  check(`${rules} a refusal never reports canRenew`, (['CLOSED'] as MarketPhase[]).every((phase) => renewGateUnder(rules, { ...base, phase }).canRenew === false));
}
check('v1 FROZEN refused: lapsed-terminal (requireMarketAcceptsMoney admits ACTIVE/OVERDUE only)', renewGateUnder('v1', { ...base, phase: 'FROZEN' }).renewRefusal === 'lapsed-terminal');
check('v1 FROZEN refused even with reserve == area (the reserve is irrelevant under v1)', renewGateUnder('v1', { ...base, phase: 'FROZEN', reserveBaseUnits: AREA }).canRenew === false);
check('v2 FROZEN with reserve == area(supply): ADMITTED (the revival check passes)', renewGateUnder('v2', { ...base, phase: 'FROZEN' }).canRenew === true && renewGateUnder('v2', { ...base, phase: 'FROZEN' }).renewRefusal === null);
check('v2 FROZEN with reserve == area + 1: refused as surplus (H16, partial pro-rata refunds under v1)', renewGateUnder('v2', { ...base, phase: 'FROZEN', reserveBaseUnits: AREA + 1 }).renewRefusal === 'surplus');
check('v2 FROZEN with reserve == area - 1: refused as deficit (corrupt state)', renewGateUnder('v2', { ...base, phase: 'FROZEN', reserveBaseUnits: AREA - 1 }).renewRefusal === 'deficit');
check('v2 FROZEN at supply 0 / reserve 0: admitted (genesis equality)', renewGateUnder('v2', { ...base, phase: 'FROZEN', supplyTokens: 0, reserveBaseUnits: 0 }).canRenew === true);
check('v2 retired FROZEN: refused as retired, never consulted the reserve', renewGateUnder('v2', { ...base, phase: 'FROZEN', retiredAtBlock: 9, reserveBaseUnits: AREA + 1 }).renewRefusal === 'retired');
check('v2 UNKNOWN phase is a refusal, not an admission', renewGateUnder('v2', { ...base, phase: 'UNKNOWN' }).canRenew === false);
// the pre-A5 client canRenew (acceptsMoney = canInflowOpen && !retired) is the v1 column, all cells
{
  let same = 0, cells = 0;
  for (const phase of PHASES) for (const retiredAtBlock of [null, 5]) for (const globalInflowPaused of [false, true]) {
    cells++;
    const legacy = !globalInflowPaused && (phase === 'ACTIVE' || phase === 'OVERDUE') && retiredAtBlock === null;
    if (legacy === renewGateUnder('v1', { ...base, phase, retiredAtBlock, globalInflowPaused }).canRenew) same++;
  }
  check(`v1 canRenew is the pre-A5 client formula, all ${cells} cells`, same === cells && cells === 16);
}

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
  // market/lapse.ts (creator-facing, clauderfly-43) and this vocabulary (reader-facing) must name the same fact.
  const head = 1_000_000;
  let agree = 0, cells = 0;
  for (const rules of ['v1', 'v2'] as ContractRules[]) for (const paidOff of [-1, 0, 1, GRACE_BLOCKS - 1, GRACE_BLOCKS, GRACE_BLOCKS + 5]) for (const retiredAtBlock of [null, head - 10]) {
    cells++;
    const paidUntilBlock = head - paidOff;
    const phase = derivePhase(false, paidUntilBlock, head, retiredAtBlock);
    const windingDown = windingDownUnder(rules, { phase, retiredAtBlock });
    const canBuy = !windingDown && (phase === 'ACTIVE' || phase === 'OVERDUE') && retiredAtBlock === null;
    const h = marketHealthOf({ phase, canBuy, windingDown });
    const l = lapseStateOf({ phase, paidUntilBlock, graceExpiresAtBlock: paidUntilBlock + GRACE_BLOCKS, headBlock: head, windingDown });
    const same = (h === 'delisted') === (l.kind === 'delisted') && (h === 'closed') === (l.kind === 'winding-down');
    if (same) agree++; else console.log(`      disagree: ${rules} paidOff=${paidOff} retired=${retiredAtBlock !== null} phase=${phase} health=${h} lapse=${l.kind}`);
  }
  check(`market-health and market/lapse.ts agree on delisted and winding-down, all ${cells} cells`, agree === cells && cells === 24);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
