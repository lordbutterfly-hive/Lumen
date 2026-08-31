/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * WHAT THE TOKEN PAGE IS ALLOWED TO CLAIM ABOUT MONEY.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/ui/token-page/disclosure-copy.selftest.ts
 *
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECTS.
 *
 * Four disclosure defects were read off the live build (9k0sWWUqu7AcgaakLJfwI)
 * in a browser at /creators/lumen.beat, a real market at supply 50 with 60.153
 * HBD of reserve. Every number quoted below was reproduced against that state
 * through the ported contract math, not reasoned about:
 *
 *   1. The Sell dialog promised "You can always exit."
 *   2. The headline "Floor $1.20" is gross of an early-exit fee that takes up to
 *      20% of it (day 0: $0.962; day 21: $1.082; day 42+: $1.203).
 *   3. "Floor" is not a minimum: reserve ÷ supply is $1.2031 at supply 50 and
 *      $1.0070 at supply 1, and the last holder out of the curve nets $0.907
 *      against a $1.408 headline price, i.e. 36% down, not the 15% a reader
 *      infers from "price $1.41 / floor $1.20".
 *   4. "Market cap $70" led and "Reserve backing $60" was an aside, although all
 *      50 tokens sold into the curve gross $60.15 and net $54.14.
 *
 * Plus a 0 ÷ 0: an untraded market rendered "Floor $0.00".
 *
 * ★ SECTION 7 IS THE ONE THAT MAKES THE REST MEAN ANYTHING. Asserting on
 * exported constants proves the sentences are correct, not that anything renders
 * them. Section 7 scans the two component sources to prove the old strings are
 * gone and the new ones are wired, with comments stripped first (every defect is
 * quoted verbatim in the comments explaining it, so an un-stripped scan would
 * find the old copy in the prose describing its removal) and with byte counts
 * asserted, so a scan that read nothing FAILS instead of passing by absence.
 * Same pattern, same reason, as market/buy-preview.selftest.ts's own wiring
 * section.
 */

import { SHOW_BACKING_FIGURES } from '../../backing-visibility';
import {
  BACKING_PER_TOKEN_ARIA,
  BACKING_PER_TOKEN_LABEL,
  BACKING_PER_TOKEN_NOTE,
  BACKING_TOTAL_LABEL,
  BACKING_TOTAL_NOTE,
  HONEST_NOTE,
  HONEST_NOTE_BACKING_HIDDEN,
  HOW_IT_WORKS_RESERVE_LINE,
  INTERSTITIAL_LINES,
  INTERSTITIAL_LINES_BACKING_HIDDEN,
  MARKET_CAP_LABEL,
  MARKET_CAP_NOTE,
  WIND_DOWN_BANNER,
  allPublishedCopy,
  backingPerTokenValue,
  buyRiskNote,
  exitRoutesNote,
  honestNote,
  interstitialLines,
  overdueBanner,
  overdueFigures,
  positionLine,
  positionSegments
} from './disclosure-copy';

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

/** U+2014 em dash and U+2013 en dash. The two the house rule names. */
const DASHES = /[—–]/;

console.log('\n── 1. HOUSE STYLE. No em or en dash in anything this module publishes.\n');
{
  const copy = allPublishedCopy();

  // ── Non-vacuity. A sweep with nothing to sweep must FAIL, never pass.
  check('the sweep collected copy to inspect', copy.length >= 18, `${copy.length} strings`);
  check(
    '…and they are real sentences, not empty placeholders',
    copy.every((s) => typeof s === 'string' && s.length > 0) &&
      copy.join('').length > 1_500,
    `${copy.join('').length} bytes across ${copy.length} strings`
  );

  // ── The detector can actually fire. A guard that cannot reach the failure it
  //    exists to catch is a guard that passes forever.
  check('the dash detector fires on a known-bad string', DASHES.test('You can always exit — really'));
  check('…and does not fire on an ordinary hyphen', !DASHES.test('pro-rata early-exit fee'));

  const offenders = copy.filter((s) => DASHES.test(s));
  check('no published string carries an em or en dash', offenders.length === 0, offenders.join('\n      '));
}

console.log('\n── 2. THE UNCONDITIONAL GUARANTEE IS GONE (defect 1).\n');
{
  const sell = exitRoutesNote(false);
  const redeem = exitRoutesNote(true);

  check('the sell line no longer promises "you can always exit"', !sell.includes('You can always exit'));
  check(
    '…and makes no "always" claim of any kind about getting out',
    !/\balways\b/i.test(sell),
    `got: ${sell}`
  );
  check(
    '…it names the curve route and says it closes',
    sell.includes('sell on the curve') && sell.includes('selling closes'),
    `got: ${sell}`
  );
  // 2026-08-30 (B3, copy set A): the door is named without "your share".
  check('…it names the redeem route as the other door', sell.includes('the only exit is Redeem'));
  check(
    '★ …and it states the thing the old line denied: neither route is a fixed price',
    sell.includes('Neither is a fixed price'),
    `got: ${sell}`
  );
  check(
    '★ …contingent on the reserve, which is what a buyback on a curve actually depends on',
    sell.includes('what the reserve holds'),
    `got: ${sell}`
  );

  check('the redeem line names the deduction it takes', redeem.includes('less your early-exit fee'));
  check(
    '★ the sell line reads as one sentence, not "Neither … it"',
    sell.includes('Neither is a fixed price: what you get depends on'),
    `got: ${sell}`
  );
  check(
    '…and no longer says redeeming pays "at the floor", a word this page retired',
    !redeem.toLowerCase().includes('floor'),
    `got: ${redeem}`
  );
  check('the two rails genuinely say different things', sell !== redeem);
}

console.log('\n── 3. THE GROSS FIGURE IS LABELLED AS GROSS (defect 2).\n');
{
  // Every surface that quotes the per-token figure must name the deduction, or
  // the reader is told a number they will not receive.
  const quoting: [string, string][] = [
    ['the ? explainer', BACKING_PER_TOKEN_NOTE],
    // ★ `true` EXPLICITLY. These four assertions are about the copy that quotes
    //   the figure, and since 2026-08-27 that branch is not the default (the
    //   stat is hidden for launch). Without the argument they would silently
    //   start testing the OTHER string and pass or fail for the wrong reason.
    ['the buy dialog', buyRiskNote('$1.20', true)],
    ['the interstitial', INTERSTITIAL_LINES[2]],
    ['the closing note', HONEST_NOTE]
  ];
  for (const [where, text] of quoting) {
    check(`${where} names the early-exit fee the figure is before`, /before your early-exit fee/.test(text), `got: ${text}`);
    check(`${where} says it is not a price you can sell at`, /not a price you can sell at/.test(text), `got: ${text}`);
  }

  // ★ AND IT MUST NOT BLAME THE WRONG FEE. The audit attributed the gap to the
  //   10% trade fee. refundNetBaseUnits charges no trade fee at all ("Unlike
  //   Sell there is NO trade fee here"), so copy saying a wind-down is docked
  //   10% would be a second false statement dressed as a correction.
  check(
    '★ the closing note says the wind-down route pays no trade fee',
    HONEST_NOTE.includes('with no trade fee on that route'),
    `got: ${HONEST_NOTE}`
  );
  check(
    '★ …and scopes the 10% to the curve, where it is actually charged',
    HONEST_NOTE.includes('Every trade on the curve pays a 10% fee'),
    `got: ${HONEST_NOTE}`
  );
  check('the closing note still names the fee split', HONEST_NOTE.includes('(5% to the creator, 5% to Lumen)'));
  check('…and the 6-week decay, which is EXIT_FEE_DAYS = 42', HONEST_NOTE.includes('fades to zero over 6 weeks'));
}

console.log('\n── 4. "FLOOR" NO LONGER DOES WORK THE NUMBER CANNOT SUPPORT (defect 3).\n');
{
  check('the stat is named for what it is', BACKING_PER_TOKEN_LABEL === 'Backing per token');
  check('…and the retired word appears in no published string', !allPublishedCopy().some((s) => /floor/i.test(s)));
  check(
    '★ the explainer states the definition, so the name is checkable',
    BACKING_PER_TOKEN_NOTE.startsWith('The reserve divided by the tokens issued.'),
    `got: ${BACKING_PER_TOKEN_NOTE}`
  );
  check(
    '★ …and that it FALLS, which is the property a floor cannot have',
    BACKING_PER_TOKEN_NOTE.includes('It drops as holders sell'),
    `got: ${BACKING_PER_TOKEN_NOTE}`
  );
  check(
    '★ the closing note states the cascade a reader cannot see from one number',
    HONEST_NOTE.includes('that price falls as you sell, so the last holder out gets less than the first'),
    `got: ${HONEST_NOTE}`
  );
  check(
    'the screen-reader label carries the same sentence, not a shorter one',
    // Length, not `!==`: both are string LITERAL types here, and tsc rejects an
    // inequality between two literals it can already prove differ (TS2367).
    BACKING_PER_TOKEN_ARIA.endsWith(BACKING_PER_TOKEN_NOTE) &&
      BACKING_PER_TOKEN_ARIA.length > BACKING_PER_TOKEN_NOTE.length
  );
  check(
    'the interstitial dropped "not a price you can ALWAYS sell at" — the qualifier implied there was such a time',
    !INTERSTITIAL_LINES[2].includes('always sell at')
  );
  check(
    '★ and its buy-side warning is unconditional, because a rising convex curve puts the price above the average at every supply',
    INTERSTITIAL_LINES[1].includes('always above what the reserve holds per token'),
    `got: ${INTERSTITIAL_LINES[1]}`
  );
  check('the two interstitial lines that were already true are untouched', INTERSTITIAL_LINES.length === 4 &&
    INTERSTITIAL_LINES[0] === 'This is a real token whose price goes up and down.' &&
    INTERSTITIAL_LINES[3] === 'Selling soon after buying has an early-exit fee that fades to zero over 6 weeks.');
}

console.log('\n── 5. THE HONEST NUMBER LEADS AND THE FICTION IS THE ASIDE (defect 4).\n');
{
  check('the headline stat is the reserve', BACKING_TOTAL_LABEL === 'Reserve backing');
  check('the market cap keeps its own name where it is shown', MARKET_CAP_LABEL === 'Market cap');
  check(
    '★ …and it is shown with the sentence that refuses it',
    MARKET_CAP_NOTE.includes('No holder can take that out') && MARKET_CAP_NOTE.includes('walks the price back down the curve'),
    `got: ${MARKET_CAP_NOTE}`
  );
  check('the market-cap note also states the arithmetic it is refusing', MARKET_CAP_NOTE.startsWith('The token price times every token issued.'));
  check('the reserve keeps the explanation the rail card used to carry', BACKING_TOTAL_NOTE.includes('actually held') && BACKING_TOTAL_NOTE.includes('wind-down pays out of this'));
  // 2026-08-30 (B3, copy set A): "that reserve is what a wind-down pays out" was
  // itself the promise being removed (a payout that arrives). The property this
  // check guards, "not the gross as the payout", survives; the positive half now
  // pins the claim-a-slice-less-fee wording.
  check(
    'the how-it-works line no longer states the gross as the payout',
    !HOW_IT_WORKS_RESERVE_LINE.includes('would pay out per token') &&
      !HOW_IT_WORKS_RESERVE_LINE.includes('pays out') &&
      HOW_IT_WORKS_RESERVE_LINE.includes('claim a pro-rata slice of it, less their early-exit fee')
  );
  check('the wind-down banner names the deduction on the only open door', WIND_DOWN_BANNER.includes('less your early-exit fee'));
}

console.log('\n── 6. THE 0 ÷ 0, AND THE THREE STATES IT WAS COLLAPSING.\n');
{
  check('an untraded market says there is nothing yet, not "$0.00"', backingPerTokenValue(0, 0) === 'None yet');
  check('…including when the reserve is also absent', backingPerTokenValue(Number.NaN, 0) === 'None yet');
  check('…and for a negative or nonsense supply', backingPerTokenValue(1.2, -1) === 'None yet' && backingPerTokenValue(1.2, Number.NaN) === 'None yet');
  check('a real figure still renders as money', backingPerTokenValue(1.203, 50) === '$1.20');
  check(
    '★ a GENUINE zero with tokens outstanding is still printed — that is a drained reserve, and true',
    backingPerTokenValue(0, 50) === '$0.00'
  );
  check(
    '★ an unreadable figure is not called zero',
    backingPerTokenValue(Number.NaN, 50) === 'Unavailable' && backingPerTokenValue(Number.POSITIVE_INFINITY, 50) === 'Unavailable'
  );
  check('the placeholder carries no dash of its own', !DASHES.test(backingPerTokenValue(0, 0)));
  check(
    '★ the buy dialog drops its parenthetical rather than printing "(None yet)" on the first buy of a market',
    buyRiskNote(backingPerTokenValue(0, 0), true).includes('Backing per token is the reserve divided') &&
      !buyRiskNote(backingPerTokenValue(0, 0), true).includes('('),
    `got: ${buyRiskNote(backingPerTokenValue(0, 0), true)}`
  );
  check(
    '…and still quotes it when there is one',
    buyRiskNote(backingPerTokenValue(1.203, 50), true).includes('Backing per token ($1.20) is')
  );

  // The overdue banner interpolates that value, so it must not end "(currently  a token)".
  check('the overdue banner quotes the figure when there is one', overdueBanner(overdueFigures('$1.20', 1.408, true), 'v2').includes('(currently $1.20 a token before your early-exit fee, against $1.41 now)'));
  check(
    '★ …and quotes nothing at all when there is not, rather than an empty parenthesis',
    overdueBanner(overdueFigures('None yet', 1.007, true), 'v2').endsWith('if the creator renews.') &&
      !overdueBanner(overdueFigures('None yet', 1.007, true), 'v2').includes('('),
    `got: ${overdueBanner(overdueFigures('None yet', 1.007, true), 'v2')}`
  );
  check('…same for an unreadable one', overdueFigures('Unavailable', 1.4, true) === '');
}

console.log('\n── 6b. THE POSITION ROW NAMES BOTH FIGURES FOR WHAT THEY ARE.\n');
{
  const line = positionLine('12.00', 16.9, 14.44);
  check('the mark is labelled as a mark, not as "worth"', line.includes('$16.90 at today’s price') && !line.includes('worth'));
  // 2026-08-30 (B3, copy set A): the verb is the holder's, not the market's.
  check('the redeemable figure says what it is', line.includes('$14.44 if you redeemed at a wind-down today'));
  check('…and no longer calls itself a "floor value"', !/floor/i.test(line));
  check('the token count still leads', line.startsWith('You hold 12.00 tokens'));

  // ★ The segments exist so the row keeps its emphasis. A plain string would
  //   have dropped three <strong> wrappers under cover of a copy fix.
  const segs = positionSegments('12.00', 16.9, 14.44);
  check('★ exactly three figures are emphasised, as before', segs.filter((s) => s.strong).length === 3);
  check('…they are the token count and the two dollar figures', segs.filter((s) => s.strong).map((s) => s.text).join('|') === '12.00 tokens|$16.90|$14.44');
  check('…and the segments reassemble into the line exactly', segs.map((s) => s.text).join('') === line);
}

console.log('\n── 7. WIRING. The components really render this, and no longer render the old copy.\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const viewSrc = readFileSync(join(__dirname, 'token-market-view.tsx'), 'utf8');
  const modalSrc = readFileSync(join(__dirname, 'token-modals.tsx'), 'utf8');
  const view = strip(viewSrc);
  const modal = strip(modalSrc);

  // ── Non-vacuity. A scan with nothing to inspect must FAIL, never pass.
  check('the scan read token-market-view.tsx', viewSrc.length > 20_000, `${viewSrc.length} bytes`);
  check('the scan read token-modals.tsx', modalSrc.length > 20_000, `${modalSrc.length} bytes`);
  check('comment stripping left the code behind', view.length > 10_000 && modal.length > 10_000, `${view.length} / ${modal.length} bytes after stripping`);
  check(
    '★ …and it really did strip: the ★ notes explaining these defects quote the old copy verbatim',
    viewSrc.includes('"Floor ? $0.00"') && !view.includes('"Floor ? $0.00"')
  );
  check(
    '★ the stripper did not eat live code (a negative control that must stay TRUE)',
    // ★ THE LANDMARK MOVED, AND THAT IS THE LESSON (2026-08-28). This negative
    // control anchored on a piece of USER-FACING COPY, so a copy edit (the em
    // dash sweep) broke a check about the STRIPPER. A landmark should be code
    // that changes for structural reasons, not a sentence a reader sees. Kept
    // pointing at the same expression, now with its current separator; the
    // assertion below is deliberately the `usdPrice(q.receiveUsd)` CALL, which
    // is the part that cannot change without the feature changing.
    modal.includes('usdPrice(q.receiveUsd)'),
    'the Sell CTA is pre-existing copy this pass deliberately left alone; if this line fails, the stripper is broken, not the copy'
  );

  // ── Defect 4: the two figures swapped places. Sliced at `const rightRail`,
  //    which survives comment stripping; everything after the component's
  //    `return (` is the page body.
  const cardStart = view.indexOf('const marketCapCard');
  const railStart = view.indexOf('const rightRail');
  const railEnd = view.indexOf('return (', railStart);
  const card = cardStart >= 0 && railStart > cardStart ? view.slice(cardStart, railStart) : '';
  const rail = railStart >= 0 && railEnd > railStart ? view.slice(railStart, railEnd) : '';
  const body = railEnd > 0 ? view.slice(railEnd) : '';
  check('the market-cap card was located and sliced', card.length > 100, `${card.length} bytes`);
  check('the right rail was located and sliced', rail.length > 500, `${rail.length} bytes`);
  check('the page body was located and sliced', body.length > 5_000, `${body.length} bytes`);
  check('★ the market cap is defined once, with its label and its note', card.includes('{MARKET_CAP_LABEL}') && card.includes('{MARKET_CAP_NOTE}'));
  check('★ …and the right rail renders it', rail.includes('{marketCapCard}'));
  /**
   * ★★★ 2026-08-27 — THIS PAIR REPLACES A CHECK THAT PASSED WHILE THE FIGURE WAS
   * INVISIBLE. The old assertion was "…and NOT in the headline row any more",
   * written as `!body.includes('MARKET_CAP_LABEL')`. It was satisfied by the
   * disclosure pass moving the card into the right rail — and
   * ../token-shell.tsx:74 renders that rail `hidden … xl:block`, xl being stock
   * 1280px, so from a phone, a tablet or any sub-1280 desktop window the number
   * was GONE, not demoted. Verified live: `body.innerText.includes('Market cap')`
   * false at 1279px, true at 1400px.
   *
   * The invariant that was actually wanted is two-sided: market cap must not be
   * in the HEADLINE STATS (the reserve took that slot) and must still REACH a
   * narrow reader. So the headline row is sliced on its own and checked, and the
   * body is required to render the card behind `xl:hidden`, the exact complement
   * of the shell's `xl:block`.
   */
  const statsStart = body.indexOf('tracking-hero');
  const statsEnd = body.indexOf('tokens issued', statsStart);
  const stats = statsStart >= 0 && statsEnd > statsStart ? body.slice(statsStart, statsEnd) : '';
  check('the headline stats row was located and sliced', stats.length > 500, `${stats.length} bytes`);
  check('★ …and it is the right slice (it holds the reserve and the backing-per-token figures)', stats.includes('{BACKING_TOTAL_LABEL}') && stats.includes('{BACKING_PER_TOKEN_LABEL}'));
  check('★ the market cap is NOT in the headline stats row', !stats.includes('MARKET_CAP_LABEL') && !stats.includes('marketCapCard'));
  check('★ …but it IS rendered in the body for viewports the rail never reaches', body.includes('xl:hidden">{marketCapCard}'));
  check(
    '★ …and exactly once at any width: the body copy hides at xl, where the rail appears',
    (body.match(/\{marketCapCard\}/g) ?? []).length === 1 && body.includes('xl:hidden'),
    'token-shell.tsx:74 renders the rail `hidden … xl:block`; the body copy must be its exact complement'
  );
  check('★ the reserve is rendered in the headline row', body.includes('{BACKING_TOTAL_LABEL}') && body.includes('usdWholeNonZero(market.reserveUsd)'));
  check('★ …and the rail no longer holds it', !rail.includes('BACKING_TOTAL_LABEL'));
  check('the retired rail sentence is gone', !view.includes('Held in reserve behind every token'));
  check('the reserve figure no longer rounds a real balance to "$0"', !view.includes('usdWhole(market.reserveUsd)'));

  // ── Defect 3: the label and the 0 ÷ 0.
  check('★ the headline stat renders the renamed label', body.includes('{BACKING_PER_TOKEN_LABEL}'));
  check('★ …and the guarded value, not the raw formatter', body.includes('backingPerTokenValue(market.floorUsd, market.supply)') && !view.includes('usdPrice(market.floorUsd)'));
  check('the old "Floor" label is gone from the view', !/\n\s*Floor\n/.test(view) && !view.includes('>Floor<'));
  check('the ? explainer is announced as well as hovered', body.includes('aria-label={BACKING_PER_TOKEN_ARIA}') && body.includes('title={BACKING_PER_TOKEN_NOTE}'));
  check('the reserve total kept an explainer too', body.includes('title={BACKING_TOTAL_NOTE}'));

  // ── Defect 2 + the banners + the position row.
  check('the closing note is the shared one', body.includes('{honestNote()}'));
  check('…and the old paragraph is gone', !view.includes('The floor above is what the reserve would pay out'));
  check('the wind-down banner is the shared one', body.includes('{WIND_DOWN_BANNER}'));
  check('the overdue banner is built from the guarded figure', body.includes('overdueBanner(overdueFigures(backingPerTokenValue(market.floorUsd, market.supply), market.priceUsd), market.rules)'));
  check('the position row renders segments so it keeps its emphasis', body.includes('positionSegments(tok(market.position.tokens)') && body.includes('<strong key={i}'));
  check('…and the old "worth / floor value" row is gone', !view.includes('· floor value') && !view.includes('· worth'));
  check('the how-it-works rail uses the rewritten line', view.includes('HOW_IT_WORKS_RESERVE_LINE'));
  check(
    '…and lines 1 and 2 are still inline and untouched, which is the point of moving only line 3',
    // ★ ASSERTED ON A STABLE FRAGMENT, NOT THE WHOLE SENTENCE (2026-08-28). This
    // pinned line 2 including its trailing punctuation, so the em dash sweep
    // broke a check whose actual claim is "lines 1 and 2 are still INLINE rather
    // than moved into the shared copy module". Punctuation is not what that
    // claim is about; the distinctive wording is.
    view.includes('Buy the creator’s token. The price rises as more is bought.') &&
      view.includes('A question, a code review, a day of building')
  );

  // ── Defect 1 + the modals.
  // ★ ASSERTED ON THE STRIPPED SOURCE, AND THAT IS NOT A WEAKENING. The raw file
  //   still contains "You can always exit." — inside the ★ comment explaining
  //   why it was removed. Checking `modalSrc` here failed for exactly that
  //   reason on the first run, which is the same trap market/buy-preview
  //   .selftest.ts's stripper doc warns about. The pair below proves both halves:
  //   the sentence survives only as prose about its own removal.
  check('the removed promise survives only inside a comment', modalSrc.includes('You can always exit.'));
  check('★ the Sell dialog no longer renders "You can always exit"', !modal.includes('You can always exit.'));
  check('★ …and renders the shared, promise-free line', modal.includes('{exitRoutesNote(redeem)}'));
  check('the interstitial renders the shared lines', modal.includes('interstitialLines().map'));
  check('…and its old literals are gone', !view.includes('If you buy from the market above the floor') && !modal.includes('If you buy from the market above the floor'));
  check('the buy dialog renders the shared risk note', modal.includes('buyRiskNote(backingPerTokenValue(m.floorUsd, m.supply))'));
  check('…and its old paragraph is gone', !modal.includes('is what the reserve would'));

  // ── Defect 5 (house style): the one em dash in copy this session changed.
  check('★ the Buy CTA reads without an em dash', modal.includes('`Buy for ~${usdPrice(q.totalUsd)}`'));
  check(
    '★ …and the old dashed label is gone',
    !modal.includes('`Buy — ${usdPrice(q.totalUsd)}`')
  );
  /**
   * ★ 2026-08-27, F-E: the tilde. The bare `Buy for $X` this test asserted an
   * hour earlier named the LOCAL quote, while handleBuy re-quotes live and signs
   * a ceiling of `maxTotalUsd ?? usd` — so the charge can land above the label
   * and still execute (measured: $50 budget at supply 50, label $48.59, charged
   * $49.90 after +5 supply of drift). Every sibling estimate in these dialogs
   * carries ≈ or ~; this one now does too, and the line under the button names
   * the ceiling that binds. See trade-preview.ts buyCeilingNote.
   */
  check('★ the Buy CTA is marked as the estimate it is', modal.includes('`Buy for ~${usdPrice(q.totalUsd)}`'));
  check('★ …and the button names the ceiling that actually binds', modal.includes('buyCeilingNote(maxTotalUsd ?? usd, maxTotalUsd !== undefined)'));
  check(
    'the unreadable-balance sentence lost its dash too',
    !readFileSync(join(__dirname, 'sell-empty-state.ts'), 'utf8').includes('safe on-chain —')
  );
}

console.log('\n── 8. THE LAUNCH HIDE (owner 2026-08-27). No sentence points at a figure that is not on the screen.\n');
{
  /**
   * ★ THE DANGLING POINTER IS THE DEFECT, not the missing number. Hiding the
   * stat and leaving "Backing per token, shown above ..." in the closing
   * paragraph would send a reader looking for something that is not there, which
   * is worse than either showing it or hiding it cleanly. These phrases are the
   * exact directions the copy used to give.
   */
  const POINTERS = ['shown above', 'shown next to the price', 'Backing per token', 'backing per token'];
  const hiddenCopy = [
    HONEST_NOTE_BACKING_HIDDEN,
    ...INTERSTITIAL_LINES_BACKING_HIDDEN,
    buyRiskNote('$1.20', false),
    buyRiskNote(backingPerTokenValue(0, 0), false),
    overdueBanner(overdueFigures('$1.20', 1.408, false), 'v2')
  ];

  // ── Non-vacuity. A sweep of nothing must FAIL, and a detector that cannot
  //    fire proves nothing about the strings it passed over.
  check('the hidden-branch sweep collected copy to inspect', hiddenCopy.length >= 7 && hiddenCopy.join('').length > 700, `${hiddenCopy.join('').length} bytes across ${hiddenCopy.length} strings`);
  check('★ the pointer detector fires on the copy it was written for', POINTERS.some((ph) => HONEST_NOTE.includes(ph)) && POINTERS.some((ph) => INTERSTITIAL_LINES[2].includes(ph)));

  const dangling = hiddenCopy.filter((t) => POINTERS.some((ph) => t.includes(ph)));
  check('★ no hidden-branch sentence points at the hidden figure', dangling.length === 0, dangling.join('\n      '));
  check('…nor names it by its retired word', !hiddenCopy.some((t) => /floor/i.test(t)), hiddenCopy.filter((t) => /floor/i.test(t)).join('\n      '));

  // ── What must SURVIVE the hide. Removing a disclosure is the failure mode on
  //    the other side, and it is the one that costs someone money.
  check('★ the closing note keeps the 10% fee and its split', HONEST_NOTE_BACKING_HIDDEN.includes('Every trade on the curve pays a 10% fee (5% to the creator, 5% to Lumen)'));
  check('★ …and the 6-week early-exit decay', HONEST_NOTE_BACKING_HIDDEN.includes('fades to zero over 6 weeks'));
  check('★ …and the cascade, which is the real downside a price alone hides', HONEST_NOTE_BACKING_HIDDEN.includes('that price falls as you sell, so the last holder out gets less than the first'));
  check('★ …and it still opens by saying you can lose money', HONEST_NOTE_BACKING_HIDDEN.startsWith('This token’s price floats. It can go up or down, and you can lose money.'));
  check('★ the buy dialog still warns about both fees and the float', buyRiskNote('$1.20', false).includes('price floats and you can lose money') && buyRiskNote('$1.20', false).includes('early-exit fee applies on top of the trade fee'));
  check('★ the interstitial keeps the loss warning and the fee', INTERSTITIAL_LINES_BACKING_HIDDEN.some((l) => l.includes('You can get back less than you paid')) && INTERSTITIAL_LINES_BACKING_HIDDEN.some((l) => l.includes('fades to zero over 6 weeks')));
  check('…and its first line is untouched', INTERSTITIAL_LINES_BACKING_HIDDEN[0] === INTERSTITIAL_LINES[0]);
  check('★ exactly one line was dropped, not a rewrite of the set', INTERSTITIAL_LINES_BACKING_HIDDEN.length === INTERSTITIAL_LINES.length - 1);

  // ── The overdue banner. The warning must survive; only the figure goes.
  const overdueHidden = overdueBanner(overdueFigures('$1.20', 1.408, false), 'v2');
  check(
    '★ the overdue banner still warns that buying stops, with no figure in it',
    overdueHidden.includes('stops taking new buyers') && !overdueHidden.includes('$1.20'),
    overdueHidden
  );

  // ── The selectors follow the flag, in both directions. A selector that
  //    ignored its argument would pass every assertion above by accident.
  check('★ honestNote(true) is the original paragraph, verbatim', honestNote(true) === HONEST_NOTE);
  check('★ honestNote(false) is the standalone one', honestNote(false) === HONEST_NOTE_BACKING_HIDDEN);
  // Length and content, not `!==`: both are string LITERAL types here and tsc
  // rejects an inequality between two literals it can already prove differ
  // (TS2367). Same workaround, same reason, as the ARIA check in section 4.
  check(
    '★ …and they genuinely differ, by exactly the two sentences about the hidden stat',
    HONEST_NOTE.length > HONEST_NOTE_BACKING_HIDDEN.length &&
      HONEST_NOTE.includes('Backing per token, shown above') &&
      !HONEST_NOTE_BACKING_HIDDEN.includes('Backing per token')
  );
  check('★ interstitialLines follows its argument too', interstitialLines(true) === INTERSTITIAL_LINES && interstitialLines(false) === INTERSTITIAL_LINES_BACKING_HIDDEN);
  check('★ buyRiskNote follows its argument', buyRiskNote('$1.20', true) !== buyRiskNote('$1.20', false));
  check('★ overdueFigures follows its argument', overdueFigures('$1.20', 1.408, true) !== '' && overdueFigures('$1.20', 1.408, false) === '');

  // ── And the DEFAULT is the flag, which is what actually ships. Written
  //    against the flag rather than against `false` so this keeps testing the
  //    real wiring after the owner flips it back on.
  check('★ every selector defaults to SHOW_BACKING_FIGURES, so the page renders what the flag says', honestNote() === honestNote(SHOW_BACKING_FIGURES) && interstitialLines() === interstitialLines(SHOW_BACKING_FIGURES) && buyRiskNote('$1.20') === buyRiskNote('$1.20', SHOW_BACKING_FIGURES) && overdueFigures('$1.20', 1.408) === overdueFigures('$1.20', 1.408, SHOW_BACKING_FIGURES));
  check('the flag is off for launch, which is the state being shipped', SHOW_BACKING_FIGURES === false);
}


console.log('\n── THE OVERDUE BANNER IS GATED ON THE CHAIN OWN RULES ────────────');
{
  const v2 = overdueBanner('', 'v2');
  const v1 = overdueBanner('', 'v1');
  // POSITIVE controls: each branch states its own truth.
  check('★ v2 says the curve sell stays open', /still sell on the curve/i.test(v2), v2);
  check('★ v1 says the market winds down to a redeem', /winds down/i.test(v1) && /redeem/i.test(v1), v1);
  // NEGATIVE controls, which are the half that makes this a test. A copy check
  // asserting only the presence of its own words passes just as happily on a
  // sentence that ALSO contains the opposite claim.
  check('★ v2 never claims a wind-down', !/winds down/i.test(v2), v2);
  check('★ v1 never claims the curve stays open', !/still sell on the curve/i.test(v1), v1);
  check('★ the two branches are genuinely different strings', v1 !== v2);
  check(
    '★ the quoted figure survives both branches, so gating did not drop it',
    overdueBanner(overdueFigures('$1.20', 1.408, true), 'v1').includes('$1.20') &&
      overdueBanner(overdueFigures('$1.20', 1.408, true), 'v2').includes('$1.20')
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
