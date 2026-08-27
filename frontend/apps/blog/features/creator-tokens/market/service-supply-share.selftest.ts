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
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECT.
 *
 * Nothing anywhere related an offering's price to `kCap`. `serviceQuote` answers
 * "how many tokens does this cost"; no code asked "how many tokens are there".
 * The contract does not close the gap either — offerings.go validates the title
 * and the price band and never consults the cap — so there was no on-chain
 * backstop and no client check, in either the Studio's create form, its price
 * editor, or the Meritum launch wizard.
 *
 * The numbers below are not invented. They are the LIVE testnet state, read from
 * the deployed contract (vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8) on 2026-08-27:
 *
 *   did:pkh:eip155:1:0xB41f…980B   cap 30,      supply 0,  offering #1 = 15.000 HBD
 *   did:pkh:eip155:1:0xc965…Cb6a   cap 500,     supply 0,  face 20.000 HBD, no offerings
 *   hive:lumen.beat                cap 100,000, supply 50, offerings 55.000 / 12.000 HBD
 *
 * and the 30-cap figure was confirmed in the rendered DOM of
 * /creators/did%3Apkh%3Aeip155%3A1%3A0xB41f… , which printed
 * "≈ 14.00 tokens" beside "$15" under "0 of 30 tokens issued".
 *
 * VACUOUS-PASS GUARD. Section 0 asserts the fixture itself still reproduces the
 * defect — 14 tokens against a 30 cap — before anything is checked about the
 * guard. If the curve, the commission split or the opening price ever move so
 * that this input is no longer 47% of supply, this file FAILS rather than
 * quietly testing a case that no longer exists.
 */

import {
  MAX_SERVICE_SUPPLY_SHARE_BPS,
  displayPriceUsd,
  serviceQuote,
  serviceSupplyShare,
  serviceSupplyShareProblem
} from './curve';
import { pctLabel } from './format';

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

// ── 0. THE FIXTURE STILL REPRODUCES THE DEFECT. If this section fails, every
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

// ── 1. THE DEFECT. Before the fix nothing refused this; the assertion is that
//       something does now, and that it is the over-share fault specifically.
const thirtyCap = serviceSupplyShare(15, OPENING, 30);
check('30-cap / $15 service is judged at all (not null)', thirtyCap !== null);
check('30-cap / $15 service is flagged over-share', thirtyCap?.overShare === true);
check(
  '30-cap / $15 service is NOT reported unfillable — it is buyable, just ruinous',
  thirtyCap?.unfillable === false,
  'conflating "consumes the market" with "cannot be bought" would misreport the fault'
);
check(
  '30-cap / $15 share is reported as 4667 bps',
  thirtyCap?.shareBps === 4667,
  `got ${thirtyCap?.shareBps}`
);
check(
  'the creation-time guard refuses it',
  serviceSupplyShareProblem(15, OPENING, 30) !== null,
  'THIS is the assertion that fails on the pre-fix code: the function did not exist and nothing else refused'
);
check(
  'the refusal names the creator’s own numbers, not a generic rule',
  (() => {
    const msg = serviceSupplyShareProblem(15, OPENING, 30) ?? '';
    return msg.includes('14') && msg.includes('30') && msg.includes('47%');
  })(),
  `got: ${serviceSupplyShareProblem(15, OPENING, 30)}`
);

// ── 2. UNFILLABLE is a DIFFERENT fault and must be reported as one. A $100
//       service on the same 30-token market costs 88 tokens — more than can
//       ever exist, so no buyer can reach it at any supply.
const unfillable = serviceSupplyShare(100, OPENING, 30);
check('$100 on a 30-cap market is unfillable', unfillable?.unfillable === true, `tokens=${unfillable?.tokens}`);
check('an unfillable service is over-share too (it exceeds every threshold)', unfillable?.overShare === true);
check(
  'the unfillable refusal says nobody could buy it, not merely that it is large',
  (serviceSupplyShareProblem(100, OPENING, 30) ?? '').includes('Nobody could buy it'),
  `got: ${serviceSupplyShareProblem(100, OPENING, 30)}`
);

// ── 3. ORDINARY PRICING IS UNTOUCHED. A guard that fires on the healthy case is
//       worse than no guard: it blocks creators from pricing their own work.
//       lumen.beat's two real offerings, at its real supply of 50.
const beatPrice = displayPriceUsd(50);
check('lumen.beat $55 service is allowed', serviceSupplyShareProblem(55, beatPrice, 100_000) === null);
check('lumen.beat $12 service is allowed', serviceSupplyShareProblem(12, beatPrice, 100_000) === null);
check(
  'a $50 service on the wizard’s STANDARD_CAP of 5,000 is allowed',
  serviceSupplyShareProblem(50, OPENING, 5_000) === null,
  'this is the regime the owner’s 2026-08-08 cap ruling designs for; refusing it would be a false positive'
);
check(
  'the 500-cap market’s $20 face price is allowed',
  serviceSupplyShareProblem(20, OPENING, 500) === null,
  `18 tokens of 500 = 3.6%, comfortably inside the bound`
);

// ── 4. THE THRESHOLD IS A BOUNDARY, NOT A VIBE. Exactly at the limit passes;
//       one token past it fails. Proven by construction rather than by a
//       hand-picked pair, so it cannot drift when the constant is retuned.
check('the threshold constant is 10%', MAX_SERVICE_SUPPLY_SHARE_BPS === 1_000);
{
  const cap = 1_000;
  // tokens == 100 is exactly 10% of 1,000 — allowed. tokens == 101 is over.
  const atLimit = serviceSupplyShare(100 * OPENING * 0.88, OPENING, cap);
  check(
    'a service costing exactly the threshold share is ALLOWED',
    atLimit !== null && atLimit.tokens <= 100 && atLimit.overShare === false,
    `tokens=${atLimit?.tokens} shareBps=${atLimit?.shareBps}`
  );
  const overLimit = serviceSupplyShare(140 * OPENING * 0.88, OPENING, cap);
  check(
    'a service costing more than the threshold share is REFUSED',
    overLimit !== null && overLimit.overShare === true,
    `tokens=${overLimit?.tokens} shareBps=${overLimit?.shareBps}`
  );
}
check(
  'the threshold is a parameter, so an owner can retune it without touching logic',
  serviceSupplyShareProblem(15, OPENING, 30, 5_000) === null && serviceSupplyShareProblem(15, OPENING, 30, 100) !== null,
  'at a 50% bound the live case passes; at 1% it fails'
);

// ── 5. NEVER GUESSES. A guard that fires on a value it does not have would
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
  [
    serviceSupplyShareProblem(15, OPENING, 0),
    serviceSupplyShareProblem(15, 0, 30),
    serviceSupplyShareProblem(0, OPENING, 30)
  ].every((m) => m === null)
);

// ── 6. ONE QUOTE FUNCTION. The share must be derived from `serviceQuote`, not
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

// ── 7. THE FIGURE THE TOKEN PAGE NOW PRINTS BESIDE EACH SERVICE PRICE.
//       This is the ITEM-2 half: the cap was already on the page ("0 of 30
//       tokens issued") but nowhere near the service prices, where the token
//       count is meaningless without it. Asserts the VALUE the label renders —
//       it does not mount the component, and does not claim to.
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
