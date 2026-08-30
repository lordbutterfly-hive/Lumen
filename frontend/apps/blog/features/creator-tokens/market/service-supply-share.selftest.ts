/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * SERVICE PRICE vs THE TOKEN'S OWN SUPPLY CAP.
 *
 * apps/blog has no unit test runner wired (see lib/vsc/payload-contract.selftest.ts's
 * header for the full audit of why). This follows the established fallback in
 * market/curve.selftest.ts: a plain script of assertions, run by hand.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/service-supply-share.selftest.ts
 *
 * WHAT THIS PROVES.
 *
 * Nothing on chain relates an offering's price to `kCap` (offerings.go validates
 * the title and the price band and never consults the cap), so the client is the
 * only place a creator can be told they have priced a service at more tokens than
 * can ever exist. That is the one refusal left: UNFILLABLE, `tokens > cap`.
 *
 * ★★ WHAT THIS FILE USED TO PROVE, AND WHY IT NO LONGER DOES (2026-08-30, B2).
 * Until today the guard also refused OVER-SHARE, a service above 10% of the cap,
 * and this file asserted that a $15 service on the live 30-cap market (14 tokens,
 * 47%) was refused. The owner reported that refusal as an error "that should
 * never fire", and it was proven on the live testnet state (all 13 discovery
 * markets through the real function) to fire on his own `hive:hbd-temp` market
 * (cap 30, supply 30, face $25 -> 18 tokens = 60%) for every service price at or
 * above $4.26. The 10% heuristic was removed; see market/curve.ts. The sections
 * below are rewritten to the narrower contract. Section 1 now asserts the
 * OPPOSITE of what it did: the 47% case is ALLOWED, and this file would fail if
 * the heuristic ever came back unannounced.
 *
 * The live numbers (deployed contract vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8,
 * read 2026-08-27 and re-read 2026-08-30):
 *
 *   hive:hbd-temp                  cap 30,      supply 30, face 25.000 HBD, no offerings
 *   did:pkh:eip155:1:0xB41f…980B   cap 30,      supply 0,  offering #1 = 15.000 HBD
 *   did:pkh:eip155:1:0xc965…Cb6a   cap 500,     supply 0,  face 20.000 HBD, no offerings
 *   hive:lumen.beat                cap 100,000, supply 50, offerings 55.000 / 12.000 HBD
 *
 * VACUOUS-PASS GUARD. Section 0 asserts the fixture itself still costs 14 tokens
 * against a 30 cap before anything is checked about the guard. If the curve, the
 * commission split or the opening price ever move so that this input is no
 * longer 47% of supply, this file FAILS rather than quietly testing a case that
 * no longer exists.
 */

import { displayPriceUsd, serviceQuote, serviceSupplyShare, serviceSupplyShareProblem } from './curve';
import { pctLabel } from './format';
// The REAL launch cap and the REAL price ceiling, imported rather than retyped —
// section 3b below is only honest if it moves when the owner moves them.
// launch-money.ts is plain math + contract-math constants, no React, so a node
// script can import it directly.
import { MAX_PRICE_USD, STANDARD_CAP } from '../ui/launch-money';
import { MAX_CAP_CREDITS_BASE_UNITS } from '../lib/contract-math';

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

// The opening price of any market: supply 0, $1.007 — the same figure the Buy
// button charges for the first token. Read from the curve, never hardcoded.
const OPENING = displayPriceUsd(0);

// ── 0. THE FIXTURE STILL COSTS WHAT IT COST. If this section fails, every
//       assertion below is testing a case that no longer exists.
const live30 = serviceQuote(15, OPENING).tokens;
check(
  'fixture: the live 30-cap market’s $15 service really does cost 14 tokens',
  live30 === 14,
  `serviceQuote(15, ${OPENING}).tokens = ${live30}, expected 14 (the figure the token page renders)`
);
check(
  'fixture: 14 of 30 really is ~47% of total supply',
  Math.round((live30 / 30) * 100) === 47,
  `got ${Math.round((live30 / 30) * 100)}%`
);

// ── 1. THE OWNER'S CASE IS ALLOWED. This is the assertion that FAILED on the
//       pre-2026-08-30 code: the 10% heuristic refused it. If it ever fails
//       again, the heuristic is back.
const thirtyCap = serviceSupplyShare(15, OPENING, 30);
check('30-cap / $15 service is judged at all (not null)', thirtyCap !== null);
check('30-cap / $15 service is NOT unfillable: 14 tokens of 30 can exist', thirtyCap?.unfillable === false);
check('30-cap / $15 share is still reported, informationally, as 4667 bps', thirtyCap?.shareBps === 4667, `got ${thirtyCap?.shareBps}`);
check(
  '★ the creation-time guard does NOT refuse it (this refusal is what the owner saw flashing)',
  serviceSupplyShareProblem(15, OPENING, 30) === null,
  `got: ${serviceSupplyShareProblem(15, OPENING, 30)}`
);
{
  // hbd-temp exactly as read on 2026-08-30: cap 30, supply 30 (price at supply 30), face $25.
  const hbdTempPrice = displayPriceUsd(30);
  const face = serviceSupplyShare(25, hbdTempPrice, 30);
  check('hbd-temp: the $25 face costs 18 tokens of 30 at supply 30', face?.tokens === 18, `tokens=${face?.tokens}`);
  check('hbd-temp: the $25 face is ALLOWED (it used to be refused at 60%)', serviceSupplyShareProblem(25, hbdTempPrice, 30) === null);
  // Sweep every price a person can type on that market; only prices whose token
  // cost exceeds the cap may be refused, and every one of those MUST be.
  let wrongRefusal: number | null = null;
  let missedRefusal: number | null = null;
  for (let cents = 1; cents <= MAX_PRICE_USD * 100; cents += 1) {
    const usd = cents / 100;
    const tokens = serviceQuote(usd, hbdTempPrice).tokens;
    const refused = serviceSupplyShareProblem(usd, hbdTempPrice, 30) !== null;
    if (tokens > 0 && tokens <= 30 && refused && wrongRefusal === null) wrongRefusal = usd;
    if (tokens > 30 && !refused && missedRefusal === null) missedRefusal = usd;
  }
  check('hbd-temp: NO fillable price is refused, at any price a person can type', wrongRefusal === null, `first wrong refusal at $${wrongRefusal}`);
  check('hbd-temp: EVERY unfillable price is refused', missedRefusal === null, `first missed refusal at $${missedRefusal}`);
}

// ── 2. UNFILLABLE is the one fault that survives. A $100 service on the same
//       30-token market costs 88 tokens — more than can ever exist, so no buyer
//       can reach it at any supply, and buy.go will not mint past the cap.
const unfillable = serviceSupplyShare(100, OPENING, 30);
check('$100 on a 30-cap market is unfillable', unfillable?.unfillable === true, `tokens=${unfillable?.tokens}`);
check(
  'the unfillable refusal says nobody could buy it, and names the creator’s own numbers',
  (() => {
    const msg = serviceSupplyShareProblem(100, OPENING, 30) ?? '';
    return msg.includes('nobody could buy it') && msg.includes('88') && msg.includes('30');
  })(),
  `got: ${serviceSupplyShareProblem(100, OPENING, 30)}`
);
check('the refusal carries no em dash (house rule for copy written today)', !/[–—]/.test(serviceSupplyShareProblem(100, OPENING, 30) ?? ''));
{
  // The boundary is the cap itself: tokens == cap is fillable, tokens == cap + 1 is not.
  const cap = 30;
  let lastAllowed: number | null = null;
  let firstRefused: number | null = null;
  for (let cents = 1; cents <= 20_000; cents += 1) {
    const usd = cents / 100;
    const tokens = serviceQuote(usd, OPENING).tokens;
    if (tokens === cap && serviceSupplyShareProblem(usd, OPENING, cap) === null) lastAllowed = usd;
    if (tokens === cap + 1 && firstRefused === null && serviceSupplyShareProblem(usd, OPENING, cap) !== null) firstRefused = usd;
  }
  check('a service costing exactly the cap is ALLOWED', lastAllowed !== null, 'no price costing exactly 30 tokens was allowed');
  check('a service costing one token more than the cap is REFUSED', firstRefused !== null, 'no price costing 31 tokens was refused');
}

// ── 3. ORDINARY PRICING IS UNTOUCHED. lumen.beat's two real offerings, at its
//       real supply of 50, and the two other legacy caps.
const beatPrice = displayPriceUsd(50);
check('lumen.beat $55 service is allowed', serviceSupplyShareProblem(55, beatPrice, 100_000) === null);
check('lumen.beat $12 service is allowed', serviceSupplyShareProblem(12, beatPrice, 100_000) === null);
check('a $50 service on the OLD launch cap of 5,000 is allowed', serviceSupplyShareProblem(50, OPENING, 5_000) === null);
check('the 500-cap market’s $20 face price is allowed', serviceSupplyShareProblem(20, OPENING, 500) === null);

// ── 3b. THE LAUNCH CAP IS MaxCap (owner, 2026-08-30) AND THIS GUARD IS SILENT
//        THERE. Asserted, not merely noted: if an owner ever re-tightens the
//        launch cap, these flip and say so.
check(
  'STANDARD_CAP is the contract’s MaxCap, imported not retyped',
  STANDARD_CAP === MAX_CAP_CREDITS_BASE_UNITS && STANDARD_CAP === 1_000_000_000,
  `got ${STANDARD_CAP}`
);
{
  let firstRefused: number | null = null;
  for (let cents = 1; cents <= MAX_PRICE_USD * 100; cents += 1) {
    if (serviceSupplyShareProblem(cents / 100, OPENING, STANDARD_CAP) !== null) {
      firstRefused = cents / 100;
      break;
    }
  }
  check(
    'at the launch cap the guard refuses NOTHING a creator can type ($0.01–$' + MAX_PRICE_USD + ')',
    firstRefused === null,
    `first refused price: $${firstRefused}`
  );
}

// ── 4. NEVER GUESSES. A guard that fires on a value it does not have would
//       block a creator's own pricing during an ordinary failed read — the
//       exact "unavailable is not empty" rule this feature is built on.
check('no cap => cannot judge', serviceSupplyShare(15, OPENING, 0) === null);
check('negative cap => cannot judge', serviceSupplyShare(15, OPENING, -1) === null);
check('NaN cap => cannot judge', serviceSupplyShare(15, OPENING, Number.NaN) === null);
check('no token price => cannot judge', serviceSupplyShare(15, 0, 30) === null);
check('NaN price => cannot judge', serviceSupplyShare(15, Number.NaN, 30) === null);
check('no service price => cannot judge', serviceSupplyShare(0, OPENING, 30) === null);
check('negative service price => cannot judge', serviceSupplyShare(-15, OPENING, 30) === null);
check(
  'every un-judgeable input produces NO refusal, not a refusal',
  [serviceSupplyShareProblem(15, OPENING, 0), serviceSupplyShareProblem(15, 0, 30), serviceSupplyShareProblem(0, OPENING, 30)].every((m) => m === null)
);

// ── 5. ONE QUOTE FUNCTION. The share must be derived from `serviceQuote`, not
//       from a second cost formula — the "third, wrong way to quote the same
//       offering" the Studio was already bitten by (2026-08-21, an 11% gap
//       between the creator's screen and the buyer's).
for (const [usd, price, cap] of [
  [15, OPENING, 30],
  [55, beatPrice, 100_000],
  [50, OPENING, 5_000]
] as [number, number, number][]) {
  const share = serviceSupplyShare(usd, price, cap);
  check(
    `share tokens agree with serviceQuote for $${usd}`,
    share !== null && share.tokens === serviceQuote(usd, price).tokens,
    `share=${share?.tokens} serviceQuote=${serviceQuote(usd, price).tokens}`
  );
}

// ── 6. THE FIGURE THE TOKEN PAGE PRINTS BESIDE EACH SERVICE PRICE. Asserts the
//       VALUE the label renders — it does not mount the component, and does not
//       claim to. (Whether that label should survive the cap ruling at all is a
//       separate, open question for the token page; see the studio checklist.)
check(
  'the 30-cap service label reads 47%',
  pctLabel(serviceQuote(15, OPENING).tokens, 30) === '47%',
  `got ${pctLabel(serviceQuote(15, OPENING).tokens, 30)}`
);
check(
  'a healthy market’s label reads "<1%", never a false "0%"',
  pctLabel(serviceQuote(55, beatPrice).tokens, 100_000) === '<1%',
  `got ${pctLabel(serviceQuote(55, beatPrice).tokens, 100_000)}`
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
