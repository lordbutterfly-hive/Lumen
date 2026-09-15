/**
 * UNIT TESTS for the cohort exit-tax port (lib/contract-math.ts cohortExitTaxBaseUnits /
 * quoteSellBaseUnits with cohorts; lib/vsc/reads.ts parseLots). Run by
 * `pnpm --filter @hive/blog test:unit` under ts-node; own harness.
 *
 * VECTORS are generated from the CONTRACT's own Go code (creator-tokens/core:
 * Register, Buy at the stated blocks, then Sell), captured 2026-09-15 with a
 * throwaway core test. Every field is the chain's: supply and the lots string
 * before the sale, the SellResult's gross/tax/fee/net after it.
 */
import { cohortExitTaxBaseUnits, lotRateBpsAt, quoteSellBaseUnits, sortLotsFreshestFirst, exitTaxBpsAt, EXIT_TAX_DECAY_BLOCKS, MAX_EXIT_TAX_BPS } from '../../features/creator-tokens/lib/contract-math';
import { parseLots, kLots } from '../../features/creator-tokens/lib/vsc/reads';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const VECTORS = [
  { name: "two fresh cohorts, 6 days apart", supply: 5, lots: "3,1172800;2,1000000", maturing: 5, matured: 0, acq: 1103680, block: 1172800, n: 1, gross: 1040, tax: 156, fee: 52, net: 832 },
  { name: "two fresh cohorts, 6 days apart", supply: 5, lots: "3,1172800;2,1000000", maturing: 5, matured: 0, acq: 1103680, block: 1172800, n: 2, gross: 2071, tax: 311, fee: 103, net: 1657 },
  { name: "two fresh cohorts, 6 days apart", supply: 5, lots: "3,1172800;2,1000000", maturing: 5, matured: 0, acq: 1103680, block: 1172800, n: 3, gross: 3095, tax: 465, fee: 154, net: 2476 },
  { name: "two fresh cohorts, 6 days apart", supply: 5, lots: "3,1172800;2,1000000", maturing: 5, matured: 0, acq: 1103680, block: 1172800, n: 4, gross: 4111, tax: 596, fee: 205, net: 3310 },
  { name: "two fresh cohorts, 6 days apart", supply: 5, lots: "3,1172800;2,1000000", maturing: 5, matured: 0, acq: 1103680, block: 1172800, n: 5, gross: 5118, tax: 726, fee: 255, net: 4137 },
  { name: "three cohorts 0/10/30 days", supply: 9, lots: "3,1864000;2,1288000;4,1000000", maturing: 9, matured: 0, acq: 1352000, block: 1892800, n: 1, gross: 1071, tax: 157, fee: 53, net: 861 },
  { name: "three cohorts 0/10/30 days", supply: 9, lots: "3,1864000;2,1288000;4,1000000", maturing: 9, matured: 0, acq: 1352000, block: 1892800, n: 3, gross: 3190, tax: 468, fee: 159, net: 2563 },
  { name: "three cohorts 0/10/30 days", supply: 9, lots: "3,1864000;2,1288000;4,1000000", maturing: 9, matured: 0, acq: 1352000, block: 1892800, n: 5, gross: 5277, tax: 625, fee: 263, net: 4389 },
  { name: "three cohorts 0/10/30 days", supply: 9, lots: "3,1864000;2,1288000;4,1000000", maturing: 9, matured: 0, acq: 1352000, block: 1892800, n: 6, gross: 6308, tax: 666, fee: 315, net: 5327 },
  { name: "three cohorts 0/10/30 days", supply: 9, lots: "3,1864000;2,1288000;4,1000000", maturing: 9, matured: 0, acq: 1352000, block: 1892800, n: 9, gross: 9355, tax: 786, fee: 467, net: 8102 },
  { name: "one cohort matured (43d) then a fresh top-up", supply: 7, lots: "2,2238400", maturing: 2, matured: 5, acq: 2238400, block: 2267200, n: 1, gross: 1055, tax: 155, fee: 52, net: 848 },
  { name: "one cohort matured (43d) then a fresh top-up", supply: 7, lots: "2,2238400", maturing: 2, matured: 5, acq: 2238400, block: 2267200, n: 2, gross: 2102, tax: 308, fee: 105, net: 1689 },
  { name: "one cohort matured (43d) then a fresh top-up", supply: 7, lots: "2,2238400", maturing: 2, matured: 5, acq: 2238400, block: 2267200, n: 3, gross: 3142, tax: 308, fee: 157, net: 2677 },
  { name: "one cohort matured (43d) then a fresh top-up", supply: 7, lots: "2,2238400", maturing: 2, matured: 5, acq: 2238400, block: 2267200, n: 7, gross: 7220, tax: 308, fee: 361, net: 6551 },
  { name: "other holders around: supply larger than the position", supply: 9, lots: "1,1576000;1,1000000", maturing: 2, matured: 0, acq: 1288000, block: 2152000, n: 1, gross: 1071, tax: 85, fee: 53, net: 933 },
  { name: "other holders around: supply larger than the position", supply: 9, lots: "1,1576000;1,1000000", maturing: 2, matured: 0, acq: 1288000, block: 2152000, n: 2, gross: 2135, tax: 93, fee: 106, net: 1936 }
];

console.log('\ncontract vectors: gross, tax, fee, net reproduced to the base unit');
for (const v of VECTORS) {
  const lots = parseLots(v.lots);
  ok(`${v.name} — lots parse`, lots !== null && lots.length > 0, v.lots);
  if (!lots) continue;
  const heldBlocks = Math.min(Math.max(0, v.block - v.acq), EXIT_TAX_DECAY_BLOCKS);
  const q = quoteSellBaseUnits(v.supply, v.n, heldBlocks, v.maturing, { lots, block: v.block });
  ok(`${v.name} — sell ${v.n}: gross ${v.gross} tax ${v.tax} fee ${v.fee} net ${v.net}`,
    q !== null && q.grossBaseUnits === v.gross && q.taxBaseUnits === v.tax && q.feeBaseUnits === v.fee && q.netBaseUnits === v.net,
    q ? `got gross ${q.grossBaseUnits} tax ${q.taxBaseUnits} fee ${q.feeBaseUnits} net ${q.netBaseUnits}` : 'null');
}

console.log('\nthe blended path still under-states a mixed partial sale (why the port exists)');
{
  const v = VECTORS[0]; // two cohorts, 6 days apart, sell 1
  const lots = parseLots(v.lots)!;
  const heldBlocks = Math.min(Math.max(0, v.block - v.acq), EXIT_TAX_DECAY_BLOCKS);
  const blended = quoteSellBaseUnits(v.supply, 1, heldBlocks, v.maturing)!;
  const exact = quoteSellBaseUnits(v.supply, 1, heldBlocks, v.maturing, { lots, block: v.block })!;
  ok('blended quote is BELOW the chain (fresh token sold first at the full rate)', blended.taxBaseUnits < exact.taxBaseUnits && exact.taxBaseUnits === v.tax, `blended ${blended.taxBaseUnits} exact ${exact.taxBaseUnits}`);
  const all = quoteSellBaseUnits(v.supply, 5, heldBlocks, v.maturing)!;
  const allExact = quoteSellBaseUnits(v.supply, 5, heldBlocks, v.maturing, { lots, block: v.block })!;
  ok('selling everything: the two agree within rounding (the tax is linear in age)', Math.abs(all.taxBaseUnits - allExact.taxBaseUnits) <= 2, `blended ${all.taxBaseUnits} exact ${allExact.taxBaseUnits}`);
}

console.log('\nparseLots / sorting / rates');
ok('freshest first regardless of stored order', JSON.stringify(parseLots('2,100;3,300;1,200')) === JSON.stringify([{ tokens: 3, acqBlock: 300 }, { tokens: 1, acqBlock: 200 }, { tokens: 2, acqBlock: 100 }]));
ok('malformed parts skipped, empty -> null, non-string -> null', JSON.stringify(parseLots('x;3,;,5;2,100;0,9;-1,5;1.5,2')) === JSON.stringify([{ tokens: 2, acqBlock: 100 }]) && parseLots('') === null && parseLots(null) === null && parseLots(42) === null);
ok('key shape', kLots('alice', 'bob') === 'lots|hive:alice|hive:bob' && kLots('hive:alice', 'did:pkh:eip155:1:0xabc') === 'lots|hive:alice|did:pkh:eip155:1:0xabc');
ok('lot rate: unset or future clock is the maximum; 42 days is 0; 21 days is half', lotRateBpsAt(0, 100) === MAX_EXIT_TAX_BPS && lotRateBpsAt(100, 100) === MAX_EXIT_TAX_BPS && lotRateBpsAt(1, 1 + EXIT_TAX_DECAY_BLOCKS) === 0 && lotRateBpsAt(1, 1 + EXIT_TAX_DECAY_BLOCKS / 2) === exitTaxBpsAt(EXIT_TAX_DECAY_BLOCKS / 2));
ok('stable sort keeps equal ages in place', JSON.stringify(sortLotsFreshestFirst([{ tokens: 1, acqBlock: 5 }, { tokens: 2, acqBlock: 5 }])) === JSON.stringify([{ tokens: 1, acqBlock: 5 }, { tokens: 2, acqBlock: 5 }]));
ok('a ledger short of the balance taxes the rest at the maximum', (() => { const c = cohortExitTaxBaseUnits(5, 3, [{ tokens: 1, acqBlock: 1 }], 1 + EXIT_TAX_DECAY_BLOCKS); return c !== null && c.effBps > 0 && c.taxBaseUnits > 0; })());
ok('nothing from maturing -> zero tax', JSON.stringify(cohortExitTaxBaseUnits(5, 0, [{ tokens: 5, acqBlock: 1 }], 10)) === JSON.stringify({ taxBaseUnits: 0, taxableBaseUnits: 0, effBps: 0 }));
ok('more than the supply -> null (the curve refuses)', cohortExitTaxBaseUnits(2, 3, [{ tokens: 3, acqBlock: 1 }], 10) === null);

if (failures === 0) {
  console.log(`\nmeritum-cohort-tax: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-cohort-tax: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
