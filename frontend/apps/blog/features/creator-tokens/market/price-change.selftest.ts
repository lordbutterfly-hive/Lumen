/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * HOW MUCH THE PRICE MOVED, AND WHAT THE PAGE IS ALLOWED TO CLAIM ABOUT IT.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/market/price-change.selftest.ts
 *
 * WHAT THIS PROVES, AND WHAT IT WOULD HAVE CAUGHT.
 *
 * The token page carried a price and a chart and NOTHING that said how far the
 * price had come. What it did carry was `changePctWeek`, and every part of that
 * was wrong in a way this file now fails on:
 *
 *   1. IT WAS NOT WEEKLY. `weekChangePct`'s own doc admitted it ("Deliberately
 *      NOT windowed to exactly seven days"), and the field it fed was named for
 *      a week anyway. The rendered figure inherited the name and stated no
 *      window at all: a bare "▲ 6.2%" over an unspecified span.
 *   2. IT PUT AN UP ARROW ON A MARKET THAT HAD NOT MOVED. The test was
 *      `changePctWeek >= 0 ? '▲' : '▼'`, so an exactly flat series rendered
 *      "▲ 0%", which is a claim about direction where there is no direction.
 *   3. A REAL MOVE COULD ROUND TO "0%". `Math.round(pct * 1000) / 10` prints
 *      0 for +0.04%, and the page would then have said a market that moved did
 *      not. Exactly the class `pctLabel` and `usdWholeNonZero` already exist to
 *      refuse, one screen over.
 *   4. THE ARROW WAS THE ONLY NON-COLOUR SIGNAL, and it was inside the text, so
 *      a screen reader announced "black up-pointing triangle 6.2 percent".
 *
 * ★ SECTION 5 IS THE ONE THAT MAKES THE REST MEAN ANYTHING. Asserting on a pure
 * function proves the arithmetic, not that anything renders it. Section 5 scans
 * live/adapt.ts and the token page to prove the old field is gone and the new
 * one is wired, comments stripped first (this file's own defects are quoted
 * verbatim in the comments explaining them) and byte counts asserted, so a scan
 * that read nothing FAILS rather than passing by absence. Same pattern and same
 * reason as disclosure-copy.selftest.ts section 7.
 */

import { pctMoveLabel } from './format';
import { priceChangeLabel, priceChangeOf } from './price-change';

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

console.log('\n── 1. THE ARITHMETIC.\n');
{
  const doubled = priceChangeOf([1, 2]);
  check('a doubling reads as +100%', doubled !== null && Math.abs(doubled.pct - 100) < 1e-9, JSON.stringify(doubled));
  check('…up, over the two trades it actually spans', doubled?.direction === 'up' && doubled?.trades === 2);

  const halved = priceChangeOf([2, 1]);
  check('a halving reads as -50%', halved !== null && Math.abs(halved.pct + 50) < 1e-9, JSON.stringify(halved));
  check('…and down', halved?.direction === 'down');

  const long = priceChangeOf([1, 1.2, 1.5, 1.9, 4]);
  check('★ only the ENDPOINTS matter, not the path between them', long !== null && Math.abs(long.pct - 300) < 1e-9, JSON.stringify(long));
  check('…and the basis counts every point, which is what the chart caption counts', long?.trades === 5);

  const flat = priceChangeOf([1.4, 1.4, 1.4]);
  check('an exactly flat series is flat, not up', flat?.direction === 'flat' && flat?.pct === 0, JSON.stringify(flat));

  const tiny = priceChangeOf([1, 1.0004]);
  check('★ a 0.04% move is UP, not flat: rounding is a display concern, not a fact', tiny?.direction === 'up' && tiny !== null && tiny.pct > 0 && tiny.pct < 0.05, JSON.stringify(tiny));
}

console.log('\n── 2. THE NULL CASES. Nothing is claimed where nothing is known.\n');
{
  check('no series at all', priceChangeOf(null) === null && priceChangeOf(undefined) === null);
  check('an empty series', priceChangeOf([]) === null);
  check('★ ONE point: a market that traded once has a price, not a trajectory', priceChangeOf([1.4]) === null);
  check('★ …the SAME bound the chart uses, so a percentage never appears beside an empty chart slot', priceChangeOf([1.4]) === null && priceChangeOf([1.4, 1.4]) !== null);
  check('an unreadable point poisons the whole series, and is refused', priceChangeOf([Number.NaN, 1]) === null && priceChangeOf([1, Number.NaN]) === null);
  check('…including an infinite one', priceChangeOf([1, Number.POSITIVE_INFINITY]) === null);
  check(
    '★ a zero first point: "up 400% from nothing" is a fabrication, and supply 0 really does price at 0',
    priceChangeOf([0, 1]) === null && priceChangeOf([0, 0]) === null
  );
  check('…and a negative one', priceChangeOf([-1, 1]) === null);

  // ★ Non-vacuity for this whole section: the function must be capable of
  //   returning something. A `priceChangeOf` that returned null unconditionally
  //   would pass every assertion above.
  check('★ NEGATIVE CONTROL: the function does return a change for a good series', priceChangeOf([1, 2]) !== null);
}

console.log('\n── 3. THE LABEL. Colour is never the only signal, and the window is always stated.\n');
{
  const up = priceChangeLabel(priceChangeOf([1, 1.5]));
  check('an up move carries a glyph, not just a colour', up?.mark === '▲');
  check('★ …and SAYS WHAT IT IS OVER, so a reader can check it against the chart', up?.text === '50.0% over 2 trades', `got: ${up?.text}`);
  check('…and has an accessible name that spells out what the glyph means', up?.aria === 'Price up 50.0% across the 2 recorded trades in this market.', `got: ${up?.aria}`);

  const down = priceChangeLabel(priceChangeOf([2, 1.5, 1]));
  check('a down move carries the other glyph', down?.mark === '▼');
  check('…with the magnitude unsigned, because the glyph carries the sign', down?.text === '50.0% over 3 trades', `got: ${down?.text}`);

  const flat = priceChangeLabel(priceChangeOf([1.4, 1.4]));
  check('★ FLAT IS A WORD, NOT AN UP ARROW ON 0% — this is defect 2', flat?.mark === '' && flat?.direction === 'flat');
  check('…and it still states the window', flat?.text === 'Unchanged over 2 trades', `got: ${flat?.text}`);

  const tiny = priceChangeLabel(priceChangeOf([1, 1.0004]));
  check('★ a real 0.04% move does not announce itself as no move — this is defect 3', tiny?.text === '<0.1% over 2 trades' && tiny?.mark === '▲', `got: ${tiny?.text}`);

  check('nothing to say renders nothing', priceChangeLabel(null) === null && priceChangeLabel(priceChangeOf([1.4])) === null);

  // ★ THE WORDING MUST NOT READ AS SENTIMENT OR VOLUME. This is a bonding
  //   curve: the price moved because SUPPLY moved. Nothing here may suggest
  //   demand, momentum, interest or a traded quote.
  const BANNED = ['volume', 'demand', 'momentum', 'interest', 'sentiment', 'traded at', 'last price', 'today', 'this week', '24h', '7d'];
  const rendered = [up, down, flat, tiny].flatMap((l) => (l ? [l.text, l.aria] : []));
  check('★ the label sweep collected something to inspect', rendered.length === 8 && rendered.join('').length > 200, `${rendered.length} strings`);
  check('★ the banned-word detector can fire', BANNED.some((w) => 'trading volume today'.includes(w)));
  const offenders = rendered.filter((t) => BANNED.some((w) => t.toLowerCase().includes(w)));
  check('★ no rendered string implies sentiment, volume or a time window', offenders.length === 0, offenders.join('\n      '));
  check('…and no em or en dash', !rendered.some((t) => /[—–]/.test(t)));
}

console.log('\n── 4. THE FORMATTER IT LEANS ON.\n');
{
  check('an exact zero is a real measured zero', pctMoveLabel(0) === '0%');
  check('★ a move below one decimal is "<0.1%", never "0.0%"', pctMoveLabel(0.04) === '<0.1%' && pctMoveLabel(-0.04) === '<0.1%');
  check('one decimal, always', pctMoveLabel(3.14159) === '3.1%' && pctMoveLabel(50) === '50.0%');
  check('★ it is unsigned: the caller carries direction', pctMoveLabel(-33.333) === '33.3%');
  check('★ and it is NOT clamped to 100, which pctLabel is and a price change must not be', pctMoveLabel(400) === '400.0%');
  check('nothing readable, nothing printed', pctMoveLabel(Number.NaN) === null && pctMoveLabel(Number.POSITIVE_INFINITY) === null);
}

console.log('\n── 5. WIRING. The adapter really computes this, and the page really renders it.\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const adaptSrc = readFileSync(join(__dirname, '..', 'live', 'adapt.ts'), 'utf8');
  const viewSrc = readFileSync(join(__dirname, '..', 'ui', 'token-page', 'token-market-view.tsx'), 'utf8');
  const adapt = strip(adaptSrc);
  const view = strip(viewSrc);

  // ── Non-vacuity. A scan with nothing to inspect must FAIL, never pass.
  check('the scan read live/adapt.ts', adaptSrc.length > 10_000, `${adaptSrc.length} bytes`);
  check('the scan read token-market-view.tsx', viewSrc.length > 20_000, `${viewSrc.length} bytes`);
  check('comment stripping left the code behind', adapt.length > 4_000 && view.length > 10_000, `${adapt.length} / ${view.length} bytes after stripping`);
  check(
    '★ …and it really did strip: the ★ note on this defect quotes the old expression verbatim',
    viewSrc.includes("`▲ 6.2%`") && !view.includes("`▲ 6.2%`")
  );

  check('★ the adapter derives the change from the SAME array the chart gets, not a second read', adapt.includes('priceChange: priceChangeOf(priceHistory ?? null)') && adapt.includes('chart: priceHistory && priceHistory.length >= 2 ? priceHistory : null'));
  check('★ the misnamed weekly field is gone from the adapter', !adapt.includes('changePctWeek') && !adapt.includes('weekChangePct'));
  check('…and from the token page', !view.includes('changePctWeek'));
  check('★ the old "up arrow on zero" expression is gone', !view.includes("'▲' : '▼'"));

  check('★ the page renders the label helper, not raw arithmetic', view.includes('priceChangeLabel(market.priceChange)'));
  check('★ …and renders the glyph, the text and the accessible name', view.includes('{change.mark') && view.includes('{change.text}') && view.includes('{change.aria}'));
  check('★ the glyph is hidden from assistive tech, since "▲" announces as a triangle', view.includes('aria-hidden="true"') && view.includes('className="sr-only"'));
  check('★ the indicator renders NOTHING when there is nothing to say', view.includes('{change ? ('));
  check('★ flat is styled neutrally, not green', view.includes("change.direction === 'up'") && view.includes("change.direction === 'down'"));

  // ── It has to sit beside the PRICE, which is the number the owner asked to
  //    lead with. Sliced from the headline price to the supply bar.
  const start = view.indexOf('tracking-hero');
  const end = view.indexOf('tokens issued', start);
  const headline = start >= 0 && end > start ? view.slice(start, end) : '';
  check('the headline block was located and sliced', headline.length > 400, `${headline.length} bytes`);
  check('★ the indicator is in the headline block, beside the price', headline.includes('{change ? ('));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
