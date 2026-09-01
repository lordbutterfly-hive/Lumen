/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * F1 + F2 self-test — THE SELL PATH MUST SEE BOTH BUCKETS.
 *
 * apps/blog has no unit test runner wired (see lib/vsc/payload-contract.selftest.ts's
 * own header for the full audit of why). This follows the established fallback and
 * matches market/curve.selftest.ts's shape exactly: a plain script, a `check()`
 * helper, an `n/m checks passed` tail, `process.exit(1)` on failure.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/lib/sell-two-buckets.selftest.ts
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES
 * ---------------------------------------------------------------------------
 * F1 (funds locked). core/sell.go:189 gates a sell on `totalBalance(s, creator,
 * caller)`, which core/matured.go:145 defines as `mAdd(getMoney(s, kBal(c,h)),
 * getMatured(s,c,h))` — MATURING + MATURED. `quoteSell` requested `kBal` alone,
 * and `kBal` is the maturing bucket ONLY: core/matured.go:406 `graduate` does
 * `s.Delete(kBal(c, h))` the moment a position matures. `toU64` returns 0 for a
 * missing key (lib/vsc/reads.ts:274), so a fully-graduated holder read back as
 * owning nothing and every sell was refused — not just in preview: `sell()`
 * (vsc-data-source.ts) calls `quoteSell` first and lets the throw propagate, so
 * the broadcast never happened. Check group A is that holder.
 *
 * F1b (the same holder's RATE). `graduate` also deletes `kAcqBlock`
 * (core/matured.go:407), and holdclock.go:207-226 has an explicit branch for it:
 * with nothing maturing and a matured balance present, the honest clock is the
 * FULL window, not zero. Without that branch the quote a seller signs against
 * announces the maximum 20% rate on a holder who owes exactly nothing —
 * holdclock.go:208-224 names "the quote UI that RULING F makes mandatory before
 * signing" as one of the four consumers it inverted.
 *
 * F2 (tax over-charged). core/sell.go:234-236 taxes only
 * `maturingGrossShare(p, fromMaturing, ΔS)`, not the whole gross.
 * `quoteSellBaseUnits` taxed the whole gross. Check groups C/D/E.
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT
 * ---------------------------------------------------------------------------
 * Every expected number below comes from an INDEPENDENT re-derivation of the Go
 * source in BigInt (the `go*` functions), built from core/params.go's literal
 * constants and core/curve.go / core/exittax.go / core/matured.go's formulas —
 * never by calling the TypeScript under test. Check group 0 validates that
 * instrument against a number core/curve_test.go:124 pins independently
 * (BuyCost(0,1) == 1007) and against the three figures measured by hand for this
 * defect (217,179 / 86,872 / 130,307). A reference implementation that agrees
 * with the code it is grading proves nothing; this one is anchored outside it.
 *
 * Assertions on money are EXACT integer base units. No tolerance anywhere.
 */

import { VscCreatorTokensDataSource } from './vsc-data-source';
import type { CustomJsonOp } from './vsc/op-builders';
import type { CreatorTokensGqlClient } from './vsc/reads';
import { kAcqBlock, kBal, kMatured, kPaidUntil, kRegisteredAt, kRetiredAt, kState, kSupply, toU64 } from './vsc/reads';
import { EXIT_TAX_DECAY_BLOCKS, quoteSellBaseUnits, exitTaxOnBaseUnits, exitTaxBpsAt, sellProceedsBaseUnits, tradeFeeOn } from './contract-math';
import { sellQuote } from '../market/curve';

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
// THE INSTRUMENT — core/*.go re-derived in BigInt, independently of the
// TypeScript under test. Constants are the literals in core/params.go.
// =====================================================================
const GO_BASE_PRICE = 1000n; // params.go:449 BasePrice
const GO_LIN = 63000n; //        params.go:453 CurveLinNum
const GO_QUAD = 21n; //          params.go:459 CurveQuadNum
const GO_DEN = 8000n; //         params.go:468 CurveDenom
const GO_TRADE_FEE_BPS = 1000n; // params.go:490 TradeFeeBps
const GO_MAX_EXIT_TAX_BPS = 2000n; // params.go:537 MaxExitTaxBps
const GO_BLOCKS_PER_DAY = 28800n; // params.go:9 BlocksPerDay
const GO_EXIT_TAX_DECAY_BLOCKS = 42n * GO_BLOCKS_PER_DAY; // params.go:544

/** util.go mMulDivCeil, for strictly positive denominators. */
function goMulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return (p + d - 1n) / d;
}

/** curve.go Area(S) = S·BasePrice + floor((63000·T(S) + 21·P(S))/8000). */
function goArea(S: bigint): bigint {
  if (S <= 0n) return 0n;
  const T = (S * (S + 1n)) / 2n;
  const P = (S * (S + 1n) * (2n * S + 1n)) / 6n;
  return S * GO_BASE_PRICE + (GO_LIN * T + GO_QUAD * P) / GO_DEN;
}

/** curve.go BuyCost(S,n) = Area(S+n) − Area(S). */
function goBuyCost(S: bigint, n: bigint): bigint {
  return goArea(S + n) - goArea(S);
}

/** curve.go SellProceeds(S,k) = Area(S) − Area(S−k). */
function goSellProceeds(S: bigint, k: bigint): bigint {
  return goArea(S) - goArea(S - k);
}

/** exittax.go ExitTaxBpsAt. */
function goExitTaxBpsAt(h: bigint): bigint {
  if (h >= GO_EXIT_TAX_DECAY_BLOCKS) return 0n;
  return goMulDivCeil(GO_MAX_EXIT_TAX_BPS, GO_EXIT_TAX_DECAY_BLOCKS - h, GO_EXIT_TAX_DECAY_BLOCKS);
}

/** exittax.go ExitTaxOn = ceil(p·bps/10000). */
function goExitTaxOn(p: bigint, bps: bigint): bigint {
  if (bps === 0n || p === 0n) return 0n;
  return goMulDivCeil(p, bps, 10000n);
}

/** tradefee.go tradeFeeOn = floor(amount·TradeFeeBps/10000). */
function goTradeFee(p: bigint): bigint {
  return (p * GO_TRADE_FEE_BPS) / 10000n;
}

/**
 * matured.go:185-195 splitDraw — MATURING FIRST, then matured. The order is
 * load-bearing (matured.go:149-184: the alternative measured up to 99.98% tax
 * avoidance), so it is written out here rather than parameterised.
 */
function goSplitDraw(maturing: bigint, amount: bigint): { fromMatured: bigint; fromMaturing: bigint } {
  if (amount <= maturing) return { fromMatured: 0n, fromMaturing: amount };
  return { fromMatured: amount - maturing, fromMaturing: maturing };
}

/** matured.go:197-219 maturingGrossShare — pro rata by token count, ceil. */
function goMaturingGrossShare(gross: bigint, fromMaturing: bigint, total: bigint): bigint {
  if (fromMaturing === 0n || gross === 0n || total === 0n) return 0n;
  if (fromMaturing === total) return gross;
  return goMulDivCeil(gross, fromMaturing, total);
}

interface GoSell {
  gross: bigint;
  taxableGross: bigint;
  tax: bigint;
  fee: bigint;
  net: bigint;
  taxBps: bigint;
  fromMaturing: bigint;
  fromMatured: bigint;
}

/** sell.go:170-271 sellCompute, money legs only. */
function goSellCompute(supply: bigint, deltaS: bigint, maturing: bigint, heldBlocks: bigint): GoSell {
  const taxBps = goExitTaxBpsAt(heldBlocks);
  const gross = goSellProceeds(supply, deltaS);
  const { fromMatured, fromMaturing } = goSplitDraw(maturing, deltaS);
  const taxableGross = goMaturingGrossShare(gross, fromMaturing, deltaS);
  const tax = goExitTaxOn(taxableGross, taxBps);
  const fee = goTradeFee(gross);
  return { gross, taxableGross, tax, fee, net: gross - tax - fee, taxBps, fromMaturing, fromMatured };
}

/**
 * THE PRE-FIX FORMULA, reconstructed verbatim from the code this change
 * replaces (contract-math.ts:414-429 before 2026-08-27): the tax on the FULL
 * gross. Present only so the fixtures can be proven discriminating — if a
 * fixture makes this agree with the fixed formula, the fixture tests nothing.
 */
function preFixTaxBaseUnits(supplyTokens: number, tokens: number, heldBlocks: number): number {
  const gross = sellProceedsBaseUnits(supplyTokens, tokens);
  if (gross === null) return 0;
  return exitTaxOnBaseUnits(gross, exitTaxBpsAt(heldBlocks));
}

/**
 * THE PRE-FIX BALANCE GATE, reconstructed verbatim from vsc-data-source.ts:778
 * before 2026-08-27. Same purpose: prove the fixture reproduces the defect.
 */
function preFixBalanceGate(state: Record<string, string | null>, creator: string, seller: string): number {
  return toU64(state[kBal(creator, seller)]);
}

// =====================================================================
// FIXTURE PLUMBING — a stub GQL client, so the real quoteSell/sell code
// runs against known state with no network.
// =====================================================================

/** matured.go:56-69 u64ToLE, as the node's hex encoding: little-endian, high zero bytes TRIMMED. */
function maturedHex(n: number): string {
  if (n === 0) return ''; // setMatured DELETES at zero (matured.go:119-121)
  let out = '';
  let v = n;
  while (v > 0) {
    out += (v % 256).toString(16).padStart(2, '0');
    v = Math.floor(v / 256);
  }
  return out;
}

const CREATOR = 'lumen.selftest';
const SELLER = 'holder.selftest';
const HEAD = 5_000_000;

interface Fixture {
  state: Record<string, string | null>;
  hex: Record<string, string | null>;
}

/**
 * `maturingTokens` writes the `mb|` family; a 0 writes NOTHING, exactly as
 * graduate() leaves the chain (matured.go:406-407 deletes kBal AND kAcqBlock).
 * `acqBlock` 0 likewise leaves the clock absent.
 */
function fixture(opts: { supply: number; maturing: number; matured: number; acqBlock: number; maturedRaw?: string }): Fixture {
  const state: Record<string, string | null> = {
    [kRegisteredAt(CREATOR)]: '1',
    [kSupply(CREATOR)]: String(opts.supply),
    [kPaidUntil(CREATOR)]: String(HEAD + 100_000), // ACTIVE — derivePhase: block <= paidUntil
    [kState(CREATOR)]: '',
    [kRetiredAt(CREATOR)]: null
  };
  if (opts.maturing > 0) state[kBal(CREATOR, SELLER)] = String(opts.maturing);
  if (opts.acqBlock > 0) state[kAcqBlock(CREATOR, SELLER)] = String(opts.acqBlock);
  const hex: Record<string, string | null> = {};
  const encoded = opts.maturedRaw !== undefined ? opts.maturedRaw : maturedHex(opts.matured);
  if (encoded !== '') hex[kMatured(CREATOR, SELLER)] = encoded;
  return { state, hex };
}

function sourceFor(f: Fixture, head: number | null = HEAD, sent?: CustomJsonOp[], txStatus: string = 'CONFIRMED'): VscCreatorTokensDataSource {
  const gql = {
    getStateByKeys: async (_c: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, f.state[k] ?? null])),
    getStateByKeysHex: async (_c: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, f.hex[k] ?? null])),
    getHeadBlock: async () => head
  } as unknown as CreatorTokensGqlClient;
  return new VscCreatorTokensDataSource({
    config: { contractId: 'vsc1selftest', netId: 'selftest', gqlUrl: 'http://unused.invalid' },
    gql,
    // Recording broadcaster: a sell that never reaches here is a sell that never
    // happened, which is exactly what F1 did to a graduated holder.
    broadcaster: sent === undefined ? undefined : async (op: CustomJsonOp) => { sent.push(op); return 'selftest-tx-id'; },
    // Injected tx-status reader (Node has no browser fetch): the real sell()
    // confirms against THIS instead of the /submit proxy, so the exit-tax money
    // math stays exercised end to end. Pass 'FAILED' to drive the *_REFUSED branch.
    txStatusReader: async () => txStatus
  });
}

async function throwsWith(fn: () => Promise<unknown>, fragment: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof Error && e.message.includes(fragment);
  }
}

// HBD base units are 3 decimals; SellQuote reports human HBD. Compare in base
// units by scaling back up — Math.round of a 3-decimal quotient is exact for
// every value in range, so this stays an EXACT integer comparison.
function toBase(hbd: number): number {
  return Math.round(hbd * 1000);
}

async function main(): Promise<void> {
  // ==================================================================
  // 0. THE INSTRUMENT ITSELF (state_the_instrument). If these fail, every
  //    number below is meaningless — so they run first and they are anchored
  //    on figures derived OUTSIDE this file.
  // ==================================================================
  check('INSTRUMENT: goBuyCost(0,1) === 1007, the value core/curve_test.go:124 pins', goBuyCost(0n, 1n) === 1007n, `got ${goBuyCost(0n, 1n)}`);
  check('INSTRUMENT: goArea(0) === 0', goArea(0n) === 0n);
  check('INSTRUMENT: goExitTaxBpsAt(0) === 2000 exactly (exittax.go:82)', goExitTaxBpsAt(0n) === 2000n, `got ${goExitTaxBpsAt(0n)}`);
  check('INSTRUMENT: goExitTaxBpsAt(ExitTaxDecayBlocks) === 0 (exittax.go:92)', goExitTaxBpsAt(GO_EXIT_TAX_DECAY_BLOCKS) === 0n);
  check('INSTRUMENT: EXIT_TAX_DECAY_BLOCKS agrees with params.go 42·28800', BigInt(EXIT_TAX_DECAY_BLOCKS) === GO_EXIT_TAX_DECAY_BLOCKS);

  // The three figures measured by hand for this defect, reproduced by the
  // instrument alone. supply 1000, sell 100 (40 maturing / 60 matured), h=0.
  const MEAS = goSellCompute(1000n, 100n, 40n, 0n);
  const measPreFixTax = goExitTaxOn(MEAS.gross, MEAS.taxBps); // whole-gross, the defect
  check('INSTRUMENT: the measured pre-fix tax is 217,179 base units', measPreFixTax === 217179n, `got ${measPreFixTax}`);
  check('INSTRUMENT: the measured true tax is 86,872 base units', MEAS.tax === 86872n, `got ${MEAS.tax}`);
  check('INSTRUMENT: the measured over-charge is 130,307 base units', measPreFixTax - MEAS.tax === 130307n, `got ${measPreFixTax - MEAS.tax}`);
  const measPreFixNet = MEAS.gross - measPreFixTax - MEAS.fee;
  const understatementPct = Number((measPreFixTax - MEAS.tax) * 10000n / measPreFixNet) / 100;
  check(
    'INSTRUMENT: the measured payout understatement is 17.1%',
    Math.abs(understatementPct - 17.1) < 0.05,
    `got ${understatementPct.toFixed(2)}% (pre-fix net ${measPreFixNet}, true net ${MEAS.net})`
  );

  // ==================================================================
  // A. F1 — A FULLY-GRADUATED HOLDER CAN SELL.
  //    This is the check that fails on the pre-fix code and is the whole point.
  // ==================================================================
  const graduated = fixture({ supply: 1000, maturing: 0, matured: 250, acqBlock: 0 });

  // GUARD (vacuous-pass): the fixture must actually reproduce the defect. If
  // kBal read anything but 0 here, group A would be testing nothing.
  check(
    'GUARD A: the fixture reproduces the defect — kBal alone reads 0 while the position is 250',
    preFixBalanceGate(graduated.state, CREATOR, SELLER) === 0 && graduated.hex[kMatured(CREATOR, SELLER)] === 'fa',
    `kBal=${preFixBalanceGate(graduated.state, CREATOR, SELLER)} maturedHex=${String(graduated.hex[kMatured(CREATOR, SELLER)])}`
  );
  check(
    'GUARD A: the pre-fix gate WOULD have refused this sell (0 < 100)',
    preFixBalanceGate(graduated.state, CREATOR, SELLER) < 100
  );

  const gq = await sourceFor(graduated).quoteSell(CREATOR, SELLER, 100);
  check('A1: a fully-graduated holder CAN get a sell quote (F1 — funds were locked)', gq.tokens === 100);

  const goGrad = goSellCompute(1000n, 100n, 0n, GO_EXIT_TAX_DECAY_BLOCKS);
  check('A2: gross matches sell.go SellProceeds exactly', toBase(gq.grossHbd) === Number(goGrad.gross), `got ${toBase(gq.grossHbd)} want ${goGrad.gross}`);
  check('A3: tax is EXACTLY 0 — nothing maturing, so the taxable share is 0 (sell.go:235)', toBase(gq.taxHbd) === 0, `got ${toBase(gq.taxHbd)}`);
  check('A4: fee matches tradeFeeOn(gross) exactly', toBase(gq.feeHbd) === Number(goGrad.fee), `got ${toBase(gq.feeHbd)} want ${goGrad.fee}`);
  check('A5: net matches sell.go net exactly', toBase(gq.netHbd) === Number(goGrad.net), `got ${toBase(gq.netHbd)} want ${goGrad.net}`);
  // F1b — holdclock.go:207-226's graduated branch.
  check('A6: heldBlocks is the FULL window, not 0 (holdclock.go:222-224)', gq.heldBlocks === EXIT_TAX_DECAY_BLOCKS, `got ${gq.heldBlocks}`);
  check('A7: the quoted RATE is 0%, not the maximum 20% (holdclock.go:208-224)', gq.taxBps === 0, `got ${gq.taxBps}`);

  // The gate itself: total position, not the maturing bucket.
  const gqAll = await sourceFor(graduated).quoteSell(CREATOR, SELLER, 250);
  check('A8: the WHOLE matured position is sellable (bal === 250)', gqAll.tokens === 250);
  check(
    'A9: one token past the position is still refused',
    await throwsWith(() => sourceFor(graduated).quoteSell(CREATOR, SELLER, 251), 'insufficient tokens')
  );

  // Undecodable ≠ zero. Defaulting to 0 here would re-create F1 exactly.
  const corrupt = fixture({ supply: 1000, maturing: 0, matured: 0, acqBlock: 0, maturedRaw: 'zz' });
  check(
    'A10: an undecodable matured value REFUSES the quote, it never reads as 0',
    await throwsWith(() => sourceFor(corrupt).quoteSell(CREATOR, SELLER, 100), 'matured balance unreadable')
  );

  // ==================================================================
  // B. MIXED POSITION through the real quoteSell — inside maturing, exactly
  //    at the boundary, and spanning both.
  // ==================================================================
  // 40 maturing / 60 matured, clock set 10 days back so the rate is a real
  // partial decay rather than an endpoint.
  const ACQ = HEAD - 10 * 28800;
  const mixed = fixture({ supply: 1000, maturing: 40, matured: 60, acqBlock: ACQ });
  const heldGo = BigInt(HEAD - ACQ);

  check('GUARD B: the mixed fixture has BOTH buckets non-empty', toU64(mixed.state[kBal(CREATOR, SELLER)]) === 40 && mixed.hex[kMatured(CREATOR, SELLER)] === '3c');

  for (const n of [30, 40, 41, 100]) {
    const q = await sourceFor(mixed).quoteSell(CREATOR, SELLER, n);
    const g = goSellCompute(1000n, BigInt(n), 40n, heldGo);
    const label = n < 40 ? 'inside maturing' : n === 40 ? 'exactly at the boundary' : 'spanning both buckets';
    check(`B(${n}, ${label}): tax matches sell.go EXACTLY`, toBase(q.taxHbd) === Number(g.tax), `got ${toBase(q.taxHbd)} want ${g.tax}`);
    check(`B(${n}, ${label}): net matches sell.go EXACTLY`, toBase(q.netHbd) === Number(g.net), `got ${toBase(q.netHbd)} want ${g.net}`);
    check(`B(${n}, ${label}): heldBlocks is the live clock (block − acq)`, q.heldBlocks === HEAD - ACQ);
  }
  check(
    'B: 101 tokens (one past maturing + matured) is refused',
    await throwsWith(() => sourceFor(mixed).quoteSell(CREATOR, SELLER, 101), 'insufficient tokens')
  );

  // ==================================================================
  // C. F2 — the tax base is the MATURING SHARE, in exact base units, no
  //    tolerance, asserted against sell.go's own formula.
  // ==================================================================
  const cases: Array<{ S: number; n: number; maturing: number; h: number }> = [
    { S: 1000, n: 100, maturing: 40, h: 0 }, // the measured case
    { S: 1000, n: 50, maturing: 40, h: 0 },
    { S: 1000, n: 1, maturing: 0, h: 0 },
    { S: 1000, n: 999, maturing: 1, h: 0 },
    { S: 1000, n: 100, maturing: 100, h: 0 }, // all maturing — the shortcut path
    { S: 1000, n: 100, maturing: 0, h: 0 }, // all matured
    { S: 1000, n: 7, maturing: 3, h: 21 * 28800 }, // mid-decay, awkward ratio
    { S: 283_000, n: 12_345, maturing: 6_789, h: 5 * 28800 }, // near params.go's practical ceiling
    { S: 1, n: 1, maturing: 1, h: 0 }
  ];
  for (const c of cases) {
    const q = quoteSellBaseUnits(c.S, c.n, c.h, c.maturing)!;
    const g = goSellCompute(BigInt(c.S), BigInt(c.n), BigInt(c.maturing), BigInt(c.h));
    const tag = `S=${c.S} n=${c.n} maturing=${c.maturing} h=${c.h}`;
    check(`C[${tag}]: gross exact`, BigInt(q.grossBaseUnits) === g.gross, `got ${q.grossBaseUnits} want ${g.gross}`);
    check(`C[${tag}]: tax exact (maturing share only)`, BigInt(q.taxBaseUnits) === g.tax, `got ${q.taxBaseUnits} want ${g.tax}`);
    check(`C[${tag}]: fee exact`, BigInt(q.feeBaseUnits) === g.fee, `got ${q.feeBaseUnits} want ${g.fee}`);
    check(`C[${tag}]: net exact`, BigInt(q.netBaseUnits) === g.net, `got ${q.netBaseUnits} want ${g.net}`);
  }

  // GUARD (vacuous-pass): the F2 cases must be discriminating — the pre-fix
  // whole-gross formula has to DISAGREE wherever matured tokens are drawn, and
  // AGREE wherever they are not. A fixture set that never separates the two
  // would pass group C without testing the fix at all.
  let discriminating = 0;
  for (const c of cases) {
    const fixed = quoteSellBaseUnits(c.S, c.n, c.h, c.maturing)!.taxBaseUnits;
    const preFix = preFixTaxBaseUnits(c.S, c.n, c.h);
    const drawsMatured = c.n > c.maturing;
    if (drawsMatured && c.h < EXIT_TAX_DECAY_BLOCKS && fixed !== preFix) discriminating += 1;
    if (!drawsMatured) {
      check(`GUARD C[S=${c.S} n=${c.n}]: an all-maturing draw is UNCHANGED by the fix (bit-for-bit)`, fixed === preFix, `fixed=${fixed} preFix=${preFix}`);
    }
  }
  check('GUARD C: at least 5 cases actually separate the fixed formula from the pre-fix one', discriminating >= 5, `separating cases: ${discriminating}`);
  check(
    'GUARD C: the measured case separates by exactly 130,307 base units',
    preFixTaxBaseUnits(1000, 100, 0) - quoteSellBaseUnits(1000, 100, 0, 40)!.taxBaseUnits === 130307,
    `got ${preFixTaxBaseUnits(1000, 100, 0) - quoteSellBaseUnits(1000, 100, 0, 40)!.taxBaseUnits}`
  );

  // Omitting the parameter must be bit-for-bit the pre-fix number — every
  // caller that has no split to give still means "treat it all as maturing".
  check(
    'C: omitting maturingTokens reproduces the pre-fix whole-gross tax exactly',
    quoteSellBaseUnits(1000, 100, 0)!.taxBaseUnits === preFixTaxBaseUnits(1000, 100, 0)
  );
  // Direction: the fix can only ever LOWER the tax, never raise it.
  for (const c of cases) {
    const fixed = quoteSellBaseUnits(c.S, c.n, c.h, c.maturing)!.taxBaseUnits;
    check(`C[S=${c.S} n=${c.n}]: the fix never RAISES the tax`, fixed <= preFixTaxBaseUnits(c.S, c.n, c.h));
  }

  // ==================================================================
  // D. THE SPLIT ORDER IS MATURING-FIRST (matured.go:149-195).
  // ==================================================================
  // Direct: 40 maturing / 60 matured, sell 50. Maturing-first draws 40 maturing
  // + 10 matured (taxable share 40/50). Matured-first would draw 50 matured and
  // tax NOTHING. Those two are far apart, which is the whole point of the
  // ruling.
  const dGross = goSellProceeds(1000n, 50n);
  const maturingFirstTaxable = goMulDivCeil(dGross, 40n, 50n);
  const maturedFirstTaxable = 0n; // 50 <= 60 matured: the wrong order taxes nothing
  const dActual = quoteSellBaseUnits(1000, 50, 0, 40)!;
  check(
    'D1: the split is MATURING-FIRST — taxable base is the 40/50 share, not 0',
    BigInt(dActual.taxBaseUnits) === goExitTaxOn(maturingFirstTaxable, 2000n),
    `got ${dActual.taxBaseUnits} want ${goExitTaxOn(maturingFirstTaxable, 2000n)}`
  );
  check(
    'D2: matured-first would have taxed nothing — the orders are genuinely different here',
    goExitTaxOn(maturedFirstTaxable, 2000n) === 0n && dActual.taxBaseUnits > 0
  );

  // The economic property the order exists for (matured.go:156-176): splitting
  // an exit must never pay LESS than selling in one go.
  const single = quoteSellBaseUnits(1000, 100, 0, 40)!.taxBaseUnits;
  // Maturing-first chunking: chunk 1 takes the 40 maturing off the TOP of the
  // curve, chunk 2 takes 60 matured from the lowered supply.
  const chunkA = quoteSellBaseUnits(1000, 40, 0, 40)!.taxBaseUnits;
  const chunkB = quoteSellBaseUnits(960, 60, 0, 0)!.taxBaseUnits;
  check('D3: splitting under maturing-first never pays LESS tax than one sale', chunkA + chunkB >= single, `split=${chunkA + chunkB} single=${single}`);
  // Matured-first chunking, reconstructed on the instrument: chunk 1 is the 60
  // matured (tax 0, dearest slice), chunk 2 is the 40 maturing from supply 940.
  const badChunk1 = 0n;
  const badChunk2 = goExitTaxOn(goSellProceeds(940n, 40n), 2000n);
  check(
    'D4: matured-first chunking WOULD have undercut the single sale — which is why the order is fixed',
    badChunk1 + badChunk2 < BigInt(single),
    `maturedFirstSplit=${badChunk1 + badChunk2} single=${single}`
  );

  // ==================================================================
  // E. curve.ts sellQuote — the local preview reaches the same numbers once
  //    the split is supplied, and is UNCHANGED when it is not.
  // ==================================================================
  const mkt = { supply: 1000, cap: 100_000, position: { tokens: 100, maturingTokens: 40 } };
  const eq = sellQuote(100, mkt, 0);
  check('E1: sellQuote taxes only the maturing share when the split is given', toBase(eq.exitFeeUsd) === Number(MEAS.tax), `got ${toBase(eq.exitFeeUsd)} want ${MEAS.tax}`);
  check('E2: sellQuote receive matches sell.go net exactly', toBase(eq.receiveUsd) === Number(MEAS.net), `got ${toBase(eq.receiveUsd)} want ${MEAS.net}`);
  const eqLegacy = sellQuote(100, { supply: 1000, cap: 100_000, position: { tokens: 100 } }, 0);
  check('E3: WITHOUT the split, sellQuote is bit-for-bit its pre-fix self (conservative)', toBase(eqLegacy.exitFeeUsd) === Number(measPreFixTax), `got ${toBase(eqLegacy.exitFeeUsd)} want ${measPreFixTax}`);
  check('E4: and that pre-fix number over-charges by the measured 130,307', toBase(eqLegacy.exitFeeUsd) - toBase(eq.exitFeeUsd) === 130307);
  // A matured-only position: nothing to tax whatever the clock says.
  const eqMatured = sellQuote(100, { supply: 1000, cap: 100_000, position: { tokens: 100, maturingTokens: 0 } }, 0);
  check('E5: a matured-only position is quoted 0 exit tax even at a 0-day clock', toBase(eqMatured.exitFeeUsd) === 0);
  // maturingTokens can never exceed the position it is a part of.
  const eqOver = sellQuote(100, { supply: 1000, cap: 100_000, position: { tokens: 100, maturingTokens: 500 } }, 0);
  check('E6: a maturingTokens larger than the position clamps to the position, never above it', toBase(eqOver.exitFeeUsd) === Number(measPreFixTax));

  // ==================================================================
  // G. THE WRITE PATH, not just the preview. sell() calls quoteSell first and
  //    lets its throw propagate, so before the fix a graduated holder's sell
  //    never reached the broadcaster at all — that is the "funds locked" half
  //    of F1, and a preview-only test would not have proven it.
  //    ★ CAVEAT (57, 2026-09-01): G3/G4 assert the returned position's SHAPE, an
  //    INTERFACE contract on public API — NOT a number any user sees. Every
  //    caller DISCARDS this return (bare await + onSuccess: invalidate refetches),
  //    so what protects the DISPLAYED balance is the refetch, not these two.
  // ==================================================================
  const sent: CustomJsonOp[] = [];
  const pos = await sourceFor(graduated, HEAD, sent).sell({ creator: CREATOR, seller: SELLER, tokens: 100 });
  check('G1: a fully-graduated holder\u2019s sell REACHES the broadcaster', sent.length === 1, `ops broadcast: ${sent.length}`);
  check('G2: the broadcast op is this contract\u2019s sell action', sent.length === 1 && JSON.stringify(sent[0]).includes('sell'), sent.length ? JSON.stringify(sent[0]) : 'nothing sent');
  check('G3: the optimistic position debits the sold tokens off the WHOLE balance (250 \u2212 100)', pos.tokensHeld === 150, `got ${pos.tokensHeld}`);
  check('G4: the optimistic position reports the graduated rate, 0%, not 20%', pos.exitTaxBps === 0, `got ${pos.exitTaxBps}`);

  // The minNet floor must be satisfiable at the TRUE (untaxed) net — under the
  // pre-fix tax a graduated seller's own honest floor would have been rejected.
  const sent2: CustomJsonOp[] = [];
  await sourceFor(graduated, HEAD, sent2).sell({ creator: CREATOR, seller: SELLER, tokens: 100, minNetHbd: Number(goGrad.net) / 1000 });
  check('G5: a minNet floor set at the true net is ACCEPTED, not rejected', sent2.length === 1);
  check(
    'G6: a minNet floor one base unit above the true net is still refused',
    await throwsWith(
      () => sourceFor(graduated, HEAD, []).sell({ creator: CREATOR, seller: SELLER, tokens: 100, minNetHbd: (Number(goGrad.net) + 1) / 1000 }),
      'below minNetHbd'
    )
  );

  // G7/G8: the confirmation half this whole change adds. A chain-REFUSED sell
  // (injected FAILED tx status) throws CREATOR_TOKENS_SELL_REFUSED — the ONLY
  // place the *_REFUSED branch is exercised anywhere in the repo (57, 2026-09-01)
  // — and it still reached the broadcaster first (the chain rejected it, we did
  // not pre-empt it).
  const g7sent: CustomJsonOp[] = [];
  check(
    'G7: a chain-refused sell throws SELL_REFUSED',
    await throwsWith(
      () => sourceFor(graduated, HEAD, g7sent, 'FAILED').sell({ creator: CREATOR, seller: SELLER, tokens: 100 }),
      'CREATOR_TOKENS_SELL_REFUSED'
    )
  );
  check('G8: the refused sell still REACHED the broadcaster before the chain rejected it', g7sent.length === 1, `ops broadcast: ${g7sent.length}`);

  // ==================================================================
  // F. tradeFeeOn is untouched by the fix — the fee is on GROSS, never on the
  //    taxable share (sell.go:237 `tradeFeeOn(p)`).
  // ==================================================================
  const fGross = sellProceedsBaseUnits(1000, 100)!;
  check('F1: the trade fee is still charged on GROSS, not on the taxable share', quoteSellBaseUnits(1000, 100, 0, 40)!.feeBaseUnits === tradeFeeOn(fGross).feeBaseUnits);
}

const EXPECTED_MIN_CHECKS = 95;

/**
 * VACUOUS-PASS GUARD (feedback_vacuous_pass_is_worse_than_fail): a run that
 * inspected nothing must FAIL, not print a cheerful 0/0 — and a run that DIED
 * halfway must not print "11/11 checks passed" either. Both paths land here, so
 * the short count is always counted as the failure it is.
 */
function finish(fatal?: unknown): never {
  if (fatal !== undefined) {
    failures += 1;
    checks += 1;
    console.error(`FAIL  FATAL: the suite threw before finishing: ${fatal instanceof Error ? fatal.stack : String(fatal)}`);
  }
  if (checks < EXPECTED_MIN_CHECKS) {
    failures += 1;
    checks += 1;
    console.error(`FAIL  VACUOUS: only ${checks - 1} checks ran, expected at least ${EXPECTED_MIN_CHECKS} — the suite did not execute in full`);
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  process.exit(0);
}

main().then(
  () => finish(),
  (e) => finish(e instanceof Error ? e : new Error(String(e)))
);
