/**
 * THE IDENTITY CLUSTER, MEASURED — handoff_identity_pill/SPEC.md, option N1.
 *
 * N1's whole premise is geometric: a 40px face sitting OUTSIDE a 38px pill, with
 * the pill's flat left end slid underneath the circle so the seam between the two
 * shapes is hidden. Every part of that is a number, and every number has a reason
 * the spec spells out — so this measures rather than eyeballs.
 *
 * ★ THE OVERLAP IS THE ONE TO WATCH. The spec derives a hard floor:
 *     r - sqrt(r^2 - (h/2)^2) = 20 - sqrt(400 - 361) ≈ 13.75px
 * below which the pill's square corner pokes out past the circle and the seam is
 * visible again. 16px is specified, leaving 2.2px of margin. A future tidy-up
 * that "rounds it to 12" would look fine in a mockup and wrong on screen, so the
 * floor is asserted separately from the specified value.
 *
 * ★ AND THE TWO CLICK TARGETS. The pill is not one link. Left half goes to the
 * profile, right half to the Meritum market, each with its own aria-label, and
 * hovering one must not light the other — "hovering the price/Buy side should
 * never suggest the whole pill navigates to one place".
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const rows = {};
let fails = 0;
const px = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100) / 100}px`);
function check(label, actual, expected, tol = 1) {
  const ok = actual !== null && Math.abs(actual - expected) <= tol;
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${px(actual)} (spec ${px(expected)})`;
}
function checkTrue(label, ok, detail = '') {
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${detail}`;
}

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1400, height: 1000 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="identity-pill"]', { timeout: 60000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.fonts.ready);

const g = await page.evaluate(() => {
  const cluster = document.querySelector('[data-testid="identity-pill"]');
  const card = cluster.closest('[data-testid="medium-card"]');
  const face = cluster.querySelector('[data-testid="user-avatar-img"]');
  const faceLink = face ? face.closest('a') : null;
  const pill = cluster.querySelector('[class*="idPill"]');
  const handle = cluster.querySelector('[data-testid="identity-pill-profile"]');
  const market = cluster.querySelector('[data-testid="identity-pill-market"]');
  const buy = cluster.querySelector('[class*="idBuy"]');
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const fr = r(face), pr = r(pill), br = r(buy);
  const cs = pill ? getComputedStyle(pill) : null;
  return {
    cardHeight: card ? card.getBoundingClientRect().height : null,
    face: fr ? fr.height : null,
    faceWidth: fr ? fr.width : null,
    pillHeight: pr ? pr.height : null,
    // How far the pill's left edge sits UNDER the face's right edge.
    overlap: fr && pr ? fr.right - pr.left : null,
    radiusTopLeft: cs ? parseFloat(cs.borderTopLeftRadius) : null,
    radiusTopRight: cs ? parseFloat(cs.borderTopRightRadius) : null,
    borderLeft: cs ? parseFloat(cs.borderLeftWidth) : null,
    pillBg: cs ? cs.backgroundColor : null,
    pillBorderColor: cs ? cs.borderTopColor : null,
    pillBorderWidth: cs ? parseFloat(cs.borderTopWidth) : null,
    buyW: br ? br.width : null,
    buyH: br ? br.height : null,
    hasMarketHalf: !!market,
    handleLabel: handle ? handle.getAttribute('aria-label') : null,
    marketLabel: market ? market.getAttribute('aria-label') : null,
    handleHref: handle ? handle.getAttribute('href') : null,
    marketHref: market ? market.getAttribute('href') : null,
    handleSize: handle ? getComputedStyle(handle).fontSize : null,
    handleWeight: handle ? getComputedStyle(handle).fontWeight : null,
    // The face must not be a third tab stop (the spec's open question).
    faceTabIndex: faceLink ? faceLink.getAttribute('tabindex') : null,
    faceAriaHidden: faceLink ? faceLink.getAttribute('aria-hidden') : null,
    // Focusables inside the whole cluster — should be 1 (no market) or 2 (market).
    focusables: cluster.querySelectorAll('a:not([tabindex="-1"]),button:not([tabindex="-1"])').length
  };
});

rows['card height'] = px(g.cardHeight);
check('§N1 face is 40px', g.face, 40);
checkTrue('§N1 face is square', Math.abs((g.faceWidth ?? 0) - (g.face ?? 0)) <= 1, `${px(g.faceWidth)} x ${px(g.face)}`);
check('§N1 pill is 38px tall', g.pillHeight, 38);
check('§N1 pill underlaps the face by 16px', g.overlap, 16);
checkTrue('§N1 overlap clears the geometric floor (13.75px)', (g.overlap ?? 0) >= 13.75,
  `${px(g.overlap)} vs 13.75px minimum`);
check('§N1 pill left edge is flat', g.radiusTopLeft, 0, 0.5);
checkTrue('§N1 pill right edge is fully rounded', (g.radiusTopRight ?? 0) >= 19,
  `${px(g.radiusTopRight)} on a 38px pill`);
check('§N1 no left border (the face covers it)', g.borderLeft, 0, 0.5);
/* ★★★ THE PILL'S CHROME IS UNCONDITIONAL — AND THIS FILE USED TO ASSERT THE
   OPPOSITE.

   It encoded the owner ruling of 2026-08-20 ("pill outlines not existing" until
   the author has a token) and asserted the ABSENCE of fill and border on a
   handle-only pill. That ruling was REVERSED on 2026-08-25, after the owner saw
   what it actually looked like on a network where only 13 accounts have a
   market: *"the pill is missing from everyone... i just see the profile and
   written name."* The chrome moved from `.idPillSplit` to `.idPill`, and
   `post-card.module.css` (~line 1078) carries both quotes and both dates so the
   reversal is not "corrected" back by someone reading only the older one.

   ★ This probe was left behind by that move and had been failing 2/2 ever since,
   reporting the NEW, CORRECT colours as defects. A red probe that contradicts a
   recorded ruling is worse than no probe: the obvious way to make it green is to
   revert the CSS, which is exactly what the CSS comment begs nobody to do.

   So both states now assert the SAME chrome. What legitimately still differs
   between them is the market half and the focusable count, which are checked on
   their own below. The 1px border WIDTH is present in both states for the reason
   the old comment gave and that reason still holds: `.idHandle`'s `height:100%`
   resolves against the content box, so dropping the width would drag the handle
   1px when a token appears. */
checkTrue('§ colours — pill fill #FAEEEB (both states)', g.pillBg === 'rgb(250, 238, 235)', g.pillBg);
checkTrue('§ colours — pill border #EBD3CE (both states)', g.pillBorderColor === 'rgb(235, 211, 206)',
  `${g.pillBorderColor} at ${g.pillBorderWidth}px`);
console.log(`  chrome state               ${g.hasMarketHalf ? 'split pill (author HAS a market)' : 'handle-only pill (no market) — chrome still drawn, per the 2026-08-25 reversal'}`);

checkTrue('§ type — handle 14.5px / 600', g.handleSize === '14.5px' && g.handleWeight === '600',
  `${g.handleSize}/${g.handleWeight}`);

/* The tab-stop ruling the spec asked engineering to settle. */
checkTrue('§ face is not a third tab stop', g.faceTabIndex === '-1' && g.faceAriaHidden === 'true',
  `tabindex=${g.faceTabIndex} aria-hidden=${g.faceAriaHidden}`);
checkTrue('§ the cluster offers one focusable per destination',
  g.focusables === (g.hasMarketHalf ? 2 : 1), `${g.focusables} focusable(s), market half ${g.hasMarketHalf ? 'present' : 'absent'}`);
checkTrue('§ profile half is labelled', /^Profile of /.test(g.handleLabel || ''), g.handleLabel || 'none');
checkTrue('§ profile half points at the profile', /^\/@/.test(g.handleHref || ''), g.handleHref || 'none');

if (g.hasMarketHalf) {
  check('§N1 Buy chip is 51 wide', g.buyW, 51);
  check('§N1 Buy chip is 28 tall', g.buyH, 28);
  checkTrue('§ market half is labelled', /^Meritum market for /.test(g.marketLabel || ''), g.marketLabel || 'none');
  checkTrue('§ market half points at the market', /^\/creators\//.test(g.marketHref || ''), g.marketHref || 'none');
} else {
  rows['market half'] = 'absent — this author has no creator token (handle-only pill, as specified)';
}

/* ── THE HANDLE MUST NOT MOVE WHEN THE PILL APPEARS ─────────────────────────
   The owner's requirement is that the two states are "positioned the same" — the
   no-pill option and the pill option put the handle in exactly the same place,
   and only the chrome differs.

   ★ THIS CANNOT BE OBSERVED ON THE LIVE FEED, because no author currently has a
   market, so every pill is in the handle-only state. Forcing the class is the
   only way to see both. It is a DOM-level toggle of the exact class the component
   applies, so it exercises the real rule rather than a mock of it. */
const shift = await page.evaluate(() => {
  const cluster = document.querySelector('[data-testid="identity-pill"]');
  const pill = cluster.querySelector('[class*="idPill"]');
  const handle = cluster.querySelector('[data-testid="identity-pill-profile"]');
  const face = cluster.querySelector('[data-testid="user-avatar-img"]');
  const snap = () => {
    const h = handle.getBoundingClientRect(), f = face.getBoundingClientRect(), p = pill.getBoundingClientRect();
    return { hx: h.left, hy: h.top, fx: f.left, ph: p.height, overlap: f.right - p.left };
  };
  const before = snap();
  // The split class is the one the component adds when a market exists.
  const splitClass = [...pill.classList].find((c) => /idPill/.test(c) && /Split/i.test(c));
  const guess = splitClass || [...document.styleSheets].flatMap((sh) => {
    try { return [...sh.cssRules]; } catch { return []; }
  }).map((r) => r.selectorText).filter(Boolean).map((t) => (t.match(/\.(post-card_idPillSplit__[A-Za-z0-9_-]+)/) || [])[1]).find(Boolean);
  if (!guess) return { ok: false, why: 'could not resolve the idPillSplit class' };
  pill.classList.add(guess);
  const after = snap();
  pill.classList.remove(guess);
  return { ok: true, before, after };
});
if (!shift.ok) {
  checkTrue('§ handle does not move when the pill appears', false, shift.why);
} else {
  checkTrue('§ handle does not move when the pill appears',
    Math.abs(shift.after.hx - shift.before.hx) < 0.5 && Math.abs(shift.after.hy - shift.before.hy) < 0.5,
    `x ${px(shift.before.hx)} -> ${px(shift.after.hx)}, y ${px(shift.before.hy)} -> ${px(shift.after.hy)}`);
  checkTrue('§ face does not move either',
    Math.abs(shift.after.fx - shift.before.fx) < 0.5, `${px(shift.before.fx)} -> ${px(shift.after.fx)}`);
  checkTrue('§ pill height and underlap are identical in both states',
    Math.abs(shift.after.ph - shift.before.ph) < 0.5 && Math.abs(shift.after.overlap - shift.before.overlap) < 0.5,
    `h ${px(shift.before.ph)}->${px(shift.after.ph)}, overlap ${px(shift.before.overlap)}->${px(shift.after.overlap)}`);
}

/* ── each half lights ALONE ──────────────────────────────────────────────────
   ★ A REAL POINTER, NOT A SYNTHETIC EVENT. CSS `:hover` is driven by the
   browser's own hit-testing, not by dispatched MouseEvents — a
   `new MouseEvent('mouseover')` reaches JS listeners and changes no style at
   all. The first version of this check did exactly that and reported the hover
   as broken against a rule that works. */
const handleEl = page.locator('[data-testid="identity-pill-profile"]').first();
const marketEl = page.locator('[data-testid="identity-pill-market"]').first();
const bgOf = async (loc) => ((await loc.count()) ? loc.evaluate((el) => getComputedStyle(el).backgroundColor) : null);

await page.mouse.move(4, 4);
await page.waitForTimeout(350);
const restHandle = await bgOf(handleEl);
const restMarket = await bgOf(marketEl);

await handleEl.hover();
await page.waitForTimeout(350);
const litHandle = await bgOf(handleEl);
const marketWhileHandleLit = await bgOf(marketEl);

checkTrue(
  '§ hovering the profile half lights it',
  litHandle !== restHandle,
  `${restHandle} -> ${litHandle}`
);
if (restMarket !== null) {
  checkTrue(
    '§ ...and does NOT light the market half',
    marketWhileHandleLit === restMarket,
    `market ${restMarket} -> ${marketWhileHandleLit}`
  );
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await marketEl.hover();
  await page.waitForTimeout(350);
  checkTrue(
    '§ hovering the market half does NOT light the profile half',
    (await bgOf(handleEl)) === restHandle,
    `profile ${restHandle} -> ${await bgOf(handleEl)}`
  );
} else {
  rows['market half hover'] = 'n/a — handle-only pill on this card';
}
/* ── the rubric and the date ───────────────────────────────────────────────── */
const t = await page.evaluate(() => {
  const rub = document.querySelector('[data-testid="medium-card-rubric"]');
  const title = document.querySelector('[data-testid="medium-card-title"]');
  const date = title ? title.querySelector('[class*="titleDate"]') : null;
  const h2 = title ? title.querySelector('h2') : null;
  const cs = rub ? getComputedStyle(rub) : null;
  const ds = date ? getComputedStyle(date) : null;
  return {
    rubricText: rub ? rub.textContent.trim() : null,
    rubricSize: cs ? cs.fontSize : null,
    rubricWeight: cs ? cs.fontWeight : null,
    rubricTracking: cs ? cs.letterSpacing : null,
    rubricTransform: cs ? cs.textTransform : null,
    rubricColour: cs ? cs.color : null,
    dateInsideTitle: !!date,
    datePosition: ds ? ds.position : null,
    dateGap: ds ? ds.marginLeft : null,
    dateVisible: date ? date.getBoundingClientRect().width > 0 : false,
    titleLines: h2 ? Math.round(h2.getBoundingClientRect().height / parseFloat(getComputedStyle(h2).lineHeight)) : null
  };
});
rows['rubric text'] = t.rubricText ?? '(none — post has no community and no tag)';
if (t.rubricText) {
  checkTrue('§ rubric 13px / 700', t.rubricSize === '13px' && t.rubricWeight === '700', `${t.rubricSize}/${t.rubricWeight}`);
  checkTrue('§ rubric tracking .12em', t.rubricTracking === '1.56px', t.rubricTracking);
  checkTrue('§ rubric uppercase', t.rubricTransform === 'uppercase', t.rubricTransform);
  checkTrue('§ rubric is brand red', t.rubricColour === 'rgb(192, 57, 43)', t.rubricColour);
  checkTrue('§ rubric has no # prefix', !t.rubricText.startsWith('#'), t.rubricText);
}
checkTrue('§ date sits with the title, not in the byline', t.dateInsideTitle, String(t.dateInsideTitle));
checkTrue('§ date is NOT absolutely positioned', t.datePosition === 'static', t.datePosition || 'n/a');
checkTrue('§ date gap is 10px', t.dateGap === '10px', t.dateGap || 'n/a');
/* The date lives inside a line-clamp-2 headline, so a long title could clip it.
   Asserted rather than assumed — a date nobody can see is not "next to the title". */
checkTrue('§ date is actually visible next to the headline', t.dateVisible,
  `visible=${t.dateVisible}, headline is ${t.titleLines} line(s)`);

report('IDENTITY CLUSTER — N1', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
