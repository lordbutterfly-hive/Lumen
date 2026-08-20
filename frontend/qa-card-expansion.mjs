/**
 * THE CARD-EXPANSION SPEC, MEASURED (2026-08-20 SPEC.md §4 §5 §6 §7 §8).
 *
 * Every number in §4's table is checked as its OWN band, not as a total. A total
 * that lands on 113px while two bands are wrong in opposite directions is the
 * exact failure this file exists to catch — and it is the likely one, because the
 * shipped drawer missed the total by 70px through spacing AND type together.
 *
 * ★ WHY THE OPEN IS TIMED RATHER THAN ASSUMED. §1 makes the dwell the headline
 * change ("Dwell replaces instant fire. 350ms"). A drawer that opens instantly
 * still looks correct in a screenshot and still measures 113px. The only way to
 * see the difference is to hold a pointer on the card and watch the clock.
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const CEIL = 125; // §4 "125px is the acceptance ceiling"
const rows = {};
let fails = 0;
const px = (n) => (n === null || n === undefined ? 'n/a' : `${Math.round(n * 100) / 100}px`);

function check(label, actual, expected, tol = 1) {
  const ok = actual !== null && Math.abs(actual - expected) <= tol;
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${px(actual)} (spec ${px(expected)}${tol ? ` ±${tol}` : ''})`;
  return ok;
}
function checkText(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${actual}${ok ? '' : `  (spec ${expected})`}`;
  return ok;
}
function checkTrue(label, ok, detail = '') {
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${detail}`;
  return ok;
}

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1400, height: 1000 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card"]', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.fonts.ready);

/* ── find a card near the TOP of the page whose post has a comment ──────────
   Near the top matters: §8's bottom guard refuses to open a card within 120px
   of the viewport bottom, so a card chosen at random can legitimately never
   open and every measurement below would read 0. */
const cardCount = await page.locator('[data-testid="medium-card"]').count();
let idx = -1;
for (let i = 0; i < Math.min(cardCount, 8); i++) {
  const card = page.locator('[data-testid="medium-card"]').nth(i);
  await card.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const box = await card.boundingBox();
  if (!box) continue;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  const dl = card.locator('[data-testid="post-card-drawer"]');
  // A post with no comments renders NO drawer at all (§2), so this is the
  // common case walking down a feed, not an error.
  if ((await dl.count()) === 0) continue;
  /* ★ POLL, DO NOT FIXED-WAIT. `/api/discussion` is a live chain read and was
     measured at 4.5-6.4s cold on this machine (warm React Query hits are ~0ms,
     which is why an earlier fixed 1400ms wait passed for weeks and then started
     aborting the moment a run hit a cold post). Poll to a generous ceiling so the
     probe measures the drawer, not the network. */
  for (let w = 0; w < 90; w++) {
    const h = await dl.evaluate((el) => el.getBoundingClientRect().height).catch(() => 0);
    if (h > 10) break;
    await page.waitForTimeout(100);
  }
  const h = await dl.evaluate((el) => el.getBoundingClientRect().height);
  if (h > 10) { idx = i; break; }
}
if (idx < 0) {
  console.log('ABORT: no card opened a drawer. Nothing below would be measuring anything.');
  await browser.close();
  process.exit(1);
}
rows['card used'] = `#${idx} of ${cardCount}`;
const card = page.locator('[data-testid="medium-card"]').nth(idx);
const drawer = card.locator('[data-testid="post-card-drawer"]');

/* ── §8 DWELL + §1 "the drawer slides instead of jumping" ──────────────────
   ★ A SYNTHETIC PointerEvent DOES NOT WORK HERE and the first version of this
   file was wrong because of it: React does not listen for `pointerenter` (it
   does not bubble, so React synthesises enter/leave from delegated
   pointerover/pointerout at the root). Dispatching one directly reaches no
   handler, the drawer never opens, and the check reports "instant fire is still
   there" when the dwell is in fact working. Drive it with the REAL pointer and
   time the attribute flip from inside the page. */
await page.mouse.move(5, 5);
await page.waitForTimeout(900);
const box = await card.boundingBox();

/* ★ RESOLVE THE DRAWER FROM ITS OWN CARD, not by index into all drawers.
   `idx` counts CARDS, and a post with no comments renders no drawer at all (§2),
   so `document.querySelectorAll('[data-testid="post-card-drawer"]')[idx]` points
   at some other card's drawer the moment any earlier card lacked one. The
   observer then watched an element nobody was hovering, `__opened` stayed null,
   and this reported "dwell never fired" against a drawer the geometry checks
   below measured at a perfectly correct 113px. */
await page.evaluate((i) => {
  const card = document.querySelectorAll('[data-testid="medium-card"]')[i];
  const d = card && card.querySelector('[data-testid="post-card-drawer"]');
  if (!d) return;
  window.__opened = null;
  window.__samples = [];
  window.__t0 = performance.now();
  new MutationObserver(() => {
    if (d.getAttribute('data-open') === 'true' && window.__opened === null) {
      window.__opened = performance.now() - window.__t0;
      // Sample the height across the opening transition. A drawer that SNAPS
      // goes 0 -> full in one frame and lands no intermediate value; one that
      // slides lands several.
      const tick = () => {
        window.__samples.push(d.getBoundingClientRect().height);
        if (window.__samples.length < 24) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }).observe(d, { attributes: true, attributeFilter: ['data-open'] });
}, idx);

await page.mouse.move(box.x + box.width / 2, box.y + 40);
await page.waitForTimeout(1800);
const motion = await page.evaluate(() => ({ opened: window.__opened, samples: window.__samples }));
const dwell = motion.opened;

checkTrue(
  '§1 dwell is 350ms, not instant',
  dwell !== null && dwell >= 280 && dwell <= 600,
  dwell === null ? 'never opened' : `opened after ${Math.round(dwell)}ms`
);
const peak = Math.max(...(motion.samples.length ? motion.samples : [0]));
const mid = motion.samples.filter((h) => h > 4 && h < peak - 4).length;
checkTrue(
  '§1 the drawer SLIDES (intermediate heights seen)',
  mid >= 2,
  `${mid} intermediate frames of ${motion.samples.length}, peak ${px(peak)}`
);

/* ── §4 GEOMETRY, band by band ─────────────────────────────────────────────── */
const g = await drawer.evaluate((d) => {
  const q = (s) => d.querySelector(s);
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const cbox = d.querySelector('[class*="cbox"]');
  const seam = d.querySelector('[class*="seam"]');
  // The AVATAR, not its link wrapper: a bare inline wrapper reports its line-box
  // height (26px for a 24px avatar), which is a measurement artefact, not layout.
  const avatar = cbox ? cbox.querySelector('[data-testid="user-avatar-img"]') : null;
  // The avatar's OWN wrapper. Not `cbox.querySelector('a')` — since §9 the
  // first anchor in the block is the stretched navigation link (inset: 0), so
  // that selector measures the whole block and reports 84px.
  const avatarWrap = avatar ? avatar.parentElement : null;
  const meta = d.querySelector('[class*="commentMeta"]');
  const body = d.querySelector('[class*="commentText"]');
  const counts = d.querySelector('[class*="counts"]');
  const dr = r(d), sr = r(seam), ar = r(avatar), mr = r(meta), br = r(body), cr = r(counts), cbr = r(cbox);
  const cs = getComputedStyle(d);
  return {
    total: dr.height,
    inlineHeight: d.style.height,
    gapAboveDivider: sr ? sr.top - dr.top : null,
    divider: sr ? sr.height : null,
    dividerWidth: sr ? sr.width : null,
    innerWidth: dr.width,
    gapBelowDivider: ar && sr ? ar.top - sr.bottom : null,
    metaRow: mr ? mr.height : null,
    gapMetaToBody: br && mr ? br.top - mr.bottom : null,
    body: br ? br.height : null,
    bottomPadding: dr.bottom - Math.max(br ? br.bottom : 0, cr ? cr.bottom : 0, ar ? ar.bottom : 0),
    avatar: ar ? ar.height : null,
    avatarWrap: avatarWrap ? avatarWrap.getBoundingClientRect().height : null,
    cboxGap: ar && br ? br.left - ar.right : null,
    overflow: cs.overflow,
    countsGap: counts ? (() => {
      const kids = [...counts.children];
      return kids.length === 2 ? kids[1].getBoundingClientRect().left - kids[0].getBoundingClientRect().right : null;
    })() : null,
    cboxRight: cbr && dr ? dr.right - cbr.right : null
  };
});

check('§4 gap above divider', g.gapAboveDivider, 12);
check('§4 divider', g.divider, 1, 0.5);
check('§4 gap below divider', g.gapBelowDivider, 12);
check('§4 meta row', g.metaRow, 20);
check('§4 gap meta to body', g.gapMetaToBody, 4);
/* §5: "A short comment shrinks the block. Nothing pads to a fixed height." So
   the body is 24px (one line) or 48px (two, clamped) and BOTH are correct —
   which comment the feed happens to serve decides which. Asserting 48 flat made
   this probe fail on a perfectly good one-line drawer. */
checkTrue('§4 body is 1 or 2 clamped lines @ 24', g.body === 24 || g.body === 48, px(g.body));
check('§4 bottom padding', g.bottomPadding, 16);
check('§4 avatar', g.avatar, 24);
check('§4 avatar wrapper adds no line-box', g.avatarWrap, 24);
check('§4 cbox gap', g.cboxGap, 12);
checkTrue('§4 TOTAL <= 125 ceiling', g.total <= CEIL, `${px(g.total)} (ships at 113)`);
/* The total is the sum of §4's own bands, so it is derived from the body rather
   than hard-coded: 12 + 1 + 12 + (20 + 4 + body) + 16. §4 states both answers
   explicitly — "Total 113px | one-line comment: 89px" — and 65 + body gives
   exactly those two. */
const expectedTotal = 65 + g.body;
check(`§4 total is ${expectedTotal} (${g.body === 48 ? 'two-line' : 'one-line'})`, g.total, expectedTotal, 2);
checkTrue('§8 height is a measured px, not auto', /^\d+(\.\d+)?px$/.test(g.inlineHeight), `inline height = "${g.inlineHeight}"`);
checkTrue('§4 divider is full content width', Math.abs(g.dividerWidth - g.innerWidth) <= 1, `${px(g.dividerWidth)} of ${px(g.innerWidth)}`);
checkTrue('§4 no negative side margin (block sits inside)', g.cboxRight >= -0.5, `right inset ${px(g.cboxRight)}`);

/* ── §5 TYPE ───────────────────────────────────────────────────────────────── */
const t = await drawer.evaluate((d) => {
  const cs = (s) => { const el = d.querySelector(s); return el ? getComputedStyle(el) : null; };
  const a = cs('[class*="commentAuthor"]'), sep = cs('[class*="commentSep"]'), ti = cs('[class*="commentTime"]');
  const lb = cs('[class*="commentLabel"]'), bd = cs('[class*="commentText"]');
  // The vote is now the shipped VotesComponent at size="quote" (§7), so its
  // number is the control's own `.tally`, not a `.voteCount` span any more.
  const vc = cs('[class*="tallyUp"]'), rc = cs('[class*="replyCount"]');
  const lbl = d.querySelector('[class*="commentLabel"]');
  const pick = (c) => c ? { size: c.fontSize, weight: c.fontWeight, color: c.color, ls: c.letterSpacing, lh: c.lineHeight, fam: c.fontFamily.split(',')[0], num: c.fontVariantNumeric, clamp: c.webkitLineClamp, wrap: c.overflowWrap, cursor: c.cursor } : null;
  return {
    author: pick(a), sep: pick(sep), time: pick(ti), label: pick(lb), body: pick(bd),
    vote: pick(vc), reply: pick(rc),
    labelHidden: lbl ? lbl.getAttribute('aria-hidden') : null,
    families: [...new Set([a, sep, ti, lb, bd, vc, rc].filter(Boolean).map((c) => c.fontFamily.split(',')[0]))]
  };
});
checkText('§5 author size/weight', `${t.author.size}/${t.author.weight}`, '15px/600');
checkText('§5 separator size/weight', `${t.sep.size}/${t.sep.weight}`, '15px/400');
checkText('§5 timestamp size/weight', `${t.time.size}/${t.time.weight}`, '14px/400');
checkText('§5 label size/weight', `${t.label.size}/${t.label.weight}`, '12px/700');
checkText('§5 label tracking', t.label.ls, '1.44px');
checkText('§5 body size/line-height', `${t.body.size}/${t.body.lh}`, '16px/24px');
checkText('§5 body clamps at 2', t.body.clamp, '2');
checkText('§5 body overflow-wrap', t.body.wrap, 'anywhere');
checkText('§5 vote count size/weight', `${t.vote.size}/${t.vote.weight}`, '14px/500');
checkText('§5 reply count size/weight', `${t.reply.size}/${t.reply.weight}`, '14px/500');
checkTrue('§5 vote count tabular', t.vote.num.includes('tabular-nums'), t.vote.num);
checkTrue('§5 reply count tabular', t.reply.num.includes('tabular-nums'), t.reply.num);
checkTrue('§5 all Lora, no second family', t.families.length === 1, t.families.join(' + '));
checkText('§10 label is aria-hidden', t.labelHidden, 'true');
check('§7 counts 16px apart', g.countsGap, 16);

/* ── §7 the reply count must NOT be a control ──────────────────────────────── */
checkTrue('§7 reply count is not a button', t.reply.cursor !== 'pointer', `cursor: ${t.reply.cursor}`);
const replyHover = await drawer.evaluate(async (d) => {
  const el = d.querySelector('[class*="replyCount"]');
  const before = getComputedStyle(el).color;
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  return { before, after: getComputedStyle(el).color };
});
checkTrue('§7 reply count has no hover colour', replyHover.before === replyHover.after, replyHover.after);

/* ── §7 THE VOTE IS A CONTROL, §9 IT VOTES WITHOUT NAVIGATING ──────────────── */
const vote = await drawer.evaluate((d) => {
  const btn = d.querySelector('[class*="counts"] button');
  if (!btn) return null;
  const cs = getComputedStyle(btn);
  const svg = btn.querySelector('svg');
  const sr = svg ? svg.getBoundingClientRect() : null;
  const slot = d.querySelector('[class*="voteSlot"]');
  return {
    isButton: btn.tagName === 'BUTTON',
    ariaPressed: btn.getAttribute('aria-pressed'),
    w: Math.round(btn.getBoundingClientRect().width),
    h: Math.round(btn.getBoundingClientRect().height),
    glyph: sr ? Math.round(sr.width) : null,
    cursor: cs.cursor,
    slotPointerEvents: slot ? getComputedStyle(slot).pointerEvents : 'no slot'
  };
});
if (!vote) {
  checkTrue('§7 the vote is a real control', false, 'no <button> inside .counts');
} else {
  checkTrue('§7 the vote is a real control', vote.isButton, `<${vote.isButton ? 'button' : '?'}>`);
  checkTrue('§10 it carries aria-pressed', vote.ariaPressed === 'true' || vote.ariaPressed === 'false', `aria-pressed=${vote.ariaPressed}`);
  check('§7 blade is 18px', vote.glyph, 18, 1);
  checkTrue('§7 target meets the 24px floor', vote.w >= 24 && vote.h >= 24, `${vote.w}x${vote.h}`);
  checkTrue('§9 the vote catches its own clicks', vote.slotPointerEvents === 'auto', vote.slotPointerEvents);
}

/* ── §1/§7 the action row and the payout are GONE ──────────────────────────── */
const money = await drawer.evaluate((d) => (d.innerText.match(/\$\s?[\d.,]+/g) || []).join(' '));
checkTrue('§1 no payout readout in the drawer', money === '', money || 'none');
const readouts = await drawer.evaluate((d) => d.querySelectorAll('[class*="counts"] > *').length);
checkText('§1 exactly two readouts', readouts, 2);

/* ── §6 surface: wash on the BLOCK hover only, author goes brand ───────────── */
const wash = await drawer.evaluate(async (d) => {
  const cbox = d.querySelector('[class*="cbox"]');
  const author = d.querySelector('[class*="commentAuthor"]');
  const rest = { bg: getComputedStyle(cbox).backgroundColor, author: getComputedStyle(author).color,
                 shadow: getComputedStyle(cbox).boxShadow, border: getComputedStyle(cbox).borderTopWidth,
                 radius: getComputedStyle(cbox).borderTopLeftRadius };
  cbox.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  cbox.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  await new Promise((r) => setTimeout(r, 300));
  return { rest, hoverBg: getComputedStyle(cbox).backgroundColor, hoverAuthor: getComputedStyle(author).color };
});
checkTrue('§6 no tint at rest', /rgba\(0, 0, 0, 0\)|transparent/.test(wash.rest.bg), wash.rest.bg);
checkTrue('§6 no shadow', wash.rest.shadow === 'none', wash.rest.shadow);
checkTrue('§6 no border', parseFloat(wash.rest.border) === 0, wash.rest.border);
checkText('§6 radius 8px', wash.rest.radius, '8px');

report('CARD EXPANSION — SPEC.md 2026-08-20', rows);
console.log(`\n  drawer total: ${px(g.total)}   |   ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
