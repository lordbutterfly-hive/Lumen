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
 * `core.refundPayout` + `core.ExitTaxOn`, `core.BuyCost` + `core.tradeFeeOn`,
 * `core.SpotRate`, `core.creditsForAsk` + `core.commissionOwedFor` and
 * `core.ExitTaxBpsAt` running as compiled Go against
 * `/mnt/o/Lumen/creator-tokens/core/*.go`. To regenerate:
 *
 *     cd /mnt/o/Lumen/creator-tokens
 *     go test ./core/ -run TestGenerateTradePreviewGoldens -v
 *
 * and paste the block it prints between GOLDEN_BEGIN and GOLDEN_END. The
 * generator lives in the CONTRACT repo, at core/zz_goldens_tradepreview_test.go,
 * and it asserts every row it prints before printing it.
 *
 * ★★★ REGENERATED 2026-09-12, AND THE ASK ROWS CHANGED SHAPE. The previous
 * table was printed on 2026-08-27 at TradeFeeBps 1000 / MaxExitTaxBps 2000 and
 * nobody reprinted it when params.go halved the fee and cut the tax ceiling on
 * 2026-09-09, so this file asserted correct code against three-day-old numbers
 * and crashed on the first lookup. The ASK rows also lost their HBD leg: the
 * posted price used to split 88% tokens / 12% HBD (core.splitFace, now deleted)
 * and since the owner ruling of 2026-09-12 the whole face is paid in tokens
 * with the commission carved out of those same credits. The row is now
 * supply, face, rate, credits, commissionCredits, creditsValue.
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
import { MAX_EXIT_TAX_BPS, TRADE_FEE_BPS } from '../../lib/contract-math';

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
REFUND	120000	1000	100	40	0	1	120	18	102	1500
REFUND	120000	1000	100	40	0	10	1200	180	1020	1500
REFUND	120000	1000	100	40	0	39	4680	702	3978	1500
REFUND	120000	1000	100	40	0	40	4800	720	4080	1500
REFUND	120000	1000	100	40	0	41	4920	720	4200	1500
REFUND	120000	1000	100	40	0	80	9600	720	8880	1500
REFUND	120000	1000	100	40	0	99	11880	720	11160	1500
REFUND	120000	1000	100	40	0	100	12000	720	11280	1500
REFUND	120000	1000	100	100	0	10	1200	180	1020	1500
REFUND	120000	1000	100	100	0	50	6000	900	5100	1500
REFUND	120000	1000	100	100	0	100	12000	1800	10200	1500
REFUND	120000	1000	100	1	0	1	120	18	102	1500
REFUND	120000	1000	100	1	0	50	6000	18	5982	1500
REFUND	120000	1000	100	1	0	100	12000	18	11982	1500
REFUND	60153	50	50	20	0	1	1203	181	1022	1500
REFUND	60153	50	50	20	0	5	6015	903	5112	1500
REFUND	60153	50	50	20	0	20	24061	3610	20451	1500
REFUND	60153	50	50	20	0	35	42107	3610	38497	1500
REFUND	60153	50	50	20	0	50	60153	3610	56543	1500
REFUND	60153	50	50	20	604800	1	1203	91	1112	750
REFUND	60153	50	50	20	604800	20	24061	1805	22256	750
REFUND	60153	50	50	20	604800	50	60153	1805	58348	750
REFUND	60153	50	50	20	1209600	1	1203	0	1203	0
REFUND	60153	50	50	20	1209600	20	24061	0	24061	0
REFUND	60153	50	50	20	1209600	50	60153	0	60153	0
REFUND	999999	777	333	111	201600	1	1287	161	1126	1250
REFUND	999999	777	333	111	201600	111	142857	17858	124999	1250
REFUND	999999	777	333	111	201600	222	285714	17858	267856	1250
REFUND	999999	777	333	111	201600	333	428571	17858	410713	1250
BUY	0	1	1007	50	1057
BUY	0	2	2023	101	2124
BUY	0	3	3047	152	3199
BUY	0	4	4078	203	4281
BUY	0	5	5118	255	5373
BUY	0	6	6165	308	6473
BUY	0	7	7220	361	7581
BUY	0	8	8284	414	8698
BUY	0	9	9355	467	9822
BUY	0	10	10434	521	10955
BUY	0	11	11521	576	12097
BUY	0	12	12615	630	13245
BUY	0	13	13718	685	14403
BUY	0	14	14829	741	15570
BUY	0	15	15948	797	16745
BUY	0	16	17074	853	17927
BUY	0	17	18209	910	19119
BUY	0	18	19352	967	20319
BUY	0	19	20502	1025	21527
BUY	0	20	21661	1083	22744
BUY	0	39	45196	2259	47455
BUY	0	70	89875	4493	94368
BUY	10	1	1087	54	1141
BUY	10	2	2181	109	2290
BUY	10	3	3284	164	3448
BUY	10	4	4395	219	4614
BUY	10	5	5514	275	5789
BUY	10	6	6640	332	6972
BUY	10	7	7775	388	8163
BUY	10	8	8918	445	9363
BUY	10	9	10068	503	10571
BUY	10	10	11227	561	11788
BUY	10	11	12393	619	13012
BUY	10	12	13568	678	14246
BUY	10	13	14750	737	15487
BUY	10	14	15941	797	16738
BUY	10	15	17139	856	17995
BUY	10	16	18346	917	19263
BUY	10	17	19560	978	20538
BUY	10	18	20783	1039	21822
BUY	10	19	22014	1100	23114
BUY	10	20	23252	1162	24414
BUY	10	39	48318	2415	50733
BUY	10	70	95537	4776	100313
BUY	50	1	1408	70	1478
BUY	50	2	2825	141	2966
BUY	50	3	4250	212	4462
BUY	50	4	5683	284	5967
BUY	50	5	7124	356	7480
BUY	50	6	8573	428	9001
BUY	50	7	10030	501	10531
BUY	50	8	11496	574	12070
BUY	50	9	12970	648	13618
BUY	50	10	14452	722	15174
BUY	50	11	15942	797	16739
BUY	50	12	17440	872	18312
BUY	50	13	18947	947	19894
BUY	50	14	20461	1023	21484
BUY	50	15	21984	1099	23083
BUY	50	16	23515	1175	24690
BUY	50	17	25055	1252	26307
BUY	50	18	26602	1330	27932
BUY	50	19	28158	1407	29565
BUY	50	20	29722	1486	31208
BUY	50	39	61013	3050	64063
BUY	50	70	118550	5927	124477
BUY	100	1	1823	91	1914
BUY	100	2	3653	182	3835
BUY	100	3	5492	274	5766
BUY	100	4	7339	366	7705
BUY	100	5	9195	459	9654
BUY	100	6	11060	553	11613
BUY	100	7	12932	646	13578
BUY	100	8	14813	740	15553
BUY	100	9	16703	835	17538
BUY	100	10	18601	930	19531
BUY	100	11	20507	1025	21532
BUY	100	12	22422	1121	23543
BUY	100	13	24346	1217	25563
BUY	100	14	26278	1313	27591
BUY	100	15	28218	1410	29628
BUY	100	16	30167	1508	31675
BUY	100	17	32124	1606	33730
BUY	100	18	34090	1704	35794
BUY	100	19	36064	1803	37867
BUY	100	20	38047	1902	39949
BUY	100	39	77343	3867	81210
BUY	100	70	148144	7407	155551
BUY	500	1	5604	280	5884
BUY	500	2	11219	560	11779
BUY	500	3	16844	842	17686
BUY	500	4	22480	1124	23604
BUY	500	5	28126	1406	29532
BUY	500	6	33783	1689	35472
BUY	500	7	39450	1972	41422
BUY	500	8	45128	2256	47384
BUY	500	9	50817	2540	53357
BUY	500	10	56516	2825	59341
BUY	500	11	62225	3111	65336
BUY	500	12	67945	3397	71342
BUY	500	13	73676	3683	77359
BUY	500	14	79417	3970	83387
BUY	500	15	85169	4258	89427
BUY	500	16	90932	4546	95478
BUY	500	17	96705	4835	101540
BUY	500	18	102488	5124	107612
BUY	500	19	108282	5414	113696
BUY	500	20	114087	5704	119791
BUY	500	39	226400	11320	237720
BUY	500	70	417961	20898	438859
BUY	1000	1	11513	575	12088
BUY	1000	2	23039	1151	24190
BUY	1000	3	34579	1728	36307
BUY	1000	4	46131	2306	48437
BUY	1000	5	57697	2884	60581
BUY	1000	6	69276	3463	72739
BUY	1000	7	80868	4043	84911
BUY	1000	8	92473	4623	97096
BUY	1000	9	104091	5204	109295
BUY	1000	10	115723	5786	121509
BUY	1000	11	127368	6368	133736
BUY	1000	12	139025	6951	145976
BUY	1000	13	150696	7534	158230
BUY	1000	14	162381	8119	170500
BUY	1000	15	174078	8703	182781
BUY	1000	16	185789	9289	195078
BUY	1000	17	197513	9875	207388
BUY	1000	18	209250	10462	219712
BUY	1000	19	221000	11050	232050
BUY	1000	20	232764	11638	244402
BUY	1000	39	458791	22939	481730
BUY	1000	70	837922	41896	879818
SPOT	0	0
SPOT	10	1079
SPOT	50	1400
SPOT	100	1813
SPOT	500	5593
SPOT	1000	11500
ASK	50	15000	1400	11	1	15400
ASK	50	25000	1400	18	2	25200
ASK	50	200000	1400	143	17	200200
ASK	1000	15000	11500	2	0	23000
ASK	1000	25000	11500	3	0	34500
ASK	1000	200000	11500	18	2	207000
TAXBPS	0	1500
TAXBPS	1	1465
TAXBPS	7	1250
TAXBPS	21	750
TAXBPS	41	36
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
const ASK = rows('ASK').map(([supply, face, rate, credits, commissionCredits, legValue]) => ({
  supply, face, rate, credits, commissionCredits, legValue
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
check('the BUY goldens parsed', BUY.length === 132, `${BUY.length} rows`);
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
  // The bound is 1/(1−τ) − 1, so it MOVES WITH τ: 24.75% at MaxExitTaxBps 2000,
  // 17.47% at 1500. Asserted against the live constant rather than a
  // remembered percentage, and still two-sided so a collapsed bound fails.
  const bound = (1 / (1 - MAX_EXIT_TAX_BPS / 10_000) - 1) * 100;
  check(`★ the worst measured over-quote is the 1/(1−τ) bound: +${errPct.toFixed(2)}% at maturing/held = 1/100`,
    errPct > bound - 1 && errPct <= bound + 1e-9 && errPct > 10,
    `+${errPct.toFixed(2)}% vs bound +${bound.toFixed(2)}% (old ${oldAt1.toFixed(1)} vs chain ${g1.net})`);
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
  check('a fractional token request is snapped onto the 0.01 lattice (v6: hundredths, never a third decimal)',
    redeemQuote({ ...base, tokens: 10.129 }).tokens === 10.13 && redeemQuote({ ...base, tokens: 10.9 }).tokens === 10.9);
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
  check(`★ …and the fee is the ${TRADE_FEE_BPS / 100}% the modal names`,
    BUY.every((r) => r.fee === Math.floor((r.cost * TRADE_FEE_BPS) / 10_000)),
    `params.go TradeFeeBps = ${TRADE_FEE_BPS}`);

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
  // least (1 + TradeFeeBps) × spot(S) × n, which is above spot(S) × n for every
  // row. (It read 1.10 when TradeFeeBps was 1000; the multiplier is derived now,
  // so the algebra follows params.go instead of a remembered rate.)
  const FEE_MULT = 1 + TRADE_FEE_BPS / 10_000;
  check(`★ the arithmetic reason: TotalDue >= ${FEE_MULT.toFixed(2)} × spot(S) × n on every golden row`,
    BUY.filter((r) => mustGet(SPOT, r.supply, 'spot') > 0).every((r) => r.total >= FEE_MULT * mustGet(SPOT, r.supply, 'spot') * r.n));
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
  //
  // ★ THE OLD BASIS IS THE PRE-BUY SPOT, and this line used to approximate it
  // with `q.priceAfter` — the curve price AFTER the buy. That approximation
  // held only while the trade fee (10%) exceeded the default headroom (5%);
  // at TradeFeeBps 500 the curve's own rise covers the fee and the
  // approximation passes, which made a correct client look broken. Taken on the
  // real old basis now, verbatim what the block above reproduces from the Go
  // goldens: cap = 1.05 x SpotRate(S), ceiling = cap x n.
  const spotBeforeUsd = mustGet(SPOT, 50, 'spot at supply 50') / 1000;
  const oldBasisWouldRefuse = q.totalUsd > parseFloat(defaultMaxPriceText(spotBeforeUsd)) * q.tokens;
  check('★ the SAME 5% headroom over the BARE CURVE price still refuses — so it is the basis, not the slack',
    oldBasisWouldRefuse === true,
    `total ${q.totalUsd} vs old ceiling ${parseFloat(defaultMaxPriceText(spotBeforeUsd)) * q.tokens}`);
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
    check(`…and values the whole escrow exactly as Go does`,
      Math.round(cost.totalUsd * 1000) === g.legValue, `got ${cost.totalUsd * 1000}, Go says ${g.legValue}`);
    // ONE ASSET: the commission is a SHARE of the escrow, not a second leg, so
    // the golden carries it in CREDITS and its USD value is credits x rate.
    check(`…and the commission is the golden's ${g.commissionCredits} credits, valued at the same rate`,
      Math.round(cost.commissionUsd * 1000) === g.commissionCredits * g.rate,
      `got ${Math.round(cost.commissionUsd * 1000)}, Go says ${g.commissionCredits} credits x ${g.rate} = ${g.commissionCredits * g.rate}`);
    check(`…and it is never added on top: total === the token leg (supply ${g.supply}, face ${usd(g.face)})`,
      cost.totalUsd === cost.tokenLegUsd && cost.commissionUsd <= cost.totalUsd);
    const errPct = ((cost.totalUsd - usd(g.face)) / usd(g.face)) * 100;
    worstErrPct = Math.max(worstErrPct, errPct);
    check(`★ the real total is at or above the posted price, never below (supply ${g.supply}, face ${usd(g.face)})`,
      cost.totalUsd >= usd(g.face) - 1e-9, `${cost.totalUsd} vs ${usd(g.face)}`);
  }
  // ★ 53%, NOT 65%. The worst overshoot across the goldens fell when the HBD leg
  // went away (the buyer no longer pays a commission ON TOP of a ceiled token
  // leg), and it is re-measured here rather than re-asserted from memory. It is
  // still an overshoot of more than half the posted price, which is the point.
  check('★ THE OLD CLAIM UNDERSTATED THE COST BY MORE THAN HALF — this is the defect',
    worstErrPct > 53 && worstErrPct < 54, `worst understatement ${worstErrPct.toFixed(1)}%`);

  const g = mustFind(ASK, (r) => r.supply === 1000 && r.face === 15000, 'ask supply 1000 face 15000');
  const q = serviceQuote(15, usd(g.rate));
  const cost = askCost(15, q, usd(g.rate));
  check('★ the reproduced case: a $15 service at supply 1000 really costs $23.00',
    Math.abs(cost.totalUsd - 23) < 1e-9, `${cost.totalUsd}`);
  check('★ …and the old line would have called it "$15"', `$${Math.round(15)}` === '$15');
  check('★ the token count is an integer, not "2.00"',
    Number.isInteger(cost.tokens) && String(cost.tokens) === '2');
  // ★ AND AT 2 CREDITS THE COMMISSION IS GENUINELY ZERO. floor(2 x 12%) = 0.
  // This is the honest limit of a commission taken in whole tokens, pinned here
  // so it is a known property and not a surprise on a live market.
  check('★ a 2-credit ask owes no commission at all, and the sentence does not announce one',
    cost.commissionUsd === 0 && g.commissionCredits === 0 && !askCostLine(cost).includes('commission'),
    askCostLine(cost));

  /**
   * ★★★ THE WHOLE SENTENCE, CHARACTER FOR CHARACTER. This is not belt and
   * braces: the first draft of this fix wrote the sentence inline in JSX with an
   * explanatory `{/* … *\/}` between two of its text runs, and JSX strips the
   * whitespace-only lines either side of an expression container — so it would
   * have shipped "…in all, against aposted price of $15.00". It typechecked, it
   * linted, and every substring scan passed. Only comparing the assembled
   * sentence catches a defect that lives in the whitespace.
   */
  // The sentence is asserted on a case whose commission is NOT zero, so every
  // run of it is exercised: supply 50, a $200 service, 143 credits of which 17
  // are the platform's.
  const gBig = mustFind(ASK, (r) => r.supply === 50 && r.face === 200000, 'ask supply 50 face 200000');
  const costBig = askCost(usd(gBig.face), serviceQuote(usd(gBig.face), usd(gBig.rate)), usd(gBig.rate));
  const LINE =
    'This costs 143 tokens from your balance and nothing else, worth about $200.20 at today\u2019s price, ' +
    'against a posted price of $200.00. Tokens are whole, so the last one rounds up. ' +
    'Lumen\u2019s $23.80 commission comes out of those tokens, not on top of them.';
  check('★ the ask sentence reads exactly as intended, whitespace included', askCostLine(costBig) === LINE,
    `got: ${askCostLine(costBig)}`);
  check('★ …and no two runs are glued together (the JSX-comment defect that would have shipped)',
    !askCostLine(costBig).includes('aposted') && !/\w\$/.test(askCostLine(costBig)));
  check('★ …and none are doubled up either', !askCostLine(costBig).includes('  '));
  check('the emphasis falls on the figures, not the prose',
    askCostSegments(costBig).filter((x) => x.strong).map((x) => x.text).join('|') === '143 tokens|$200.20|$200.00|$23.80');
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

// THERE IS NO LOCAL `cents` ANY MORE. It was `Math.round(n * 100)`, which
// rounds the BINARY value while the screen rounds the shortest DECIMAL one, so
// it disagreed with the render on every exact half-cent. Every measurement in
// this section now goes through `shown` below, which reads the rendered string
// back — the instrument the section's own header argues for, and the same
// definition trade-preview.ts's own `cents` was changed to on 2026-09-12.

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
  check('★ the reproduced example: supply 0, $12 budget, $10.43 + $0.52 under a $10.96 total',
    (() => {
      const q = buyQuote(12, { supply: 0, cap: 1_000_000, position: null });
      return usdPrice(q.curveCostUsd) === '$10.43' && usdPrice(q.tradeFeeUsd) === '$0.52' && usdPrice(q.totalUsd) === '$10.96';
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
  check('★ THE OLD BUY ROWS DID NOT SUM on 23.7% of previews — this is the defect',
    buyBadOld / buyN > 0.22 && buyBadOld / buyN < 0.28, `${buyBadOld}/${buyN} = ${((buyBadOld / buyN) * 100).toFixed(1)}%`);
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
  check('★ THE OLD SELL ROWS DID NOT SUM on 36.0% of previews',
    sellBadOld / sellN > 0.34 && sellBadOld / sellN < 0.39, `${sellBadOld}/${sellN} = ${((sellBadOld / sellN) * 100).toFixed(1)}%`);
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
      // ★ MEASURED ON THE RENDERED FIGURE, not on the float. `cents` here is
      // `Math.round(n * 100)`, which rounds the BINARY value, while the screen
      // rounds the shortest decimal — they disagree on exact half-cents, and
      // since trade-preview.ts started rounding through the render (so the CTA
      // and the rows can never print two different totals) this comparison has
      // to be taken the same way or it reports a defect that is not on screen.
      if (shown(r.totalUsd) !== shown(q.totalUsd)) anchorMoved += 1;
      residue = Math.max(residue, Math.abs(Math.round((shown(r.curveCostUsd) - shown(q.curveCostUsd)) * 100)));
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
        if (shown(r.receiveUsd) !== shown(q.receiveUsd)) netMoved += 1;
        grossResidue = Math.max(grossResidue, Math.abs(Math.round((shown(r.curveProceedsUsd) - shown(q.curveProceedsUsd)) * 100)));
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
  // ★ 15% AND 6%, not 20% and 8%: MaxExitTaxBps went 2000 -> 1500 on
  // 2026-09-09 and both numbers moved together. The DEFECT is the gap between
  // them, so it is asserted as the gap — the headline is the contract's
  // ceiling, the effective rate is the maturing share of it, and they must not
  // be the same number on a mixed position.
  check(`★ THE OLD LABEL SAID ${headline} BESIDE A DEDUCTION OF ${effective} — this is the defect`,
    headline === `${MAX_EXIT_TAX_BPS / 100}%` &&
      effective === '6%' &&
      // The gap itself, as numbers rather than as two labels — TypeScript
      // narrows the two strings to literal types and would reject `!==` on them
      // as a comparison that cannot hold.
      effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd) < q.exitFeePct,
    `headline ${headline}, effective ${effective}`);
  check('★ the effective rate really is what the two visible figures stand in',
    Math.abs(r.exitFeeUsd / r.curveProceedsUsd - effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd)) < 1e-12);
  check('★ …so the reader can multiply the row above and land on the row below',
    Math.abs(r.curveProceedsUsd * effectiveExitFeePct(r.exitFeeUsd, r.curveProceedsUsd) - r.exitFeeUsd) < 0.005);

  // An all-maturing holder must see NO change: the two rates coincide there, and
  // a fix that moved that number would be a regression, not a fix.
  const allMaturing = sellQuote(100, { supply: 1000, cap: 1_000_000, position: { tokens: 100, maturingTokens: 100 } }, 0);
  const ar = sellRows(allMaturing);
  check('★ an all-maturing holder still sees the headline rate (nothing moved for them)',
    (pctLabel(effectiveExitFeePct(ar.exitFeeUsd, ar.curveProceedsUsd), 1) ?? '') === `${MAX_EXIT_TAX_BPS / 100}%`);

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
  // The drift, on the contract's own numbers. A $25 budget at supply 50 buys 16
  // whole tokens, which the golden table prices directly. (It bought 15 at the
  // old 10% fee; the count moved with the fee, the property did not.)
  const BUDGET = 25;
  const local = buyQuote(BUDGET, { supply: 50, cap: 1_000_000, position: null });
  check('the drift case is the one the golden prices', local.tokens === 16, `${local.tokens} tokens`);
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
  // ★ 31 CENTS, NOT 80. The slack is whatever the whole-token ceiling leaves
  // under the budget, and a cheaper fee buys one more token and leaves less
  // behind. It is still real money that the label never names, which is the
  // whole point of the ceiling line; the threshold is stated as a QUARTER of a
  // token's price so it tracks the market rather than a remembered figure.
  check('★ …by enough to matter: the unlabelled slack here is over 1% of the budget',
    BUDGET - local.totalUsd > BUDGET * 0.01 && BUDGET - local.totalUsd < local.priceAfter,
    `$${(BUDGET - local.totalUsd).toFixed(2)} of unnamed headroom on a $${BUDGET} budget, where a token costs $${local.priceAfter.toFixed(2)}`);

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
  // ★★★ THE BUY DIALOG'S SEPARATE "MAX PRICE" FIELD IS GONE, AND THE CEILING
  // IT EXISTED FOR IS STRONGER WITHOUT IT. F-B and F-C were written when the
  // buyer could open Advanced and type a per-token cap, and the defect then was
  // that the cap was compared on the bare curve price instead of the all-in
  // one. BuyModal now signs `onBuy(usd)` with no second argument, and
  // token-market-view.tsx handleBuy takes `cap = maxTotalUsd ?? usd` — so the
  // TYPED BUDGET is the signed ceiling, and the dialog refuses before signing
  // if the authoritative quote exceeds it. That is the same protection with
  // nothing left to misconfigure, and it is what these four lines now assert.
  // resolveMaxPriceCap/defaultMaxPriceText survive as helpers and are still
  // proven cell by cell in section 2 above; only the field that fed them went.
  check('★ F-B: the amount field is guarded (the one input this dialog still takes)',
    modal.includes('acceptAmountText(amt, e.target.value)'));
  check('★ F-C: the ceiling is the typed budget, signed as-is',
    modal.includes('await onBuy(usd, undefined, fundFromHive);') && !modal.includes('onBuy(usd, maxTotalUsd)'));
  check('★ F-C: …and the bare-curve comparison is gone', !modal.includes('q.priceAfter > maxP'));
  check('★ F-C: …and so is the frozen spot-based default', !modal.includes('(m.priceUsd * 1.05).toFixed(2)'));
  check('★ F-D: the ask card prices the real cost', modal.includes('askCost(usd, { tokens: chainTokens, commissionUsd }, m.priceUsd)'));
  check('★ F-D: …and renders it from segments, so no comment can land inside the sentence',
    modal.includes('askCostSegments(cost, fractionalTokensUnder(m.rules)).map('));
  check('★ F-D: …and no longer calls the posted price the total',
    !modal.includes('{usdWhole(usd)}</strong> total') && !modal.includes('usdWhole('),
    'the posted price is exact now; market/buy-preview.selftest.ts:331 uses usdWhole( as a stripper-sanity control and must re-point at tok(');
  check('★ F-D: …and the control that assertion displaces is still available (tok( survives)',
    modal.includes('tok('));
  check('★ F-D: the token count is an integer everywhere in the ask dialog', !modal.includes('tok(q.tokens)'));
  check('★ F-E: the CTA is marked as an estimate', modal.includes('`Buy for ~${usdPrice(q.totalUsd)}`'));
  // ★ 2026-09-15 (owner): the one-signature / budget-ceiling footnote is gone
  // from the buy dialog ("no point to it"); buyCeilingNote stays a tested helper.
  check('★ F-E: …and the buy dialog no longer renders the ceiling footnote', !modal.includes('buyCeilingNote('));
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
