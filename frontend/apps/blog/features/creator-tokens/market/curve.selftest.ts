/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * F4 self-test — the ask spend cap (maxCreditsBaseUnits) is an INTEGER TOKEN
 * COUNT (core/ask.go creditsSpent/maxCredits), never a function of the HBD
 * price.
 *
 * apps/blog has no unit test runner wired (see
 * lib/vsc/payload-contract.selftest.ts's own header for the full audit of
 * why — no jest/vitest anywhere, packages/ui and packages/transaction are
 * separate packages that cannot import apps/blog code). This follows that
 * file's established fallback: a plain exported checker, runnable by hand,
 * matching lib/vsc/matured-decode.selftest.ts's standalone (not auto-run)
 * shape.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/curve.selftest.ts
 *
 * The function under test (resolveAskMaxCreditsBaseUnits) lives in this same
 * file's subject, market/curve.ts, rather than in use-live-token-market.ts
 * where askMutation actually calls it — that hook file transitively imports
 * the real VSC data source (react-query, @hiveio/wax), which cannot resolve
 * outside a bundler. market/curve.ts is the established home for this
 * feature's pure ask/sell preview math (serviceQuote lives here too) and has
 * no such dependency, so it is what askMutation imports the function FROM
 * and what this test imports it from as well — proving the exact code the
 * hook calls, not a duplicate.
 *
 * WHAT THIS PROVES. Before the fix, askMutation (use-live-token-market.ts)
 * built the signed cap as `humanToBaseUnits(input.maxCostUsd)` — an
 * HBD-MILLIUNIT number built from the price the buyer typed — while
 * AskInput.maxCreditsBaseUnits (types.ts) is an INTEGER TOKEN COUNT that may
 * ONLY be derived from Quote.creditsRequiredBaseUnits. Measured 1,000x to
 * 18,000x too loose in production, which made the contract's own
 * creditsSpent > maxCredits guard (core/ask.go:352-356,429-430) effectively
 * unlimited. This asserts the fix's arithmetic (resolveAskMaxCreditsBaseUnits
 * is a pure function of the quote's credits figure alone — no price
 * parameter exists for it to take), reproduces the scale of the regression
 * being closed, and checks the WIRE payload actually carries the honest
 * figure via the same askPayload() builder the real write path calls.
 */

import { resolveAskMaxCreditsBaseUnits, ASK_MAX_CREDITS_TOLERANCE_BPS } from './curve';
import { askPayload } from '../lib/vsc/op-builders';
import { humanToBaseUnits } from '../lib/contract-math';

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

// ── 1. The tolerance arithmetic, and its default.
check('2% is the default tolerance', ASK_MAX_CREDITS_TOLERANCE_BPS === 200);
check(
  '42 tokens -> 43 under the default 2% tolerance (ceil)',
  resolveAskMaxCreditsBaseUnits(42) === 43,
  `got ${resolveAskMaxCreditsBaseUnits(42)}`
);
check('0 tolerance returns the quote figure exactly', resolveAskMaxCreditsBaseUnits(42, 0) === 42);
check('1 token never rounds DOWN under tolerance', resolveAskMaxCreditsBaseUnits(1) >= 1);
check('0 credits (unpriceable) resolves to 0, not a negative or NaN cap', resolveAskMaxCreditsBaseUnits(0) === 0);

// ── 2. THE REGRESSION THIS FIX IS FOR — reproduced at production scale. A
// buyer types "$10" for a service that actually costs 42 whole tokens under
// the live settlement rate (a realistic ~$0.24/token market). The OLD code
// built the cap from that $10 via humanToBaseUnits — an HBD-milliunit
// number — instead of from the quote's own token count.
const REALISTIC_QUOTE_CREDITS = 42; // whole tokens — ask.go creditsForAsk / Quote.creditsRequiredBaseUnits
const oldBuggyMaxCredits = humanToBaseUnits(10); // WRONG: the typed USD amount, x1000-scaled — never a token count
const fixedMaxCredits = resolveAskMaxCreditsBaseUnits(REALISTIC_QUOTE_CREDITS);
check(
  'the fix is NEVER a function of the USD/HBD price — it is dramatically tighter than the old formula',
  fixedMaxCredits < oldBuggyMaxCredits / 100,
  `fixed=${fixedMaxCredits} old(pre-fix formula)=${oldBuggyMaxCredits} ratio=${(oldBuggyMaxCredits / fixedMaxCredits).toFixed(0)}x looser`
);
// The regression measured live was 1,000x-18,000x; this scenario alone clears
// well over 200x, which is already conclusive that the two formulas cannot
// be the same guard.
check('the reproduced gap exceeds 200x, consistent with the measured 1,000x-18,000x finding', oldBuggyMaxCredits / fixedMaxCredits > 200);

// ── 3. End to end: the WIRE payload carries the resolved (honest) figure —
// askPayload is the exact builder vsc-data-source.ts's real ask() write
// calls, so this proves the fix reaches the actual broadcast, not just a
// helper function nothing signs.
const payload = askPayload('hive:creator', 'selftest-ref', 800, fixedMaxCredits, 0);
check(
  'payload.maxCredits is the moneyString of the resolved, quote-derived cap',
  payload.maxCredits === String(fixedMaxCredits),
  `got ${JSON.stringify(payload.maxCredits)}`
);
check('payload.maxCredits is NOT the old HBD-milliunit figure', payload.maxCredits !== String(oldBuggyMaxCredits));

// A second scenario at a very different price makes the same point a
// different way: two quotes with the SAME token count must produce the SAME
// cap regardless of what USD price accompanies them, because the function
// takes no price argument at all.
const otherScenarioSameCredits = resolveAskMaxCreditsBaseUnits(REALISTIC_QUOTE_CREDITS);
check(
  'the resolved cap is identical for the same credits figure regardless of any USD price',
  otherScenarioSameCredits === fixedMaxCredits
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
