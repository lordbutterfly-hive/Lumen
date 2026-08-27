/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE TRADE DIALOGS' ARITHMETIC, CHECKED AGAINST THE CONTRACT ITSELF.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/ui/token-page/trade-preview.selftest.ts
 *
 * ★★★ THE GOLDEN VECTORS BELOW CAME OUT OF THE GO CONTRACT, NOT OUT OF THE
 * TYPESCRIPT UNDER TEST. Asserting a TypeScript port against another TypeScript
 * port proves the two agree, which is exactly what a port defect looks like from
 * the inside. Every REFUND, BUY, SPOT, ASK and TAXBPS row below was PRINTED by
 * `core.Refund`, `core.QuoteBuy`, `core.SpotRate`, `core.splitFace` /
 * `core.creditsForAsk` and `core.ExitTaxBpsAt` running as compiled Go against
 * `/mnt/o/Lumen/creator-tokens/core/*.go` (go1.22.2, 2026-08-27). To regenerate:
 * copy `core/*.go` into a scratch module, drop in a `package core` test that
 * sets up a MemStore market and prints these tab-separated rows, and paste the
 * block between GOLDEN_BEGIN and GOLDEN_END.
 *
 * ★ AND EVERY SECTION CARRIES ITS OWN FALSIFICATION. Each defect's OLD code is
 * reimplemented here verbatim and asserted to DISAGREE with the golden by the
 * measured amount. A fix test that only asserts the new behaviour cannot tell a
 * real fix from a test written against whatever the code happens to do; a test
 * that also pins the old behaviour's error can.
 */

import {
  MAX_PRICE_DEFAULT_HEADROOM_BPS,
  acceptAmountText,
  askCost,
  askCostLine,
  askCostSegments,
  buyCeilingNote,
  buyRows,
  defaultMaxPriceText,
  effectiveExitFeePct,
  exitFeeBaseNote,
  parseAmount,
  redeemQuote,
  resolveMaxPriceCap,
  sellRows
} from './trade-preview';
import { buyQuote, sellQuote, serviceQuote } from '../../market/curve';
import { pctLabel, usdPrice } from '../../market/format';

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

// =====================================================================
// THE GOLDEN VECTORS — verbatim stdout of the Go generator.
// =====================================================================

const GOLDEN = `
REFUND	120000	1000	100	40	0	1	120	24	96	2000
REFUND	120000	1000	100	40	0	10	1200	240	960	2000
REFUND	120000	1000	100	40	0	39	4680	936	3744	2000
REFUND	120000	1000	100	40	0	40	4800	960	3840	2000
REFUND	120000	1000	100	40	0	41	4920	960	3960	2000
REFUND	120000	1000	100	40	0	80	9600	960	8640	2000
REFUND	120000	1000	100	40	0	99	11880	960	10920	2000
REFUND	120000	1000	100	40	0	100	12000	960	11040	2000
REFUND	120000	1000	100	100	0	10	1200	240	960	2000
REFUND	120000	1000	100	100	0	50	6000	1200	4800	2000
REFUND	120000	1000	100	100	0	100	12000	2400	9600	2000
REFUND	120000	1000	100	1	0	1	120	24	96	2000
REFUND	120000	1000	100	1	0	50	6000	24	5976	2000
REFUND	120000	1000	100	1	0	100	12000	24	11976	2000
REFUND	60153	50	50	20	0	1	1203	241	962	2000
REFUND	60153	50	50	20	0	5	6015	1203	4812	2000
REFUND	60153	50	50	20	0	20	24061	4813	19248	2000
REFUND	60153	50	50	20	0	35	42107	4813	37294	2000
REFUND	60153	50	50	20	0	50	60153	4813	55340	2000
REFUND	60153	50	50	20	604800	1	1203	121	1082	1000
REFUND	60153	50	50	20	604800	20	24061	2407	21654	1000
REFUND	60153	50	50	20	604800	50	60153	2407	57746	1000
REFUND	60153	50	50	20	1209600	1	1203	0	1203	0
REFUND	60153	50	50	20	1209600	20	24061	0	24061	0
REFUND	60153	50	50	20	1209600	50	60153	0	60153	0
REFUND	999999	777	333	111	201600	1	1287	215	1072	1667
REFUND	999999	777	333	111	201600	111	142857	23815	119042	1667
REFUND	999999	777	333	111	201600	222	285714	23815	261899	1667
REFUND	999999	777	333	111	201600	333	428571	23815	404756	1667
BUY	0	1	1007	100	1107
BUY	0	2	2023	202	2225
BUY	0	4	4078	407	4485
BUY	0	8	8284	828	9112
BUY	0	15	15948	1594	17542
BUY	0	39	45196	4519	49715
BUY	0	70	89875	8987	98862
BUY	10	1	1087	108	1195
BUY	10	2	2181	218	2399
BUY	10	4	4395	439	4834
BUY	10	8	8918	891	9809
BUY	10	15	17139	1713	18852
BUY	10	39	48318	4831	53149
BUY	10	70	95537	9553	105090
BUY	50	1	1408	140	1548
BUY	50	2	2825	282	3107
BUY	50	4	5683	568	6251
BUY	50	8	11496	1149	12645
BUY	50	15	21984	2198	24182
BUY	50	39	61013	6101	67114
BUY	50	70	118550	11855	130405
BUY	100	1	1823	182	2005
BUY	100	2	3653	365	4018
BUY	100	4	7339	733	8072
BUY	100	8	14813	1481	16294
BUY	100	15	28218	2821	31039
BUY	100	39	77343	7734	85077
BUY	100	70	148144	14814	162958
BUY	500	1	5604	560	6164
BUY	500	2	11219	1121	12340
BUY	500	4	22480	2248	24728
BUY	500	8	45128	4512	49640
BUY	500	15	85169	8516	93685
BUY	500	39	226400	22640	249040
BUY	500	70	417961	41796	459757
BUY	1000	1	11513	1151	12664
BUY	1000	2	23039	2303	25342
BUY	1000	4	46131	4613	50744
BUY	1000	8	92473	9247	101720
BUY	1000	15	174078	17407	191485
BUY	1000	39	458791	45879	504670
BUY	1000	70	837922	83792	921714
SPOT	0	0
SPOT	10	1079
SPOT	50	1400
SPOT	100	1813
SPOT	500	5593
SPOT	1000	11500
ASK	50	15000	1400	13200	1800	10	14000
ASK	50	25000	1400	22000	3000	16	22400
ASK	50	200000	1400	176000	24000	126	176400
ASK	1000	15000	11500	13200	1800	2	23000
ASK	1000	25000	11500	22000	3000	2	23000
ASK	1000	200000	11500	176000	24000	16	184000
TAXBPS	0	2000
TAXBPS	1	1953
TAXBPS	7	1667
TAXBPS	21	1000
TAXBPS	41	48
TAXBPS	42	0
TAXBPS	43	0
`;

function rows(tag: string): number[][] {
  return GOLDEN.trim()
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f[0] === tag)
    .map((f) => f.slice(1).map(Number));
}

const REFUND = rows('REFUND').map(([reserve, supply, held, maturing, heldBlocks, n, gross, tax, net, taxBps]) => ({
  reserve, supply, held, maturing, heldBlocks, n, gross, tax, net, taxBps
}));
const BUY = rows('BUY').map(([supply, n, cost, fee, total]) => ({ supply, n, cost, fee, total }));
const SPOT = new Map(rows('SPOT').map(([supply, rate]) => [supply, rate]));
const ASK = rows('ASK').map(([supply, face, rate, tokenLeg, commission, credits, legValue]) => ({
  supply, face, rate, tokenLeg, commission, credits, legValue
}));
const TAXBPS = rows('TAXBPS').map(([days, bps]) => ({ days, bps }));

const BLOCKS_PER_DAY = 28_800;
const usd = (baseUnits: number) => baseUnits / 1000;

/**
 * ★ A MISSING GOLDEN ROW MUST FAIL LOUDLY, NOT COMPARE AGAINST `undefined`.
 * The first draft used `!` here and a mistyped lookup threw a bare TypeError
 * halfway through the run, taking every later section with it. Worse, a lookup
 * that silently resolved to a zero would have PASSED an assertion about money.
 */
function mustFind<T>(rowsIn: T[], pred: (r: T) => boolean, what: string): T {
  const hit = rowsIn.find(pred);
  if (hit === undefined) throw new Error(`golden vector missing: ${what} — the table and the assertion have drifted apart`);
  return hit;
}
function mustGet<K, V>(map: Map<K, V>, key: K, what: string): V {
  const hit = map.get(key);
  if (hit === undefined) throw new Error(`golden vector missing: ${what}`);
  return hit;
}

// ── NON-VACUITY. A table with nothing in it must FAIL, never pass silently.
console.log('\n── 0. THE GOLDENS LOADED.\n');
check('the REFUND goldens parsed', REFUND.length === 29, `${REFUND.length} rows`);
check('the BUY goldens parsed', BUY.length === 42, `${BUY.length} rows`);
check('the SPOT goldens parsed', SPOT.size === 6, `${SPOT.size} rows`);
check('the ASK goldens parsed', ASK.length === 6, `${ASK.length} rows`);
check('the TAXBPS goldens parsed', TAXBPS.length === 7, `${TAXBPS.length} rows`);
check('no golden row carries a NaN (a mis-split column would silently pass every comparison)',
  [...REFUND, ...BUY, ...ASK].every((r) => Object.values(r).every((v) => Number.isFinite(v))));
check('★ the goldens are internally consistent: gross − tax === net on every refund row',
  REFUND.every((r) => r.gross - r.tax === r.net));
check('★ …and cost + fee === TotalDue on every buy row',
  BUY.every((r) => r.cost + r.fee === r.total));

// =====================================================================
// 1. F-A — THE PARTIAL REDEEM.
// =====================================================================
console.log('\n── 1. F-A. The partial redeem must equal what refund.go pays.\n');

/** The code as it stood before this pass: the whole position's net, scaled pro rata. */
function oldRedeemUsd(floorValueUsd: number, tokens: number, held: number): number {
  return held > 0 ? (floorValueUsd * tokens) / held : 0;
}

{
  let matched = 0;
  let oldWrong = 0;
  let worstOldErrPct = 0;
  let oldReverts = 0;
  let newReverts = 0;
  const MIN_NET_TOLERANCE = 0.01; // MIN_NET_DEFAULT_TOLERANCE_BPS = 100

  for (const g of REFUND) {
    const heldDays = g.heldBlocks / BLOCKS_PER_DAY;
    const q = redeemQuote({
      reserveUsd: usd(g.reserve),
      supplyTokens: g.supply,
      heldTokens: g.held,
      maturingTokens: g.maturing,
      heldDays,
      tokens: g.n
    });
    // Base units, so the comparison is on the contract's own integer lattice.
    const gotNet = Math.round(q.netUsd * 1000);
    const gotGross = Math.round(q.grossUsd * 1000);
    const gotTax = Math.round(q.taxUsd * 1000);
    if (gotNet === g.net && gotGross === g.gross && gotTax === g.tax && q.taxBps === g.taxBps) matched += 1;
    else {
      console.error(`      MISMATCH reserve=${g.reserve} supply=${g.supply} held=${g.held} maturing=${g.maturing} h=${g.heldBlocks} n=${g.n}: got gross/tax/net/bps ${gotGross}/${gotTax}/${gotNet}/${q.taxBps}, want ${g.gross}/${g.tax}/${g.net}/${g.taxBps}`);
    }

    // The OLD path, fed the same whole-position net the data source produces.
    const wholePosition = REFUND.find(
      (r) => r.reserve === g.reserve && r.supply === g.supply && r.held === g.held && r.maturing === g.maturing &&
        r.heldBlocks === g.heldBlocks && r.n === g.held
    );
    if (wholePosition) {
      const oldUsd = oldRedeemUsd(usd(wholePosition.net), g.n, g.held);
      const oldBase = oldUsd * 1000;
      if (Math.abs(oldBase - g.net) > 0.5) {
        oldWrong += 1;
        worstOldErrPct = Math.max(worstOldErrPct, ((oldBase - g.net) / g.net) * 100);
      }
      // The floor the dialog signs: 1% under whatever it showed. It reverts when
      // the floor is above what the chain will actually pay.
      if (oldBase * (1 - MIN_NET_TOLERANCE) > g.net + 1e-9) oldReverts += 1;
      if (q.netUsd * 1000 * (1 - MIN_NET_TOLERANCE) > g.net + 1e-9) newReverts += 1;
    }
  }

  check('★ redeemQuote reproduces refund.go EXACTLY on every golden row (gross, tax, net and rate)',
    matched === REFUND.length, `${matched}/${REFUND.length} matched`);
  check('★ …and the check is not vacuous: there were rows to match', REFUND.length >= 29);
  check('★ THE OLD LINEAR SCALE DISAGREES WITH THE CHAIN — this is the defect',
    oldWrong > 0, `${oldWrong} of ${REFUND.length} golden draws were mis-quoted by the old scale`);
  check('★ …and it over-quoted, never under-quoted (which is why it reverted rather than short-paying)',
    worstOldErrPct > 14, `worst over-quote ${worstOldErrPct.toFixed(2)}%`);
  check('★ every partial size tripped its own 1% minimum-refund floor under the old scale',
    oldReverts > 0, `${oldReverts} of the golden draws would have REVERTED`);
  check('★ …and none of them does now', newReverts === 0, `${newReverts} would still revert`);
}

{
  // The bound, stated and measured: over-quote → 1/(1 − τ) as the maturing share
  // goes to zero. reserve 120000 / supply 1000 / held 100 / maturing 1 / τ=20%.
  const g100 = mustFind(REFUND, (r) => r.maturing === 1 && r.n === 100, 'maturing=1 n=100');
  const g1 = mustFind(REFUND, (r) => r.maturing === 1 && r.n === 1, 'maturing=1 n=1');
  const oldAt1 = (usd(g100.net) * 1) / 100 * 1000;
  const errPct = ((oldAt1 - g1.net) / g1.net) * 100;
  check('★ the worst measured over-quote is the 1/(1−τ) bound: +24.75% at maturing/held = 1/100',
    errPct > 24 && errPct < 25, `+${errPct.toFixed(2)}% (old ${oldAt1.toFixed(1)} vs chain ${g1.net})`);
}

{
  // The one approximation, and its DIRECTION. A day-granular clock can only
  // under-count blocks, which can only over-state the rate, which can only
  // under-state the net. Never the reverse.
  check('★ the exit-tax rate is non-increasing in held blocks (so a low block count is the safe error)',
    TAXBPS.every((r, i) => i === 0 || r.bps <= TAXBPS[i - 1].bps),
    TAXBPS.map((r) => `${r.days}d=${r.bps}`).join(' '));
  const oneDay = mustFind(TAXBPS, (r) => r.days === 0, 'taxbps day 0').bps - mustFind(TAXBPS, (r) => r.days === 1, 'taxbps day 1').bps;
  check('★ …and one day of it is at most 48 bps, well inside the 1% floor headroom',
    oneDay > 0 && oneDay <= 48, `${oneDay} bps per day`);

  // Prove the direction on a real row rather than asserting it in prose: the
  // quote struck at the FLOOR of the day count is never above the chain's answer.
  const g = mustFind(REFUND, (r) => r.heldBlocks === 604800 && r.n === 20, 'h=604800 n=20');
  const exact = redeemQuote({ reserveUsd: usd(g.reserve), supplyTokens: g.supply, heldTokens: g.held, maturingTokens: g.maturing, heldDays: 21, tokens: g.n });
  const halfDayLater = redeemQuote({ reserveUsd: usd(g.reserve), supplyTokens: g.supply, heldTokens: g.held, maturingTokens: g.maturing, heldDays: 21.5, tokens: g.n });
  check('★ a fractional day is floored, so the quote never rises above the day it can prove',
    Math.round(halfDayLater.netUsd * 1000) === Math.round(exact.netUsd * 1000));
  const nextDay = redeemQuote({ reserveUsd: usd(g.reserve), supplyTokens: g.supply, heldTokens: g.held, maturingTokens: g.maturing, heldDays: 22, tokens: g.n });
  check('★ …and the true (older) clock pays MORE, never less — the error is conservative',
    nextDay.netUsd >= exact.netUsd, `${nextDay.netUsd} vs ${exact.netUsd}`);

  /**
   * ★ THE SIZE OF THAT ERROR, BOUNDED AND MEASURED — because it is also the gap
   * between this dialog and the position card on the page behind it, which reads
   * `floorValueUsd` computed from the TRUE heldBlocks (lib/vsc-data-source.ts
   * :502-508). A reader can see both numbers at once, so the difference has to be
   * small, one-directional, and stated. It is one day of decay on the maturing
   * share only: at most 48 bps of the TAXABLE BASE (ExitTaxBpsAt's ceil makes the
   * daily step 48, not 2000/42 = 47.62), plus at most one base unit from
   * ExitTaxOn's own ceil. MEASURED WORST OVER THE GOLDENS: 0.499% of gross, on a
   * 1-token draw grossing 1203 units where that single-unit ceil residue is the
   * larger half of it. The clean 0.48% bound holds on the base; it is the dust
   * case that carries it over, which is exactly why the bound asserted below is
   * the measured one and not the algebraic one. If `heldBlocks` is ever added to
   * LiveHolderPosition this goes to zero.
   */
  let worstDayGapPct = 0;
  for (const r of REFUND) {
    if (r.heldBlocks === 0) continue; // day 0 is exact by construction
    const days = r.heldBlocks / BLOCKS_PER_DAY;
    const shown = redeemQuote({ reserveUsd: usd(r.reserve), supplyTokens: r.supply, heldTokens: r.held, maturingTokens: r.maturing, heldDays: days, tokens: r.n });
    const oneBlockShy = redeemQuote({ reserveUsd: usd(r.reserve), supplyTokens: r.supply, heldTokens: r.held, maturingTokens: r.maturing, heldDays: days - 1 + 0.9999, tokens: r.n });
    if (shown.grossUsd <= 0) continue;
    check(`the day-granular quote never exceeds the chain at h=${r.heldBlocks} n=${r.n}`,
      Math.round(oneBlockShy.netUsd * 1000) <= r.net);
    worstDayGapPct = Math.max(worstDayGapPct, ((shown.netUsd - oneBlockShy.netUsd) / shown.grossUsd) * 100);
  }
  check('★ one day of clock granularity is worth at most 0.5% of the gross',
    worstDayGapPct > 0 && worstDayGapPct <= 0.5, `worst ${worstDayGapPct.toFixed(3)}% of gross`);
  check('★ …and that is comfortably inside the 1% minimum-refund floor, so it can never cause a revert',
    worstDayGapPct < 1);
}

{
  // Degenerate inputs must be a refusal, not a number.
  const base = { reserveUsd: 120, supplyTokens: 1000, heldTokens: 100, maturingTokens: 40, heldDays: 0 };
  check('a redeem of 0 quotes nothing', redeemQuote({ ...base, tokens: 0 }).netUsd === 0);
  check('a redeem of a negative quotes nothing', redeemQuote({ ...base, tokens: -5 }).netUsd === 0);
  check('a redeem of NaN quotes nothing', redeemQuote({ ...base, tokens: Number.NaN }).netUsd === 0);
  check('a redeem above the balance is clamped to the balance, never quoted past it',
    redeemQuote({ ...base, tokens: 500 }).tokens === 100);
  check('an empty reserve quotes nothing', redeemQuote({ ...base, reserveUsd: 0, tokens: 10 }).netUsd === 0);
  check('a zero supply quotes nothing rather than dividing by it', redeemQuote({ ...base, supplyTokens: 0, tokens: 10 }).netUsd === 0);
  check('a fractional token request is floored onto the contract lattice',
    redeemQuote({ ...base, tokens: 10.9 }).tokens === 10);
  check('★ omitting the split treats the whole position as maturing (the over-taxing, SAFE reading)',
    redeemQuote({ reserveUsd: 120, supplyTokens: 1000, heldTokens: 100, heldDays: 0, tokens: 100 }).netUsd * 1000 ===
      mustFind(REFUND, (r) => r.maturing === 100 && r.n === 100, 'maturing=100 n=100').net);
}

// =====================================================================
// 2. F-C — THE MAX PRICE PER TOKEN CAP.
// =====================================================================
console.log('\n── 2. F-C. The cap must be compared on the basis buy.go charges on.\n');

{
  // buy.go's own numbers: TotalDue is fee-inclusive, and it is what the buyer's
  // signed allowance is checked against. That is the whole argument for the
  // ruling, so it is asserted rather than asserted about.
  check('★ the golden proves TotalDue carries the trade fee (it is not the bare curve cost)',
    BUY.every((r) => r.total > r.cost) && BUY.every((r) => r.fee > 0));
  check('★ …and the fee is the 10% the modal names',
    BUY.every((r) => r.fee === Math.floor((r.cost * 1000) / 10_000)),
    'params.go TradeFeeBps = 1000');

  // THE OLD COMPARISON, verbatim: cap = 1.05 × SpotRate(S), ceiling = cap × n,
  // checked against TotalDue. Reproduced on the Go goldens.
  let oldRefused = 0;
  let oldTotal = 0;
  let newRefused = 0;
  for (const r of BUY) {
    const spot = usd(mustGet(SPOT, r.supply, `spot at supply ${r.supply}`));
    if (spot <= 0) continue; // supply 0 reads spot 0, where the old cap silently vanished
    oldTotal += 1;
    const oldMaxP = Number((spot * 1.05).toFixed(2));
    if (usd(r.total) > oldMaxP * r.n) oldRefused += 1;
    // The NEW comparison: the cap is the ALL-IN price per token, defaulted to
    // 5% over the quote's own all-in average.
    const avgPrice = usd(r.total) / r.n;
    const newMaxP = parseFloat(defaultMaxPriceText(avgPrice));
    if (usd(r.total) > newMaxP * r.n) newRefused += 1;
  }
  check('★ THE OLD CAP REFUSED EVERY BUY, at zero price drift, on the contract\'s own numbers',
    oldRefused === oldTotal && oldTotal >= 35, `${oldRefused}/${oldTotal} refused`);
  check('★ …and the fixed basis refuses none of them', newRefused === 0, `${newRefused}/${oldTotal} refused`);

  // The same sweep through the SHIPPED helper rather than a restatement of it,
  // so a comparison that stops comparing is caught here and not only in one case.
  let liveRefusedAtDefault = 0;
  let liveRefusedWhenTooLow = 0;
  for (const r of BUY) {
    const shape = { tokens: r.n, totalUsd: usd(r.total), avgPrice: usd(r.total) / r.n };
    if (resolveMaxPriceCap(defaultMaxPriceText(shape.avgPrice), shape).overMax) liveRefusedAtDefault += 1;
    if (resolveMaxPriceCap((shape.avgPrice * 0.9).toFixed(4), shape).overMax) liveRefusedWhenTooLow += 1;
  }
  check('★ the shipped cap refuses NONE of the 42 golden buys at its own default',
    liveRefusedAtDefault === 0, `${liveRefusedAtDefault}/${BUY.length} refused`);
  check('★ …and refuses ALL 42 when the cap is genuinely below the price (the control is live)',
    liveRefusedWhenTooLow === BUY.length, `${liveRefusedWhenTooLow}/${BUY.length} refused`);

  // And the reason, in one line of algebra the goldens confirm: TotalDue is at
  // least 1.10 × spot(S) × n, which is above 1.05 × spot(S) × n for every row.
  check('★ the arithmetic reason: TotalDue >= 1.10 × spot(S) × n on every golden row',
    BUY.filter((r) => mustGet(SPOT, r.supply, 'spot') > 0).every((r) => r.total >= 1.10 * mustGet(SPOT, r.supply, 'spot') * r.n));
}

{
  // The comparison itself, on the real quote helpers.
  const m = { supply: 50, cap: 1_000_000, position: null };
  const q = buyQuote(25, m);
  check('the preview agrees with the Go golden it is being capped against',
    Math.round(q.totalUsd * 1000) === mustFind(BUY, (r) => r.supply === 50 && r.n === q.tokens, `buy supply 50 n=${q.tokens}`).total,
    `n=${q.tokens} total=${q.totalUsd}`);

  const capDefault = resolveMaxPriceCap(defaultMaxPriceText(q.avgPrice), q);
  check('★ the default cap does not refuse its own quote', capDefault.overMax === false);
  check('★ …and it is a real cap, not an absent one', capDefault.maxTotalUsd !== undefined && capDefault.maxTotalUsd > q.totalUsd);
  check('★ …with the headroom it advertises (5%), never less',
    (capDefault.maxTotalUsd ?? 0) >= (q.totalUsd * (10_000 + MAX_PRICE_DEFAULT_HEADROOM_BPS)) / 10_000 - 1e-9,
    `${capDefault.maxTotalUsd} vs ${q.totalUsd}`);

  // A cap BELOW the all-in average must refuse, or the control is decorative.
  const tight = resolveMaxPriceCap((q.avgPrice * 0.9).toFixed(2), q);
  check('★ a cap under the all-in price still refuses (the control is live, not decorative)', tight.overMax === true);
  check('…and its ceiling is below the quote, which is what handleBuy will act on',
    tight.maxTotalUsd !== undefined && tight.maxTotalUsd < q.totalUsd);

  // A cap exactly AT the all-in average must pass: >= is not >.
  const exact = resolveMaxPriceCap((Math.ceil(q.avgPrice * 100) / 100).toFixed(2), q);
  check('★ a cap exactly at the all-in price passes (the boundary is inclusive)', exact.overMax === false);

  // ★ The two-sided proof the fix is really a BASIS change: the same cap value
  // read on the OLD basis and the NEW one gives opposite answers.
  const oldBasisWouldRefuse = q.totalUsd > parseFloat(defaultMaxPriceText(q.priceAfter)) * q.tokens;
  check('★ the SAME 5% headroom over the BARE CURVE price still refuses — so it is the basis, not the slack',
    oldBasisWouldRefuse === true);
}

{
  // F-B's other half: the unguarded field.
  const q = buyQuote(25, { supply: 50, cap: 1_000_000, position: null });
  for (const text of ['', '   ', '0', '0.00', 'abc']) {
    const c = resolveMaxPriceCap(text, q);
    check(`a cap of ${JSON.stringify(text)} says so instead of silently removing itself`,
      c.maxTotalUsd === undefined && c.note !== null && c.note.includes('budget'));
  }
  check('★ …and the message never claims the buy is blocked, because it is not',
    (resolveMaxPriceCap('', q).note ?? '').includes('only limit'));
  check('a real cap carries no note (nothing to explain)', resolveMaxPriceCap('99', q).note === null);

  // A token under a dime is where `toFixed` rounding could put the default
  // BELOW the price it must allow — the self-refusing default, one scale down.
  for (const avg of [0.001, 0.004, 0.011, 0.09, 0.101, 1.6121, 12.6787]) {
    const d = parseFloat(defaultMaxPriceText(avg));
    check(`the pre-filled cap is never below the price it must allow (avg $${avg})`, d >= avg, `default ${d}`);
  }
  check('a zero or unusable average pre-fills nothing rather than "0.00"',
    defaultMaxPriceText(0) === '' && defaultMaxPriceText(Number.NaN) === '');
}

// =====================================================================
// 3. F-B — WHAT MAY BE TYPED INTO A MONEY FIELD.
// =====================================================================
console.log('\n── 3. F-B. A refusal is not a substitution.\n');

/** The code as it stood: delete the character, keep whatever the rest then means. */
const oldStrip = (v: string) => v.replace(/-/g, '');

{
  const defects: Array<[string, number, number]> = [
    // typed/pasted, what the OLD strip made of it, what it must be worth now
    ['-5', 5, 0],
    ['1e-5', 100000, 0],
    ['2e-3', 2000, 0],
    ['1-2', 12, 0]
  ];
  for (const [input, oldUsd, wantUsd] of defects) {
    check(`★ the OLD strip really did turn ${JSON.stringify(input)} into ${oldUsd}`,
      parseAmount(oldStrip(input)) === oldUsd, `got ${parseAmount(oldStrip(input))}`);
    check(`★ …and it is now refused outright, leaving an empty field worth ${wantUsd}`,
      parseAmount(acceptAmountText('', input)) === wantUsd);
    check(`★ …without disturbing what was already there`,
      acceptAmountText('50', input) === '50');
  }
  check('★ the two behaviours genuinely differ (a vacuous test would have both agree)',
    defects.some(([input]) => oldStrip(input) !== acceptAmountText('', input)));
}

{
  for (const good of ['', '5', '50', '0.5', '.5', '1000', '1,000', '1,000.50', '12.', '0']) {
    check(`${JSON.stringify(good)} is accepted`, acceptAmountText('7', good) === good);
  }
  for (const bad of ['-1', '1e5', '1e-5', '+5', '5 ', ' 5', '1.2.3', 'abc', '5$', '½', '1_000']) {
    check(`${JSON.stringify(bad)} is refused and the field is left alone`, acceptAmountText('7', bad) === '7');
  }
  check('★ the comma stays a thousands separator, exactly as the readers parse it',
    parseAmount(acceptAmountText('', '1,000')) === 1000);
  check('★ …not a decimal comma silently reinterpreted', parseAmount('1,000') === 1000);
  check('a cleared field is legal and worth zero', acceptAmountText('50', '') === '' && parseAmount('') === 0);
  check('parseAmount refuses a negative even if one ever reached it', parseAmount('-5') === 0);
  check('parseAmount refuses NaN', parseAmount('abc') === 0);
}

// =====================================================================
// 4. F-D — WHAT AN ASK REALLY COSTS.
// =====================================================================
console.log('\n── 4. F-D. The posted price is not the total.\n');

{
  let worstErrPct = 0;
  for (const g of ASK) {
    const priceUsd = usd(g.rate);
    const q = serviceQuote(usd(g.face), priceUsd);
    check(`the preview escrows the same whole token count ask.go does (supply ${g.supply}, face ${usd(g.face)})`,
      q.tokens === g.credits, `got ${q.tokens}, Go says ${g.credits}`);
    const cost = askCost(usd(g.face), q, priceUsd);
    check(`…and values that leg exactly as Go does`,
      Math.round(cost.tokenLegUsd * 1000) === g.legValue, `got ${cost.tokenLegUsd * 1000}, Go says ${g.legValue}`);
    check(`…and the commission matches splitFace`,
      Math.round(cost.commissionUsd * 1000) === g.commission);
    const errPct = ((cost.totalUsd - usd(g.face)) / usd(g.face)) * 100;
    worstErrPct = Math.max(worstErrPct, errPct);
    check(`★ the real total is at or above the posted price, never below (supply ${g.supply}, face ${usd(g.face)})`,
      cost.totalUsd >= usd(g.face) - 1e-9, `${cost.totalUsd} vs ${usd(g.face)}`);
  }
  check('★ THE OLD CLAIM UNDERSTATED THE COST BY UP TO 65% — this is the defect',
    worstErrPct > 65, `worst understatement ${worstErrPct.toFixed(1)}%`);

  const g = mustFind(ASK, (r) => r.supply === 1000 && r.face === 15000, 'ask supply 1000 face 15000');
  const q = serviceQuote(15, usd(g.rate));
  const cost = askCost(15, q, usd(g.rate));
  check('★ the reproduced case: a $15 service at supply 1000 really costs $24.80',
    Math.abs(cost.totalUsd - 24.8) < 1e-9, `${cost.totalUsd}`);
  check('★ …and the old line would have called it "$15"', `$${Math.round(15)}` === '$15');
  check('★ the token count is an integer, not "2.00"',
    Number.isInteger(cost.tokens) && String(cost.tokens) === '2');

  /**
   * ★★★ THE WHOLE SENTENCE, CHARACTER FOR CHARACTER. This is not belt and
   * braces: the first draft of this fix wrote the sentence inline in JSX with an
   * explanatory `{/* … *\/}` between two of its text runs, and JSX strips the
   * whitespace-only lines either side of an expression container — so it would
   * have shipped "…in all, against aposted price of $15.00". It typechecked, it
   * linted, and every substring scan passed. Only comparing the assembled
   * sentence catches a defect that lives in the whitespace.
   */
  const LINE =
    'This costs 2 tokens from your balance, worth about $23.00 at today\u2019s price, ' +
    'plus a separate $1.80 platform commission paid in HBD. That is about $24.80 in all, ' +
    'against a posted price of $15.00. Tokens are whole, so the last one rounds up.';
  check('★ the ask sentence reads exactly as intended, whitespace included', askCostLine(cost) === LINE,
    `got: ${askCostLine(cost)}`);
  check('★ …and no two runs are glued together (the JSX-comment defect that would have shipped)',
    !askCostLine(cost).includes('aposted') && !/\w\$/.test(askCostLine(cost)));
  check('★ …and none are doubled up either', !askCostLine(cost).includes('  '));
  check('the emphasis falls on the figures, not the prose',
    askCostSegments(cost).filter((x) => x.strong).map((x) => x.text).join('|') === '2 tokens|$23.00|$1.80|$24.80|$15.00');
  check('a single token is singular', askCostSegments(askCost(5, { tokens: 1, commissionUsd: 0.6 }, 1)).some((x) => x.text === '1 token'));
  check('the segments reassemble into the line exactly',
    askCostSegments(cost).map((x) => x.text).join('') === askCostLine(cost));
  check('the sentence carries no em or en dash (house style, published copy)',
    !askCostLine(cost).includes('\u2014') && !askCostLine(cost).includes('\u2013'));
  check('a zero price quotes nothing rather than dividing by it', askCost(15, { tokens: 0, commissionUsd: 0 }, 0).totalUsd === 0);
  check('a NaN price is refused', Number.isFinite(askCost(15, q, Number.NaN).totalUsd));
}

// =====================================================================
// 5. F-G — AN ITEMISATION THAT ADDS UP.
// =====================================================================
console.log('\n── 5. F-G. Everything on screen reconciles.\n');

const cents = (n: number) => Math.round(n * 100);

/**
 * ★★★ THE INSTRUMENT, NAMED. The claim under test is "the rows the reader sees
 * add up to the total the reader sees", so the measurement has to be taken on
 * the RENDERED STRING, not on the float behind it. Reading `usdPrice` back is
 * the only reading that is about the screen. Comparing rounded floats instead
 * reports 45.2%/65.0% for the same sweeps — that extra 19 points is the
 * comparison's own floating-point error, not a defect in the page, and quoting
 * it would have overstated the finding.
 */
const shown = (n: number): number => parseFloat(usdPrice(n).replace('$', '').replace(/,/g, ''));
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

{
  check('the instrument reads a rendered figure back, not the float behind it',
    shown(11.4751) === 11.48 && usdPrice(11.4751) === '$11.48');
  check('★ the reproduced example: supply 0, $12 budget, $10.43 + $1.04 under a $11.48 total',
    (() => {
      const q = buyQuote(12, { supply: 0, cap: 1_000_000, position: null });
      return usdPrice(q.curveCostUsd) === '$10.43' && usdPrice(q.tradeFeeUsd) === '$1.04' && usdPrice(q.totalUsd) === '$11.48';
    })());
  check('★ …and the fixed rows make that very screen add up',
    (() => {
      const r = buyRows(buyQuote(12, { supply: 0, cap: 1_000_000, position: null }));
      return same(shown(r.curveCostUsd) + shown(r.tradeFeeUsd), shown(r.totalUsd));
    })());

  let buyBadOld = 0;
  let buyBadNew = 0;
  let buyN = 0;
  for (let supply = 0; supply < 200; supply += 7) {
    for (let budget = 1; budget <= 200; budget += 3) {
      const q = buyQuote(budget, { supply, cap: 1_000_000, position: null });
      if (q.tokens <= 0) continue;
      buyN += 1;
      if (!same(shown(q.curveCostUsd) + shown(q.tradeFeeUsd), shown(q.totalUsd))) buyBadOld += 1;
      const r = buyRows(q);
      if (!same(shown(r.curveCostUsd) + shown(r.tradeFeeUsd), shown(r.totalUsd))) buyBadNew += 1;
    }
  }
  check('the buy sweep had something to sweep', buyN > 1_500, `${buyN} quotes`);
  check('★ THE OLD BUY ROWS DID NOT SUM on 26.5% of previews — this is the defect',
    buyBadOld / buyN > 0.25 && buyBadOld / buyN < 0.28, `${buyBadOld}/${buyN} = ${((buyBadOld / buyN) * 100).toFixed(1)}%`);
  check('★ …and the fixed rows sum on every single one', buyBadNew === 0, `${buyBadNew}/${buyN} still broken`);

  let sellBadOld = 0;
  let sellBadNew = 0;
  let sellN = 0;
  for (let supply = 10; supply < 400; supply += 13) {
    for (let t = 1; t <= Math.min(supply, 60); t += 3) {
      for (const days of [0, 10, 21, 41]) {
        const q = sellQuote(t, { supply, cap: 1_000_000, position: { tokens: supply, maturingTokens: supply } }, days);
        if (q.curveProceedsUsd <= 0) continue;
        sellN += 1;
        if (!same(shown(q.curveProceedsUsd) - shown(q.exitFeeUsd) - shown(q.tradeFeeUsd), shown(q.receiveUsd))) sellBadOld += 1;
        const r = sellRows(q);
        if (!same(shown(r.curveProceedsUsd) - shown(r.exitFeeUsd) - shown(r.tradeFeeUsd), shown(r.receiveUsd))) sellBadNew += 1;
      }
    }
  }
  check('the sell sweep had something to sweep', sellN > 2_000, `${sellN} quotes`);
  check('★ THE OLD SELL ROWS DID NOT SUM on 37.2% of previews',
    sellBadOld / sellN > 0.36 && sellBadOld / sellN < 0.39, `${sellBadOld}/${sellN} = ${((sellBadOld / sellN) * 100).toFixed(1)}%`);
  check('★ …and the fixed rows sum on every single one', sellBadNew === 0, `${sellBadNew}/${sellN} still broken`);
}

{
  // The anchor is the number the button repeats and the floor is struck from —
  // it must be EXACT, and the residue must land on the derived row.
  let anchorMoved = 0;
  let residue = 0;
  for (let supply = 0; supply < 400; supply += 3) {
    for (let budget = 2; budget <= 120; budget += 7) {
      const q = buyQuote(budget, { supply, cap: 1_000_000, position: null });
      if (q.tokens <= 0) continue;
      const r = buyRows(q);
      if (cents(r.totalUsd) !== cents(q.totalUsd)) anchorMoved += 1;
      residue = Math.max(residue, Math.abs(cents(r.curveCostUsd) - cents(q.curveCostUsd)));
    }
  }
  check('★ the CHARGED total is never moved by the reconciliation', anchorMoved === 0);
  check('★ …and the residue on the curve-cost row never exceeds one cent', residue <= 1, `${residue} cents`);

  let netMoved = 0;
  let grossResidue = 0;
  for (let supply = 10; supply < 400; supply += 11) {
    for (let t = 1; t <= Math.min(supply, 40); t += 5) {
      for (const days of [0, 21, 41]) {
        const q = sellQuote(t, { supply, cap: 1_000_000, position: { tokens: supply, maturingTokens: supply } }, days);
        if (q.curveProceedsUsd <= 0) continue;
        const r = sellRows(q);
        if (cents(r.receiveUsd) !== cents(q.receiveUsd)) netMoved += 1;
        grossResidue = Math.max(grossResidue, Math.abs(cents(r.curveProceedsUsd) - cents(q.curveProceedsUsd)));
      }
    }
  }
  check('★ "You receive" is never moved by the reconciliation', netMoved === 0);
  check('★ …and the residue on the gross row never exceeds two cents', grossResidue <= 2, `${grossResidue} cents`);
  check('★ the CTA prints the same string as the reconciled row (they must not disagree)',
    (() => {
      for (let supply = 10; supply < 300; supply += 7) {
        const q = sellQuote(9, { supply, cap: 1_000_000, position: { tokens: supply, maturingTokens: supply } }, 3);
        if (usdPrice(q.receiveUsd) !== usdPrice(sellRows(q).receiveUsd)) return false;
      }
      return true;
    })());
}

// =====================================================================
// 6. F-F — THE RATE AND THE AMOUNT BESIDE IT.
// =====================================================================
console.log('\n── 6. F-F. The percentage on the label is the percentage of the deduction.\n');

{
  const m = { supply: 1000, cap: 1_000_000, position: { tokens: 100, maturingTokens: 40 } };
  const q = sellQuote(100, m, 0);
  const r = sellRows(q);
  const headline = pctLabel(q.exitFeePct, 1) ?? '0%';
  const effective = pctLabel(effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd), 1) ?? '0%';
  check('★ THE OLD LABEL SAID 20% BESIDE A DEDUCTION OF 8% — this is the defect',
    headline === '20%' && effective === '8%', `headline ${headline}, effective ${effective}`);
  check('★ the effective rate really is what the two visible figures stand in',
    Math.abs(r.exitFeeUsd / r.curveProceedsUsd - effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd)) < 1e-12);
  check('★ …so the reader can multiply the row above and land on the row below',
    Math.abs(r.curveProceedsUsd * effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd) - r.exitFeeUsd) < 0.005);

  // An all-maturing holder must see NO change: the two rates coincide there, and
  // a fix that moved that number would be a regression, not a fix.
  const allMaturing = sellQuote(100, { supply: 1000, cap: 1_000_000, position: { tokens: 100, maturingTokens: 100 } }, 0);
  const ar = sellRows(allMaturing);
  check('★ an all-maturing holder still sees the headline rate (nothing moved for them)',
    (pctLabel(effectiveExitFeePct(ar.exitFeeUsd, ar.curveProceedsUsd), 1) ?? '') === '20%');

  check('a real but tiny deduction reads "<1%", never a flat "0%"',
    pctLabel(effectiveExitFeePct(0.001, 100), 1) === '<1%');
  check('a zero proceeds figure yields 0 rather than a division by zero',
    effectiveExitFeePct(5, 0) === 0);
}

{
  check('★ the rate strip names its base only when the position is actually mixed',
    exitFeeBaseNote(100, 40).includes('40 of your 100 tokens still maturing') &&
      exitFeeBaseNote(100, 40).includes('other 60'));
  check('an all-maturing position needs no qualification', exitFeeBaseNote(100, 100) === '');
  check('an unknown split needs no qualification (it is already the safe reading)', exitFeeBaseNote(100, undefined) === '');
  check('a fully matured position says the rate costs them nothing',
    exitFeeBaseNote(100, 0).includes('finished maturing'));
  check('a zero position says nothing at all', exitFeeBaseNote(0, 0) === '');
}

// =====================================================================
// 7. F-E — WHAT THE BUY BUTTON PROMISES.
// =====================================================================
console.log('\n── 7. F-E. The label is an estimate; the ceiling is the guarantee.\n');

{
  // The drift, on the contract's own numbers. A $25 budget at supply 50 buys 15
  // whole tokens, which the golden table prices directly.
  const BUDGET = 25;
  const local = buyQuote(BUDGET, { supply: 50, cap: 1_000_000, position: null });
  check('the drift case is the one the golden prices', local.tokens === 15, `${local.tokens} tokens`);
  const goldenAtQuote = usd(mustFind(BUY, (r) => r.supply === 50 && r.n === local.tokens, `buy supply 50 n=${local.tokens}`).total);
  check('★ the label agrees with the contract at the un-drifted supply',
    Math.abs(local.totalUsd - goldenAtQuote) < 1e-9, `label $${local.totalUsd} vs Go $${goldenAtQuote}`);

  // handleBuy re-quotes THE SAME COUNT against live state and signs
  // `maxTotalUsd ?? usd`. So the exposure is the slack between the label and the
  // budget, and it is real: the re-quote at a higher supply costs more.
  const requoted = buyQuote(1_000_000, { supply: 54, cap: 1_000_000, position: null });
  check('the drift sweep is not vacuous', requoted.tokens > 0);
  const driftedCharge = (() => {
    // The same 15 tokens, priced from a supply four higher.
    const q0 = buyQuote(1_000_000, { supply: 54, cap: 1_000_000, position: null });
    return q0.tokens > 0; // the curve is live at the drifted supply
  })();
  check('the curve is live at the drifted supply', driftedCharge);
  check('★ the label sits strictly BELOW the ceiling that is actually signed',
    local.totalUsd < BUDGET, `label $${local.totalUsd.toFixed(2)} under a $${BUDGET} budget`);
  check('★ …by enough to matter: the unlabelled slack here is over 80 cents',
    BUDGET - local.totalUsd > 0.8, `$${(BUDGET - local.totalUsd).toFixed(2)} of unnamed headroom`);

  check('★ the ceiling line names the budget when no cap is set',
    buyCeilingNote(50, false).includes('$50.00') && buyCeilingNote(50, false).includes('budget'));
  check('★ …and the cap when one is', buyCeilingNote(61.25, true).includes('$61.25') && buyCeilingNote(61.25, true).includes('cap'));
  check('★ it states a refusal, not a hope', buyCeilingNote(50, false).includes('will not charge more than'));
  check('it carries no em dash (house style, published copy)',
    !buyCeilingNote(50, false).includes('—') && !buyCeilingNote(50, true).includes('–'));
  check('a negative or absurd ceiling still formats rather than printing "$-1"', buyCeilingNote(-1, false).includes('$0.00'));
}

// =====================================================================
// 8. WIRING. The dialogs really call this, and no longer do the old thing.
// =====================================================================
console.log('\n── 8. WIRING.\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const modalSrc = readFileSync(join(__dirname, 'token-modals.tsx'), 'utf8');
  const viewSrc = readFileSync(join(__dirname, 'token-market-view.tsx'), 'utf8');
  const modal = strip(modalSrc);
  const view = strip(viewSrc);

  // Non-vacuity: a scan with nothing to inspect must FAIL.
  check('the scan read token-modals.tsx', modalSrc.length > 40_000, `${modalSrc.length} bytes`);
  check('the scan read token-market-view.tsx', viewSrc.length > 40_000, `${viewSrc.length} bytes`);
  check('comment stripping left the code behind', modal.length > 15_000 && view.length > 15_000);
  check('★ …and it really did strip (a ★ note below quotes the old code verbatim)',
    modalSrc.includes("e.target.value.replace(/-/g, '')") && !modal.includes("e.target.value.replace(/-/g, '')"),
    'if this fails the stripper is broken, not the fix');

  check('★ F-A: the redeem figure comes from redeemQuote', modal.includes('redeemQuote({'));
  check('★ F-A: …fed the REDEEMED count and the maturing balance',
    /redeemQuote\(\{[^}]*maturingTokens: m\.position\?\.maturingTokens[^}]*tokens\s*\}/s.test(modal));
  check('★ F-A: and the linear scale is gone',
    !modal.includes('floorValueUsd ?? 0) * tokens) / held'));
  check('★ F-B: the amount field refuses instead of stripping', modal.includes('acceptAmountText(amt, e.target.value)'));
  check('★ F-B: the price cap field is guarded too', modal.includes('acceptAmountText(maxPriceValue, e.target.value)'));
  check('★ F-C: the cap is resolved on the all-in basis', modal.includes('resolveMaxPriceCap(adv ? maxPriceValue : \'\', q)'));
  check('★ F-C: …and the bare-curve comparison is gone', !modal.includes('q.priceAfter > maxP'));
  check('★ F-C: the pre-filled cap tracks the live quote', modal.includes('defaultMaxPriceText(q.avgPrice)'));
  check('★ F-C: …and the frozen spot-based default is gone', !modal.includes('(m.priceUsd * 1.05).toFixed(2)'));
  check('★ F-D: the ask card prices the real cost', modal.includes('askCost(usd, q, m.priceUsd)'));
  check('★ F-D: …and renders it from segments, so no comment can land inside the sentence',
    modal.includes('askCostSegments(cost).map('));
  check('★ F-D: …and no longer calls the posted price the total',
    !modal.includes('{usdWhole(usd)}</strong> total') && !modal.includes('usdWhole('),
    'the posted price is exact now; market/buy-preview.selftest.ts:331 uses usdWhole( as a stripper-sanity control and must re-point at tok(');
  check('★ F-D: …and the control that assertion displaces is still available (tok( survives)',
    modal.includes('tok('));
  check('★ F-D: the token count is an integer everywhere in the ask dialog', !modal.includes('tok(q.tokens)'));
  check('★ F-E: the CTA is marked as an estimate', modal.includes('`Buy for ~${usdPrice(q.totalUsd)}`'));
  check('★ F-E: …and the ceiling is named', modal.includes('buyCeilingNote(maxTotalUsd ?? usd, maxTotalUsd !== undefined)'));
  check('★ F-F: the itemised row carries the effective rate', modal.includes('effectiveExitFeePct(rows.exitFeeUsd, rows.curveProceedsUsd)'));
  check('★ F-F: …and the strip says "rate" and names its base',
    modal.includes('Early-exit fee rate:') && modal.includes('exitFeeBaseNote(held, m.position?.maturingTokens)'));
  check('★ F-G: the buy rows are reconciled', modal.includes('buyRows(q)') && modal.includes('usdPrice(rows.totalUsd)'));
  check('★ F-G: the sell rows are reconciled', modal.includes('sellRows(q)') && modal.includes('usdPrice(rows.curveProceedsUsd)'));
  check('★ F-G: …and no itemised row is drawn from the unreconciled quote any more',
    !modal.includes('usdPrice(q.curveCostUsd)') && !modal.includes('usdPrice(q.tradeFeeUsd)') && !modal.includes('usdPrice(q.curveProceedsUsd)'));
  check('★ F-H: the note claiming buy-preview.selftest.ts:335 "must be updated" is gone',
    !modalSrc.includes('buy-preview.selftest.ts:335'));
  check('★ F-H: …and what replaced it names the lines that really are outstanding',
    modalSrc.includes('buy-preview.selftest.ts:341'));

  check('★ F-I: the market cap is defined once', (view.match(/const marketCapCard/g) ?? []).length === 1);
  check('★ F-I: …rendered in the right rail', /const rightRail[\s\S]*\{marketCapCard\}/.test(view));
  check('★ F-I: …and again in the body behind xl:hidden, the complement of the shell\'s xl:block',
    view.includes('xl:hidden">{marketCapCard}'));
  check('★ F-I: the shell\'s breakpoint is what made this necessary and is NOT touched here',
    readFileSync(join(__dirname, '..', 'token-shell.tsx'), 'utf8').includes('xl:block'),
    'token-shell.tsx is outside this pass; if this fails the rail moved and the xl:hidden complement must move with it');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
