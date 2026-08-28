/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * BUY-MODAL PREVIEW self-test — the four things the Buy dialog told a reader
 * that were not true (2026-08-27), each pinned so it cannot come back.
 *
 * apps/blog has no unit test runner wired (see market/curve.selftest.ts and
 * lib/vsc/payload-contract.selftest.ts for the full audit of why — no
 * jest/vitest anywhere). This follows the same established shape: a plain
 * assertion script with its own `check`, exit 1 on any failure.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/buy-preview.selftest.ts
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS UNDER TEST, AND WHAT THIS CAN AND CANNOT PROVE. Read this before
 * trusting it.
 *
 * The defects live in a React component (ui/token-page/token-modals.tsx's
 * BuyModal) and this repo cannot render one — so each fix is proven in TWO
 * halves, and neither half alone is worth anything:
 *
 *   (a) THE ARITHMETIC. The pure quote functions the modal renders are called
 *       directly, and the OLD expression is REPRODUCED VERBATIM beside the new
 *       one and run on the same quote. A test that only asserted the new
 *       behaviour would pass just as happily against the old file; running both
 *       is what makes "this fails before the fix" a measurement rather than a
 *       claim. The reproduction is exactly that — a reproduction of the old
 *       one-line expression, not the old file.
 *
 *   (b) THE WIRING. A source scan of BuyModal itself, because a correct helper
 *       that nothing calls is the failure mode this codebase has been bitten by
 *       repeatedly. Precedent and technique (comment stripping, and a
 *       "the scan read some source" guard so it can never pass vacuously) are
 *       taken from features/retention/lib/__tests__/ladder.test.ts's own
 *       call-site scan.
 *
 * It does NOT drive the dialog. Nothing here proves a click broadcasts, only
 * that the numbers the dialog is built from are the numbers it now shows, and
 * that the dialog is built from them.
 *
 * THE MARKET USED. supply 50, cap 100,000 — the state of the live market the
 * four defects were measured on, chosen because every reported figure
 * reproduces on it exactly: $10 quotes 6 tokens at an "average" of $1.57 above
 * a "price after" of $1.46, and $12.34 quotes 7 tokens for $11.03.
 */

import { buyQuote, minBuyUsd, type CurveMarketInput } from './curve';
import { usdPrice, usdWhole } from './format';
import { quoteBuyBaseUnits } from '../lib/contract-math';

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

/** The live market the defects were measured on. */
const MARKET: CurveMarketInput = { supply: 50, cap: 100_000, position: null };
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

// The BuyModal's own helpers, reproduced so the OLD rendering can be run.
/** token-modals.tsx's shared `tok` — the formatter the token count used to go through. */
const tokOld = (n: number): string => n.toFixed(2);

console.log('── FIX A — the CTA must name the amount charged, not the budget typed\n');
{
  // Measured: typing 12.34 buys 7 whole tokens; the button said "$12".
  const usd = 12.34;
  const q = buyQuote(usd, MARKET);
  check('12.34 on this market quotes 7 whole tokens', q.tokens === 7, `got ${q.tokens}`);
  check(
    'TotalDue is strictly LESS than the typed budget (tokens are integers)',
    q.totalUsd < usd && near(q.totalUsd, 11.033),
    `totalUsd=${q.totalUsd} budget=${usd}`
  );

  const oldLabel = `Buy — ${usdWhole(usd)}`; // the expression this fix removes
  const newLabel = `Buy — ${usdPrice(q.totalUsd)}`;
  check(
    'THE DEFECT: the old label ("$12") is not the amount charged ($11.03)',
    oldLabel !== newLabel && oldLabel === 'Buy — $12' && newLabel === 'Buy — $11.03',
    `old=${JSON.stringify(oldLabel)} new=${JSON.stringify(newLabel)}`
  );
  check(
    'the overstatement is more than a rounding artefact — over a dollar here',
    usd - q.totalUsd > 1,
    `overstated by $${(usd - q.totalUsd).toFixed(3)}`
  );

  // ★ ONE VALUE, NOT TWO. token-market-view.tsx's handleBuy recomputes the same
  // buyQuote(usd, market) and sends `local.tokens` to live.buy(); the chain
  // charges TotalDue for exactly that many tokens. So the label is correct only
  // if it equals the TotalDue of the token count that is actually sent.
  const tokensSent = buyQuote(usd, MARKET).tokens; // handleBuy's `local.tokens`
  const chargedUsd = quoteBuyBaseUnits(50, tokensSent).totalDueBaseUnits / 1000;
  check(
    'the new label IS the TotalDue of the exact token count handleBuy sends',
    usdPrice(q.totalUsd) === usdPrice(chargedUsd) && near(q.totalUsd, chargedUsd),
    `label=${usdPrice(q.totalUsd)} charge=${usdPrice(chargedUsd)} tokensSent=${tokensSent}`
  );
  check(
    'the OLD label was NOT that figure — label and charge were two different values',
    usdWhole(usd) !== usdPrice(chargedUsd),
    `old label=${usdWhole(usd)} charge=${usdPrice(chargedUsd)}`
  );
}
{
  // Measured: typing 0.5 showed "Buy — $1" — an overstatement of 2x, on a
  // budget that buys nothing at all.
  const q = buyQuote(0.5, MARKET);
  check(
    'THE DEFECT at 0.50: old label said "$1" for a quote of ZERO tokens',
    usdWhole(0.5) === '$1' && q.tokens === 0 && q.totalUsd === 0,
    `old=${usdWhole(0.5)} tokens=${q.tokens}`
  );
}
{
  // Measured: typing -5 rendered "$-5". The field now strips the sign, so the
  // formatter can never see one. This is the sanitiser, verbatim.
  const sanitise = (raw: string): string => raw.replace(/-/g, '');
  check('a minus reaching the old formatter really did print "$-5"', usdWhole(-5) === '$-5');
  check('the field strips the sign before it can be parsed', sanitise('-5') === '5');
  check('and mid-string / pasted minuses too', sanitise('1-2') === '12' && sanitise('-0.5') === '0.5');
  check(
    'after sanitising, the parsed budget is never negative for any minus form',
    ['-5', '-0.5', '-', '--12.34'].every((raw) => {
      const parsed = parseFloat(sanitise(raw).replace(/,/g, '')) || 0;
      return parsed >= 0;
    })
  );
}

console.log('\n── FIX B — a whole-token quantity must not print decimals\n');
{
  const q = buyQuote(12.34, MARKET);
  check('the quote is an integer count (the curve mints integers only)', Number.isInteger(q.tokens));
  check(
    'THE DEFECT: the old formatter printed "7.00" for 7 tokens',
    tokOld(q.tokens) === '7.00' && `${q.tokens}` === '7',
    `old=${tokOld(q.tokens)}`
  );
  // Every budget/supply pair must be an integer, or "print it bare" would be
  // the wrong fix rather than a cosmetic one.
  const grid: number[] = [];
  for (const supply of [0, 1, 50, 999, 12_345]) {
    for (const budget of [0.5, 1.55, 10, 12.34, 1000, 250_000]) {
      grid.push(buyQuote(budget, { supply, cap: 100_000, position: null }).tokens);
    }
  }
  check('scan read a real grid of quotes', grid.length === 30, `${grid.length} quotes`);
  check('EVERY quoted token count across supplies and budgets is an integer', grid.every(Number.isInteger));

  const one = buyQuote(1.55, MARKET);
  check('1.55 buys exactly one token here', one.tokens === 1, `got ${one.tokens}`);
  check(
    'singular reads "1 token", plural reads "7 tokens"',
    `${one.tokens} token${one.tokens === 1 ? '' : 's'}` === '1 token' &&
      `${q.tokens} token${q.tokens === 1 ? '' : 's'}` === '7 tokens'
  );
}

console.log('\n── FIX C — average price and price-after must not sit on different fee bases\n');
{
  // The reported measurement, exactly: "Average price ~$1.57" above "Price
  // after your buy ~$1.46".
  const q = buyQuote(10, MARKET);
  check('$10 on this market quotes 6 tokens', q.tokens === 6, `got ${q.tokens}`);
  check(
    'the reported pair reproduces: ~$1.57 shown above ~$1.46',
    usdPrice(q.avgPrice) === '$1.57' && usdPrice(q.priceAfter) === '$1.46',
    `avg=${usdPrice(q.avgPrice)} after=${usdPrice(q.priceAfter)}`
  );
  check(
    'THE DEFECT: avgPrice sits ABOVE priceAfter — impossible on a rising curve if they shared a basis',
    q.avgPrice > q.priceAfter,
    `avg=${q.avgPrice} after=${q.priceAfter}`
  );
  // The diagnosis, proven rather than asserted: the whole inversion is the fee.
  check(
    'THE CAUSE: strip the fee and the ordering is correct again (avg ex-fee < priceAfter)',
    q.curveCostUsd / q.tokens < q.priceAfter,
    `exFeeAvg=${(q.curveCostUsd / q.tokens).toFixed(4)} after=${q.priceAfter}`
  );
  check(
    'the fee is what separates them, to the cent',
    near(q.avgPrice - q.curveCostUsd / q.tokens, q.tradeFeeUsd / q.tokens),
    `gap=${(q.avgPrice - q.curveCostUsd / q.tokens).toFixed(6)} feePerToken=${(q.tradeFeeUsd / q.tokens).toFixed(6)}`
  );
  // The itemisation the modal now renders must reconcile, or it is decoration.
  check(
    'the itemised rows add up: curveCost + tradeFee === totalUsd',
    near(q.curveCostUsd + q.tradeFeeUsd, q.totalUsd),
    `${q.curveCostUsd} + ${q.tradeFeeUsd} != ${q.totalUsd}`
  );
  check(
    'the fee row is a real, nonzero deduction here — not an always-blank line',
    q.tradeFeeUsd > 0 && usdPrice(q.tradeFeeUsd) === '$0.86',
    `fee=${usdPrice(q.tradeFeeUsd)}`
  );
  check(
    'as rendered, the three rows reconcile to the CTA figure',
    `${usdPrice(q.curveCostUsd)} +${usdPrice(q.tradeFeeUsd)} = ${usdPrice(q.totalUsd)}` === '$8.57 +$0.86 = $9.43',
    `${usdPrice(q.curveCostUsd)} +${usdPrice(q.tradeFeeUsd)} = ${usdPrice(q.totalUsd)}`
  );
  // A zero-token quote must not claim a fee it will never charge.
  const zero = buyQuote(0.5, MARKET);
  check('a zero-token quote itemises nothing', zero.curveCostUsd === 0 && zero.tradeFeeUsd === 0 && zero.totalUsd === 0);
}

console.log('\n── FIX D — a quote of zero tokens must disable the button, and say why\n');
{
  const minBuy = minBuyUsd(MARKET);
  check('the minimum on this market is $1.55', near(minBuy, 1.55), `got ${minBuy}`);
  check(
    'the printed minimum is a budget that ACTUALLY works (ceil to the cent, not round)',
    buyQuote(minBuy, MARKET).tokens >= 1,
    `buyQuote(${minBuy}).tokens=${buyQuote(minBuy, MARKET).tokens}`
  );
  check(
    'and it is the TRUE boundary — one cent less buys nothing',
    buyQuote(Math.round(minBuy * 100 - 1) / 100, MARKET).tokens === 0,
    `buyQuote(${Math.round(minBuy * 100 - 1) / 100}).tokens=${buyQuote(Math.round(minBuy * 100 - 1) / 100, MARKET).tokens}`
  );
  // WHY CEIL AND NOT ROUND, measured rather than asserted. TotalDue is a
  // 3-decimal HBD integer, so whenever its last digit is 1-4 a round-to-nearest
  // minimum names a budget a cent SHORT of the real boundary — a printed
  // minimum that buys nothing, which is the same class of lie as the enabled
  // button this fix exists to remove. (It does NOT bite at supply 50: 1548
  // rounds up to $1.55 anyway. It bites at the supplies below.)
  const roundWouldUndershoot: number[] = [];
  for (let supply = 0; supply <= 2_000; supply += 1) {
    const totalDue = quoteBuyBaseUnits(supply, 1).totalDueBaseUnits;
    if (Math.round(totalDue / 10) < Math.ceil(totalDue / 10)) roundWouldUndershoot.push(supply);
  }
  check(
    'the round-vs-ceil difference is real and reachable, not hypothetical',
    roundWouldUndershoot.length > 0,
    `${roundWouldUndershoot.length} of 2001 supplies, first at supply ${roundWouldUndershoot[0]}`
  );
  check(
    'at EVERY such supply, a rounded minimum buys NOTHING while the ceiled one buys a token',
    roundWouldUndershoot.every((supply) => {
      const m: CurveMarketInput = { supply, cap: 100_000, position: null };
      const totalDue = quoteBuyBaseUnits(supply, 1).totalDueBaseUnits;
      const rounded = Math.round(totalDue / 10) / 100;
      return buyQuote(rounded, m).tokens === 0 && buyQuote(minBuyUsd(m), m).tokens === 1;
    }),
    `checked ${roundWouldUndershoot.length} supplies`
  );

  // THE DEFECT, run: the old disabled expression, verbatim, on the budgets that
  // were measured showing "≈ 0.00 tokens" under a live button.
  for (const usd of [0.5, 1]) {
    const q = buyQuote(usd, MARKET);
    const overMax = false; // Advanced collapsed, as measured
    const busy = false;
    const blockedBySpending = false;
    const soldOut = false;
    const oldDisabled = !Number.isFinite(usd) || usd <= 0 || overMax || busy || blockedBySpending || soldOut;
    const newDisabled =
      !Number.isFinite(usd) || usd <= 0 || q.tokens <= 0 || overMax || busy || blockedBySpending || soldOut;
    check(
      `$${usd} quotes zero tokens`,
      q.tokens === 0 && tokOld(q.tokens) === '0.00' && usdPrice(q.avgPrice) === '$0.00',
      `tokens=${q.tokens}`
    );
    check(
      `THE DEFECT at $${usd}: the OLD expression left the button ENABLED on a quote of zero tokens`,
      oldDisabled === false,
      `oldDisabled=${oldDisabled}`
    );
    check(`the NEW expression disables it at $${usd}`, newDisabled === true, `newDisabled=${newDisabled}`);
    check(
      `and the reader is told why: "Minimum buy is ${usdPrice(minBuy)}"`,
      q.tokens <= 0 && minBuy > 0 && `Minimum buy is ${usdPrice(minBuy)}` === 'Minimum buy is $1.55'
    );
  }
  // A budget above the minimum must NOT be disabled by the new clause — a guard
  // that refuses everything is not a fix.
  check('the new clause does not disable an ordinary buy', buyQuote(10, MARKET).tokens > 0);

  // IT MOVES WITH SUPPLY. This is why it is derived per render and never
  // hardcoded: the same button must show a different number as the curve rises.
  const mins = [0, 50, 500, 5_000].map((supply) => minBuyUsd({ supply, cap: 100_000, position: null }));
  check('the minimum rises with supply (derived, not a constant)', mins.every((v, i) => i === 0 || v > mins[i - 1]), mins.join(' < '));
  check('at supply 0 the minimum is $1.11, not $1.55 — a hardcoded figure would be wrong there', near(mins[0], 1.11), `got ${mins[0]}`);
  check(
    'a sold-out market has no minimum at all (cap headroom 0)',
    minBuyUsd({ supply: 100_000, cap: 100_000, position: null }) === 0
  );
}

console.log('\n── WIRING — the modal really renders these, and no longer renders the old ones\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const src = readFileSync(join(__dirname, '../ui/token-page/token-modals.tsx'), 'utf8');

  // Comments stripped FIRST — every defect below is quoted verbatim in the new
  // comments explaining it, so an un-stripped scan would find the old code in
  // the prose describing its removal. Same stripper as ladder.test.ts's
  // call-site scan: block comments (JSX `{/* */}` included) and whole-line `//`.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // BuyModal only: `tok(q.tokens)` and `usdWhole(usd)` both legitimately survive
  // in AskModal, which prices a service, not a curve buy.
  const start = code.indexOf('const BuyModal');
  const end = code.indexOf('const SellModal');
  const buy = start >= 0 && end > start ? code.slice(start, end) : '';

  // ── Non-vacuity. A scan with nothing to inspect must FAIL, never pass.
  check('the scan read the modal source', src.length > 10_000, `${src.length} bytes`);
  check('BuyModal was located and sliced', buy.length > 2_000, `${buy.length} bytes between BuyModal and SellModal`);
  check(
    'the slice really is BuyModal (it contains the buy CTA and the affordability gauge)',
    buy.includes('onBuy(usd, maxTotalUsd)') && buy.includes('MagiFuelGauge')
  );
  check(
    'comment stripping did not eat the code (the sell CTA below still scans intact)',
    // ★ THE LANDMARK MOVED, AND THAT IS THE LESSON (2026-08-28). This negative
    // control anchored on a piece of USER-FACING COPY, so a copy edit (the em
    // dash sweep) broke a check about the STRIPPER. A landmark should be code
    // that changes for structural reasons, not a sentence a reader sees. Kept
    // pointing at the same expression, now with its current separator; the
    // assertion below is deliberately the `usdPrice(q.receiveUsd)` CALL, which
    // is the part that cannot change without the feature changing.
    code.includes('usdPrice(q.receiveUsd)')
  );
  check(
    'the negative controls are live: usdWhole and tok DO still appear elsewhere in this file',
    // ★ 2026-08-27: `usdWhole(` dropped from this control. The scrutiny pass
    // legitimately removed the last `usdWhole` from BuyModal (the posted Ask price
    // now uses `usdPrice`, because showing $12.50 as "$13" made the overshoot
    // un-checkable). `tok(` still lives elsewhere in the file, so the stripper
    // sanity control still has a real negative to prove against.
    code.includes('tok(')
  );

  // ── FIX A
  check('A: BuyModal no longer builds its CTA from the typed budget', !buy.includes('usdWhole(usd)'));
  // ★ 2026-08-27: the label was `Buy — $X` when this test was written; the
  // disclosure pass replaced the em dash with "for" (house style forbids em
  // dashes in published copy). The ASSERTION IS UNCHANGED IN SUBSTANCE — the CTA
  // must still be priced from `q.totalUsd`, the amount actually charged, and not
  // from the typed budget. Only the connecting word moved.
  // ★ Now carries `~`: the label prices the LOCAL quote, while the charge is
  // re-quoted against live supply, so it is an estimate and every sibling figure
  // in these modals says so. Substance unchanged — still priced from `totalUsd`.
  check('A: the CTA is the quoted TotalDue', buy.includes('`Buy for ~${usdPrice(q.totalUsd)}`'));
  // ★ The strip was REPLACED, not tuned: `replace(/-/g,'')` silently turned
  // "1e-5" into $100,000 and "-5" into a live $5 buy. `acceptAmountText` refuses
  // the whole proposal and keeps the previous value instead of mutating input.
  check('A: the amount field REFUSES bad input rather than rewriting it', buy.includes('acceptAmountText(amt, e.target.value)'));

  // ── FIX B
  check('B: the token count no longer goes through the 2-decimal formatter', !buy.includes('tok(q.tokens)'));
  check("B: it renders the integer, with a singular form", buy.includes("token{q.tokens === 1 ? '' : 's'}"));

  // ── FIX C
  check('C: both price rows name their fee basis', buy.includes('Average price (incl. fees)') && buy.includes('Curve price after your buy'));
  check('C: neither unlabelled row survives', !buy.includes('>Average price<') && !buy.includes('>Price after your buy<'));
  check('C: the fee is itemised, mirroring the Sell modal', buy.includes('Trade fee (10%)') && buy.includes('usdPrice(rows.tradeFeeUsd)'));
  check('C: the itemisation ends in the charged total', buy.includes('Total charged') && buy.includes('usdPrice(rows.curveCostUsd)'));

  // ── FIX D
  check('D: the disabled attribute refuses a zero-token quote', /disabled=\{[^}]*q\.tokens <= 0/.test(buy));
  check('D: the click handler refuses it too (they must not disagree)', /if \(!Number\.isFinite\(usd\) \|\| usd <= 0 \|\| q\.tokens <= 0/.test(buy));
  check('D: the reason is stated, from the derived minimum', buy.includes('minBuyUsd(m)') && buy.includes('`Minimum buy is ${usdPrice(minBuy)}`'));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
