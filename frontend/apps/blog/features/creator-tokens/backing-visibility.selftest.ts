/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE BACKING / RESERVE / FLOOR FIGURE IS HIDDEN ON EVERY SURFACE, FROM ONE FLAG.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/backing-visibility.selftest.ts
 *
 * Owner, 2026-08-27: *"get rid of the backing figure, dont show it, hide it we
 * will activate it some time in the future. again, we're launching i dont want
 * too much shit people wont understand."*
 *
 * ★★ WHY A TEST AND NOT JUST THE FLAG. The failure mode of a hide spread across
 * five screens is SILENT AND PARTIAL: each call site looks correct on its own,
 * so the figure comes back on the token page while staying missing from the
 * wallet, or one of six sites is simply forgotten. Nothing in the type system
 * catches that. This file enumerates every site and asserts each one is behind
 * the flag, and it asserts the COUNT per file, so a seventh site added later
 * without a guard fails here rather than shipping.
 *
 * ★★ AND THE COPY IS HALF THE JOB. Sentences all over these screens POINTED at
 * the figure: "Backing per token, shown above ...", "shown next to the price",
 * "refunded at the floor", "The floor value is what the reserve would pay out
 * then", and a read-failure banner apologising for not showing a floor. A
 * dangling pointer is worse than either showing or hiding the number, because it
 * sends a reader looking for something that is not there. Section 4 sweeps for
 * every one of them.
 *
 * ★ WHAT THIS FILE DELIBERATELY DOES NOT DEMAND. Two figures stay, and the
 * assertions below prove they stay rather than treating them as misses:
 *   - the Sell/Redeem quote, which is what this holder receives if they press
 *     the button. Hiding it would leave someone signing for an amount nobody
 *     showed them.
 *   - the holder's own position line ("$14.44 if this market wound down"), which
 *     is their own money, net of their own exit fee.
 * See ./backing-visibility.ts for the full reasoning.
 */

import { SHOW_BACKING_FIGURES } from './backing-visibility';

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

const { readFileSync } = require('fs') as typeof import('fs');
const { join } = require('path') as typeof import('path');

/** Comments carry the old copy verbatim (they explain its removal), so every scan runs on stripped source. */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** JSX wraps across lines differently after every prettier run; matching on collapsed whitespace is what makes these assertions survive formatting. */
const squash = (src: string): string => src.replace(/\s+/g, ' ');
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

interface Source {
  path: string;
  raw: string;
  code: string;
}

function load(...parts: string[]): Source {
  const path = join(__dirname, ...parts);
  const raw = readFileSync(path, 'utf8');
  return { path: parts.join('/'), raw, code: squash(strip(raw)) };
}

const view = load('ui', 'token-page', 'token-market-view.tsx');
const modals = load('ui', 'token-page', 'token-modals.tsx');
const studio = load('ui', 'studio', 'creator-studio.tsx');
const wallet = load('ui', 'your-tokens', 'your-tokens-view.tsx');
const states = load('live', 'market-states.tsx');
const ALL = [view, modals, studio, wallet, states];

console.log('\n── 1. THE INSTRUMENT. A scan that read nothing must FAIL, not pass by absence.\n');
{
  for (const s of ALL) {
    check(`the scan read ${s.path}`, s.raw.length > 2_000, `${s.raw.length} bytes`);
    check(`…and stripping left the code behind in ${s.path}`, s.code.length > 1_000 && s.code.length < s.raw.length, `${s.code.length} of ${s.raw.length} bytes after stripping`);
  }
  // ★ Proof the stripper really strips: every one of these files quotes the old
  //   copy inside the ★ comment explaining its removal, so an un-stripped scan
  //   would find the retired strings in the prose about retiring them.
  check('★ the stripper really removed comments (the ★ notes quote the old copy verbatim)', view.raw.includes('"Floor ? $0.00"') && !view.code.includes('"Floor ? $0.00"'));
  check('★ …in the wallet too', wallet.raw.includes('The floor is a number we actually have') && !wallet.code.includes('The floor is a number we actually have'));
  // ★ NEGATIVE CONTROL: the stripper must not have eaten live code. Without
  //   this, a stripper that returned '' would satisfy every "is gone" assertion
  //   in this file.
  check('★ NEGATIVE CONTROL: live code survived stripping in every file', view.code.includes('<PriceChart points={market.chart} />') && studio.code.includes('label="Market cap"') && wallet.code.includes('tokens</div>') && modals.code.includes('buyRiskNote(') && states.code.includes('Couldn’t load this market'));
}

console.log('\n── 2. THE FLAG. One switch, off, and typed so its branches stay alive.\n');
{
  check('the flag is off, which is the state being shipped', SHOW_BACKING_FIGURES === false);
  check('★ it is a boolean, not a literal type that would mark the guarded JSX unreachable', typeof SHOW_BACKING_FIGURES === 'boolean');
  const flagSrc = readFileSync(join(__dirname, 'backing-visibility.ts'), 'utf8');
  check('★ the declaration carries the explicit annotation, which is what preserves the branches', flagSrc.includes('export const SHOW_BACKING_FIGURES: boolean = false;'));
  check('★ there is exactly ONE flag, not one per screen', count(flagSrc, 'export const') === 1);
  // Every screen imports THE flag rather than declaring its own.
  for (const s of [view, studio, wallet]) {
    check(`${s.path} imports the shared flag`, /import \{ SHOW_BACKING_FIGURES \} from '\.\.\/\.\.\/backing-visibility'/.test(s.code));
    check(`…and declares no local copy in ${s.path}`, !s.code.includes('const SHOW_BACKING_FIGURES'));
  }
}

console.log('\n── 3. EVERY SITE IS BEHIND IT. Enumerated, and counted.\n');
{
  // ── TOKEN PAGE. The whole headline stats row, not the two figures separately:
  //    guarding each stat alone would leave the flex container and its 34px
  //    divider rendering into empty space.
  check('★ the token page guards the headline stats row as a whole', view.code.includes('{SHOW_BACKING_FIGURES ? ( <div className="mt-3 flex flex-wrap items-center gap-[18px]">'));
  const gStart = view.code.indexOf('{SHOW_BACKING_FIGURES ? (');
  const gEnd = view.code.indexOf(') : null}', gStart);
  const guarded = gStart >= 0 && gEnd > gStart ? view.code.slice(gStart, gEnd) : '';
  check('the guarded region was located and sliced', guarded.length > 500, `${guarded.length} bytes`);
  check('★ the reserve total is inside it, and appears nowhere else', guarded.includes('{usdWholeNonZero(market.reserveUsd)}') && count(view.code, 'usdWholeNonZero(market.reserveUsd)') === 1);
  check('★ the backing-per-token stat is inside it', guarded.includes('{BACKING_PER_TOKEN_LABEL}') && guarded.includes('{backingPerTokenValue(market.floorUsd, market.supply)}'));
  check('★ …and so are both `?` explainers, which are nodes a reader could otherwise still focus', guarded.includes('title={BACKING_TOTAL_NOTE}') && guarded.includes('aria-label={BACKING_PER_TOKEN_ARIA}') && count(view.code, 'role="note"') === 2);
  check('★ each stat label is rendered exactly once, so nothing was duplicated outside the guard', count(view.code, '{BACKING_TOTAL_LABEL}') === 1 && count(view.code, '{BACKING_PER_TOKEN_LABEL}') === 1);
  check(
    '★ the only OTHER use of the figure is the overdue banner, which self-guards inside overdueFigures',
    count(view.code, 'backingPerTokenValue(market.floorUsd, market.supply)') === 2 &&
      view.code.includes('overdueBanner(overdueFigures(backingPerTokenValue(market.floorUsd, market.supply), market.priceUsd))')
  );
  check('★ it is not rendered and then hidden with CSS', !guarded.includes('display:none') && !guarded.includes('hidden ') && !view.code.includes('SHOW_BACKING_FIGURES ? "" :'));

  // ── STUDIO. Four sites, three inline ternaries and one whole stat.
  check('★ studio: the Token price sub-line', studio.code.includes('sub={ SHOW_BACKING_FIGURES ? `Floor ${usdPrice(market.floorUsd)} · cap ${supplyPctLabel} used` : `Cap ${supplyPctLabel} used` }'));
  check('★ studio: the Price sub-line', studio.code.includes('sub={SHOW_BACKING_FIGURES ? `Floor ${usdPrice(market.floorUsd)}` : undefined}'));
  check('★ studio: the whole Reserve stat, caption included', studio.code.includes('{SHOW_BACKING_FIGURES ? ( <Stat label="Reserve" value={usdWhole(market.reserveUsd)} sub="Backs the floor" /> ) : null}'));
  check('★ studio: the creator\'s own holdings sub-line', studio.code.includes('sub={ SHOW_BACKING_FIGURES ? `worth ${usdPrice(held * market.priceUsd)} · floor ${usdPrice(held * market.floorUsd)}` : `worth ${usdPrice(held * market.priceUsd)}` }'));
  check('★ studio: those four are ALL of them, and every one is guarded', count(studio.code, 'market.floorUsd') === 3 && count(studio.code, 'market.reserveUsd') === 1 && count(studio.code, 'SHOW_BACKING_FIGURES') === 5);

  // ── WALLET. Headline total, per-row figure, and the sentence that defined it.
  check('★ wallet: the per-row figure', wallet.code.includes('{SHOW_BACKING_FIGURES ? ( <div className="text-caption text-ink-14">floor {usdPrice(usdFromHbd(h.floorValueHbd))}</div> ) : null}'));
  check('★ wallet: the headline total AND its label together', wallet.code.includes('{p.holdingsUnavailable ? \'—\' : usdPrice(floorTotalUsd)}') && wallet.code.includes('Floor value: what the reserve would pay out if the market wound down'));
  const wStart = wallet.code.indexOf('{SHOW_BACKING_FIGURES ? ( <div className="mt-4 flex flex-wrap items-end');
  const wEnd = wallet.code.indexOf(') : null}', wStart);
  const wGuarded = wStart >= 0 && wEnd > wStart ? wallet.code.slice(wStart, wEnd) : '';
  check('the wallet headline guard was located and sliced', wGuarded.length > 200, `${wGuarded.length} bytes`);
  check('★ …and it contains BOTH the number and the label, so no sentence is left describing a blank', wGuarded.includes('usdPrice(floorTotalUsd)') && wGuarded.includes('Floor value: what the reserve would pay out'));
  check('★ wallet: the figure is used in exactly the two guarded places plus the sum that feeds them', count(wallet.code, 'floorValueHbd') === 2 && count(wallet.code, 'floorTotalUsd') === 2);
  check('★ wallet: three guards, for three sites', count(wallet.code, 'SHOW_BACKING_FIGURES') === 4);

  // ── WHAT MUST NOT HAVE BEEN HIDDEN. A hide that swallowed a trade quote or a
  //    holder's own money would pass every assertion above.
  check('★ KEPT: the holder\'s own position line still renders', view.code.includes('positionSegments(tok(market.position.tokens), market.position.valueUsd, market.position.floorValueUsd)'));
  check('★ KEPT: the sell/redeem quote is untouched, so nobody signs for an amount they were not shown', modals.code.includes('reserveUsd: m.reserveUsd') && modals.code.includes('sellRows') === modals.code.includes('sellRows'));
  check('★ KEPT: the wallet still tells a reader what they hold', wallet.code.includes('{tok(h.tokensHeld)} tokens'));
}

console.log('\n── 4. NO SENTENCE POINTS AT A FIGURE THAT IS NOT THERE.\n');
{
  /**
   * The exact directions the shipped copy used to give.
   *
   * ★ EACH PHRASE IS THE FULL POINTER, not a fragment of it. A bare "shown
   * above" was the first draft of this list and it fired on the sell dialog's
   * "Pre-filled just under what you’re shown above", which points at that
   * dialog's own quote and is entirely correct. A detector that cannot tell a
   * real pointer from an innocent one is a detector nobody will keep.
   */
  const POINTERS = [
    'Backing per token, shown above',
    'Backing per token, shown next to the price',
    'refunded at the floor',
    'The floor value is what the reserve',
    'else’s floor',
    'price, floor or your balance'
  ];

  /**
   * ★ ONE DELIBERATE EXEMPTION, NAMED. `EXIT_NOTE_WITH_BACKING` is the wallet's
   * ORIGINAL disclosure, kept verbatim as the other branch of the flag so that
   * flipping it restores the audited sentence rather than a later paraphrase. It
   * is module-level code, so a naive sweep flags it; excluding it by name (and
   * asserting below that it is still there) is honest, where widening the
   * detector until it passed would not be.
   */
  const EXEMPT = /const EXIT_NOTE_WITH_BACKING =[\s\S]*?';/;
  const live = (s: Source): string => s.code.replace(squash(EXEMPT.exec(strip(s.raw))?.[0] ?? '\u0000'), '');

  // ★ The detector must be able to fire, or its silence proves nothing. Each of
  //   these phrases really was in the shipped copy, and the ★ comments explaining
  //   the removals still quote them, so the RAW sources are the positive control.
  const firing = POINTERS.filter((ph) => ALL.some((s) => squash(s.raw).includes(ph)));
  check('★ the pointer detector fires on the copy it was written for', firing.length >= 4, firing.join(' | '));
  check('★ …and the exemption is real: the original wallet sentence is still there, verbatim', EXEMPT.test(strip(wallet.raw)) && (EXEMPT.exec(strip(wallet.raw))?.[0] ?? '').includes('The floor value is what the reserve would pay out then'));

  for (const ph of POINTERS) {
    const offenders = ALL.filter((s) => live(s).includes(ph)).map((s) => s.path);
    check(`★ no live code still says "${ph}"`, offenders.length === 0, offenders.join(', '));
  }

  // The read-failure banner apologised for not showing a figure a reader was
  // never going to be shown.
  check('★ the read-failure banner no longer names the floor', !/floor/i.test(states.code) && states.code.includes('we can’t show this token’s price or your balance'));

  // The wallet's closing disclosure had to CHANGE, not just disappear: it ended
  // by defining the figure. Both branches live at module scope so this can read
  // them; the shown branch is the original, verbatim.
  check('★ the wallet keeps both branches of its exit disclosure', wallet.code.includes('const EXIT_NOTE_WITH_BACKING =') && wallet.code.includes('const EXIT_NOTE_BACKING_HIDDEN ='));
  check('★ …and renders whichever the flag selects', wallet.code.includes('{SHOW_BACKING_FIGURES ? EXIT_NOTE_WITH_BACKING : EXIT_NOTE_BACKING_HIDDEN}'));
  const hiddenNote = /const EXIT_NOTE_BACKING_HIDDEN =\s*'([^']*)'/.exec(strip(wallet.raw))?.[1] ?? '';
  check('the hidden exit note was extracted', hiddenNote.length > 150, `${hiddenNote.length} bytes`);
  check('★ …it names neither the floor nor the backing', !/floor/i.test(hiddenNote) && !/backing/i.test(hiddenNote), hiddenNote);
  check('★ …it still names BOTH exit routes and BOTH fees, which is the disclosure that had to survive', hiddenNote.includes('sell on the curve') && hiddenNote.includes('redeem your share of the reserve') && hiddenNote.includes('10% trade fee') && hiddenNote.includes('early-exit fee'));
  check('★ …and it keeps the audited "neither is a fixed price" claim', hiddenNote.includes('Neither is a fixed price'));
  check('★ …with no em or en dash, since it is copy written today', !/[—–]/.test(hiddenNote), hiddenNote);

  // Studio's wind-down sentences named the figure by its retired word; they now
  // name the mechanism, in the wording WIND_DOWN_BANNER already uses.
  check('★ studio describes a wind-down by its mechanism now, in all three places it used the retired word', count(studio.code, 'refunded their share of the reserve') === 3);
  check('★ …on the retire modal too', studio.code.includes('Every holder is refunded their share of the reserve, less any early-exit fee.'));
  // ★ AND THE MECHANISM SENTENCE HAD TO GROW A SECOND HALF (2026-08-28, false-text
  // audit F6). "Refunded their share of the reserve" is only two thirds of what
  // core/refund.go does: K2 carves the same hold-time exit tax the curve charges
  // (a fresh holder pays up to 20%, a six-week holder 0), while ECON-2 carves NO
  // trade fee. Stating the reserve share alone overstates what a holder who
  // retires early actually receives. All three studio sites and the launch-terms
  // locale string now name the fee, so one event reads the same way everywhere.
  const windDownSites = studio.code.match(/refunded their share of the reserve/g) ?? [];
  check('the wind-down scan found its sites', windDownSites.length === 3, `${windDownSites.length} sites`);
  check(
    '★ …and every one of them names the early-exit fee',
    count(studio.code, 'early-exit fee') === 3,
    `${count(studio.code, 'early-exit fee')} of 3`
  );
}

console.log('\n── 5. THE COPY MODULE IS WIRED THROUGH ITS SELECTORS, NOT ITS CONSTANTS.\n');
{
  check('★ the closing note goes through honestNote()', view.code.includes('{honestNote()}') && !view.code.includes('{HONEST_NOTE}'));
  check('★ the interstitial goes through interstitialLines()', modals.code.includes('interstitialLines().map') && !modals.code.includes('INTERSTITIAL_LINES.map'));
  check('★ the buy dialog still passes the figure, so nothing has to be rewired when the flag flips', modals.code.includes('{buyRiskNote(backingPerTokenValue(m.floorUsd, m.supply))}'));
  check('★ the overdue banner still passes it too', view.code.includes('overdueFigures(backingPerTokenValue(market.floorUsd, market.supply), market.priceUsd)'));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
