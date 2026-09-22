/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * v6 MATH VECTORS: 1,500 rows computed by the CONTRACT (creator-tokens/core
 * zz_v6_math_vectors_test.go, seeded random sweep over buys, sells with 1-3
 * cohorts and a matured bucket, asks, refunds and the curve), replayed here
 * against contract-math.ts. The JSON beside this file is a copy of
 * creator-tokens/core/testdata/v6-math-vectors.json; regenerate both with
 * `V6_VECTORS=1 go test ./core/ -run TestV6_EmitMathVectors` and copy.
 *
 * Run: cd apps/blog && npx ts-node -r tsconfig-paths/register --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' features/creator-tokens/lib/v6-math-vectors.selftest.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  areaBaseUnits,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  formatTokenAmountFixed,
  fromUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  refundPayoutBaseUnits,
  spotRateBaseUnits,
  toUnits
} from './contract-math';

interface Vectors {
  seed: number;
  buy: { supplyUnits: number; units: number; cost: number; fee: number; total: number; spotAfter: number }[];
  sell: {
    supplyUnits: number; units: number; maturingUnits: number; maturedUnits: number;
    lots: { units: number; acq: number }[]; block: number; heldBlocks: number;
    gross: number; tax: number; taxBps: number; fee: number; net: number;
  }[];
  ask: { face: number; rate: number; units: number; commissionUnits: number }[];
  refund: { reserve: number; units: number; supplyUnits: number; gross: number }[];
  misc: { units: number; area: number; spot: number; format: string }[];
}
const V: Vectors = JSON.parse(readFileSync(join(__dirname, 'v6-math-vectors.json'), 'utf8'));

let failures = 0;
let checks = 0;
function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    if (failures <= 25) console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

for (const [i, r] of V.buy.entries()) {
  const q = quoteBuyBaseUnits(fromUnits(r.supplyUnits), fromUnits(r.units));
  check(`buy[${i}] cost`, q.costBaseUnits === r.cost, `S=${r.supplyUnits} n=${r.units}: ${q.costBaseUnits} vs ${r.cost}`);
  check(`buy[${i}] fee`, q.feeBaseUnits === r.fee, `${q.feeBaseUnits} vs ${r.fee}`);
  check(`buy[${i}] total`, q.totalDueBaseUnits === r.total, `${q.totalDueBaseUnits} vs ${r.total}`);
  check(`buy[${i}] spot after`, q.rateAfterBaseUnits === r.spotAfter, `${q.rateAfterBaseUnits} vs ${r.spotAfter}`);
}
for (const [i, r] of V.sell.entries()) {
  const cohorts = r.lots.length > 0 ? { lots: r.lots.map((l) => ({ tokens: fromUnits(l.units), acqBlock: l.acq })), block: r.block } : undefined;
  const q = quoteSellBaseUnits(fromUnits(r.supplyUnits), fromUnits(r.units), r.heldBlocks, fromUnits(r.maturingUnits), cohorts);
  check(`sell[${i}] quotes`, q !== null, JSON.stringify(r));
  if (!q) continue;
  check(`sell[${i}] gross`, q.grossBaseUnits === r.gross, `${q.grossBaseUnits} vs ${r.gross}`);
  check(`sell[${i}] tax`, q.taxBaseUnits === r.tax, `S=${r.supplyUnits} k=${r.units} maturing=${r.maturingUnits} lots=${JSON.stringify(r.lots)}: ${q.taxBaseUnits} vs ${r.tax}`);
  check(`sell[${i}] taxBps`, q.taxBps === r.taxBps, `${q.taxBps} vs ${r.taxBps}`);
  check(`sell[${i}] fee`, q.feeBaseUnits === r.fee, `${q.feeBaseUnits} vs ${r.fee}`);
  check(`sell[${i}] net`, q.netBaseUnits === r.net, `${q.netBaseUnits} vs ${r.net}`);
}
for (const [i, r] of V.ask.entries()) {
  const credits = creditsForAskBaseUnits(r.face, r.rate, true);
  check(`ask[${i}] credits`, toUnits(credits) === r.units, `face=${r.face} rate=${r.rate}: ${toUnits(credits)} vs ${r.units}`);
  check(`ask[${i}] commission`, toUnits(commissionOwedForBaseUnits(credits, true)) === r.commissionUnits, `${toUnits(commissionOwedForBaseUnits(credits, true))} vs ${r.commissionUnits}`);
}
for (const [i, r] of V.refund.entries()) {
  const g = refundPayoutBaseUnits(r.reserve, fromUnits(r.units), fromUnits(r.supplyUnits));
  check(`refund[${i}] gross`, g === r.gross, `${g} vs ${r.gross}`);
}
for (const [i, r] of V.misc.entries()) {
  check(`misc[${i}] area`, areaBaseUnits(fromUnits(r.units)) === r.area, `u=${r.units}: ${areaBaseUnits(fromUnits(r.units))} vs ${r.area}`);
  check(`misc[${i}] spot`, spotRateBaseUnits(fromUnits(r.units)) === r.spot, `u=${r.units}: ${spotRateBaseUnits(fromUnits(r.units))} vs ${r.spot}`);
  check(`misc[${i}] format`, formatTokenAmountFixed(fromUnits(r.units)) === r.format, `${formatTokenAmountFixed(fromUnits(r.units))} vs ${r.format}`);
}

console.log(`\n${checks - failures}/${checks} checks passed (seed ${V.seed})`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
