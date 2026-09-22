/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * v6 FRACTIONAL TOKENS: cross-language vectors (2026-09-22).
 *
 * Every number here was produced by the CONTRACT, not by this module: the Go
 * suite (creator-tokens/core zz_v6_*_test.go), the real-wasm harness
 * (testing/creator_tokens_escrow_test.go.govsc against the v6 bytecode) and
 * the devnet update rehearsal. If a figure here and the contract ever
 * disagree, the contract is right and this file is the alarm.
 *
 * Run: cd apps/blog && npx ts-node -r tsconfig-paths/register --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/v6-units.selftest.ts
 */
import {
  TOKEN_SCALE,
  areaBaseUnits,
  buyCostBaseUnits,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  formatTokenAmount,
  isUnitMultiple,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  roundToUnits,
  sellProceedsBaseUnits,
  spotRateBaseUnits,
  toUnits,
  tokensAffordableForBudget,
  tradeFeeOn
} from './contract-math';
import { V6_CODE_CIDS, fractionalTokensUnder, rulesForCode, tokenStepUnder } from '../market/contract-rules';
import { buyQuote, serviceQuote } from '../market/curve';
import { parseEscrow, parseLots, tokenCountFromState } from './vsc/reads';
import { askPayload, buyPayload, sellPayload, transferTokensPayload } from './vsc/op-builders';
import { assertPayloadShape } from './vsc/payload-contract';

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

// ── units and the wire form
check('TOKEN_SCALE is 100 (params.go TokenScale)', TOKEN_SCALE === 100);
check('toUnits survives floating point (0.29 -> 29, 1.15 -> 115)', toUnits(0.29) === 29 && toUnits(1.15) === 115);
check('roundToUnits snaps a third decimal', roundToUnits(10.129) === 10.13 && roundToUnits(0.005) === 0.01);
check('isUnitMultiple: 1.5 yes, 0.001 no', isUnitMultiple(1.5) && !isUnitMultiple(0.001));
check('formatTokenAmount: always two places, as the contract prints ("2.00", "1.50", "0.01", "42.64")', formatTokenAmount(2) === '2.00' && formatTokenAmount(1.5) === '1.50' && formatTokenAmount(0.01) === '0.01' && formatTokenAmount(42.64) === '42.64');

// ── the unit curve (core zz_v6_curve_test.go, zz_v6_edges_test.go)
check('Area(0.01) = 10 (floor of 1007/100)', areaBaseUnits(0.01) === 10);
check('Area(1) = 1007, Area(2) = 2023, Area(3) = 3047 — the whole-token curve is unchanged', areaBaseUnits(1) === 1007 && areaBaseUnits(2) === 2023 && areaBaseUnits(3) === 3047);
check('first unit: cost 10 + minimum fee 1 = 11', quoteBuyBaseUnits(0, 0.01).costBaseUnits === 10 && quoteBuyBaseUnits(0, 0.01).feeBaseUnits === 1 && quoteBuyBaseUnits(0, 0.01).totalDueBaseUnits === 11);
check('first whole token: 1007 + 50 = 1057', quoteBuyBaseUnits(0, 1).totalDueBaseUnits === 1057);
check('2 tokens at S=0: 2023 + 101 = 2124 (mainnet hbd-temp)', quoteBuyBaseUnits(0, 2).totalDueBaseUnits === 2124);
check('1 token at S=2: 1024 + 51 = 1075 (mainnet blanchy)', quoteBuyBaseUnits(2, 1).totalDueBaseUnits === 1075);
check('harness: buy 1.50 at S=1000 costs 17276, fee 863, total 18139', quoteBuyBaseUnits(1000, 1.5).costBaseUnits === 17276 && quoteBuyBaseUnits(1000, 1.5).feeBaseUnits === 863 && quoteBuyBaseUnits(1000, 1.5).totalDueBaseUnits === 18139);
check('harness: sell 0.25 at S=1001.50 grosses 2882, tax 433 at 1500 bps, fee 144, net 2305', (() => {
  const q = quoteSellBaseUnits(1001.5, 0.25, 0)!;
  return q.grossBaseUnits === 2882 && q.taxBaseUnits === 433 && q.feeBaseUnits === 144 && q.netBaseUnits === 2305;
})());
check('path independence: 100 unit buys cost exactly one whole token', (() => {
  let sum = 0;
  for (let i = 0; i < 100; i++) sum += buyCostBaseUnits(i / 100, 0.01);
  return sum === buyCostBaseUnits(0, 1);
})());
check('SpotRate(2.01) quotes token 3 = SpotRate(3)', spotRateBaseUnits(2.01) === spotRateBaseUnits(3) && spotRateBaseUnits(600) === 6670);
check('sellProceeds refuses more than the supply', sellProceedsBaseUnits(1, 1.01) === null);
check('minimum fee floor on a dust gross', tradeFeeOn(10).feeBaseUnits === 1 && tradeFeeOn(0).feeBaseUnits === 0);

// ── budgets
check('$0.02 buys 0.01 under v6 and nothing under whole tokens', tokensAffordableForBudget(0, 20, 0.01) === 0.01 && tokensAffordableForBudget(0, 20, 1) === 0);
check('1056 base units buy 0.99 under v6 (0.99 = 996 + 49), 1.00 needs 1057', tokensAffordableForBudget(0, 1056, 0.01) === 0.99 && tokensAffordableForBudget(0, 1057, 0.01) === 1);
check('buyQuote under v6 returns hundredths; under v5 whole tokens', buyQuote(0.02, { supply: 0, cap: 1_000_000, position: null, rules: 'v6' }).tokens === 0.01 && buyQuote(0.02, { supply: 0, cap: 1_000_000, position: null, rules: 'v5' }).tokens === 0);

// ── asks (spec: "$1.50 = 1.48 tokens"; harness fresh market: 150 HBD at spot 6670)
check('creditsForAsk v6: ceil(150000 x 100 / 6670) = 22.49; whole tokens: 23', creditsForAskBaseUnits(150000, 6670, true) === 22.49 && creditsForAskBaseUnits(150000, 6670) === 23);
check('commission on 22.49 = 2.69 (floor of 2249 x 12%), creator keeps 19.80', commissionOwedForBaseUnits(22.49, true) === 2.69 && roundToUnits(22.49 - 2.69) === 19.8);
check('serviceQuote: $1.50 at $1.015/token = 1.48 tokens under v6, 2 under v5', serviceQuote(1.5, 1.015, 'v6').tokens === 1.48 && serviceQuote(1.5, 1.015, 'v5').tokens === 2);
check('harness quote: 250 HBD at rate 5864 = 42.64 credits, commission 5.11, creator 37.53', creditsForAskBaseUnits(250000, 5864, true) === 42.64 && commissionOwedForBaseUnits(42.64, true) === 5.11);

// ── rules gate
const V6 = [...V6_CODE_CIDS][0];
check('the v6 CID maps to v6 rules; the v5.1 mainnet CID does not', rulesForCode(V6) === 'v6' && rulesForCode('bafkreicij3ipcglu6xkc25upwlox5okpcfojf6u2g3flfzt2kszw44bdeu') === 'v5');
check('fractions only under v6', fractionalTokensUnder('v6') && !fractionalTokensUnder('v5') && tokenStepUnder('v6') === 0.01 && tokenStepUnder('v5') === 1);

// ── state decoders (mainnet snapshot + harness records)
check('tokenCountFromState: flagged "200" = 2.00, unflagged "2" = 2', tokenCountFromState('200', '1') === 2 && tokenCountFromState('2', null) === 2 && tokenCountFromState('2', '') === 2);
check('parseLots scales by the holder flag', (() => {
  const a = parseLots('100,109951631;300,109801223', '1')!;
  const b = parseLots('1,109951631;3,109801223', null)!;
  return a[0].tokens === 1 && a[0].acqBlock === 109951631 && a[1].tokens === 3 && b[0].tokens === 1 && b[1].tokens === 3;
})());
check('parseEscrow: the v6 ten-field record (harness) = 42.64 escrowed, commission 5.11', (() => {
  const e = parseEscrow('hive:ctasker|4264|209420|PENDING|511|94649|0|u2|cid-decline|')!;
  return e.units && e.tokensEscrowed === 42.64 && e.commissionTokens === 5.11 && e.contentHash === 'cid-decline' && e.answerHash === '' && e.deadlineBlock === 209420;
})());
check('parseEscrow: the mainnet nine-field record (hbd-temp seq 0) = 1 token, answered', (() => {
  const e = parseEscrow('hive:lordbutterfly|1|110140884|ANSWERED|0|110111621|1|ask-14woy0|TESTING TEST')!;
  return !e.units && e.tokensEscrowed === 1 && e.status === 'ANSWERED' && e.answerHash === 'TESTING TEST' && e.offeringId === 1 && e.acqBlock === 110111621;
})());
check('parseEscrow refuses a truncated record', parseEscrow('hive:x|1|2|PENDING|0|3|0') === null);

// ── payloads: decimal token strings the contract\'s parser accepts
check('buy 1.5 -> "1.50", sell 0.25 -> "0.25", transfer 2 -> "2.00", ask cap 22.49 -> "22.49"', buyPayload('hive:c', 1.5).tokens === '1.50' && sellPayload('hive:c', 0.25).tokens === '0.25' && transferTokensPayload('hive:c', 'hive:d', 2).amount === '2.00' && askPayload('hive:c', 'h', 28800, 22.49, 0).maxCredits === '22.49');
check('the payload contract accepts the decimal forms', (() => {
  try {
    assertPayloadShape('buy', buyPayload('hive:c', 1.5));
    assertPayloadShape('ask', askPayload('hive:c', 'h', 28800, 22.49, 0));
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
})());
check('a third decimal is refused before it reaches the wire', (() => {
  try {
    buyPayload('hive:c', 0.001);
    return false;
  } catch {
    return true;
  }
})());

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
