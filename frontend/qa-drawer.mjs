/**
 * PROOF THAT THE POST CARD'S TOP-COMMENT DRAWER IS ACTUALLY WIRED.
 *
 * A screenshot cannot show this: the drawer is `height: 0` until the card is
 * hovered or focused, and its comment is not fetched until then either. A closed
 * drawer and a broken drawer look identical in a still image — which is exactly
 * the failure mode the handoff warns about for the `grid-template-rows` trick.
 *
 * So this measures four separate things, each of which can fail on its own:
 *   1. the drawer element EXISTS on a card whose post has comments
 *   2. NOTHING is requested for it on feed paint (the lazy gate holds)
 *   3. hovering fires exactly one `/api/discussion` request
 *   4. the drawer's measured height goes from 0 to non-zero and real text appears
 * plus 5: the same thing via KEYBOARD focus, which `:focus-within` must cover.
 */
import { openApp, BASE } from './qa-harness.mjs';
import { closeCardDrawer, openCardDrawer } from './qa/lib/open-drawer.mjs';

const { browser, page } = await openApp({ loggedIn: true });

const discussionCalls = [];
page.on('request', (r) => {
  if (r.url().includes('/api/discussion')) discussionCalls.push(r.url().slice(-90));
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card-title"]', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.fonts.ready);

const onPaint = discussionCalls.length;
console.log(`1. drawers in DOM ..................... ${await page.locator('[data-testid="post-card-drawer"]').count()}`);
console.log(`2. /api/discussion calls on paint ..... ${onPaint}  ${onPaint === 0 ? '(lazy gate HOLDS)' : '*** LAZY GATE LEAKING ***'}`);

/*
 * ★★ PICK A CARD WHOSE POST ACTUALLY HAS A COMMENT, and do it by HOVERING.
 *
 * The old selection was "first article containing a [data-testid=post-card-drawer]",
 * which is every card on the page: the drawer element is rendered
 * unconditionally so it stays in the accessibility tree while closed (see the
 * component's header). So that index was really just "card 0", and whenever card
 * 0's post had no comments this probe measured an empty drawer, reported
 * "DID NOT OPEN", and blamed the open mechanism. It had been getting lucky.
 *
 * A drawer with no comment is CORRECTLY 0-high — §2: "A post with zero comments
 * has nothing to open onto. The drawer is not rendered at all." So the only
 * honest way to find a testable card is to open one and see if a comment arrives.
 *
 * Also positions the card clear of the viewport bottom, because §8's guard
 * refuses to open a card whose bottom edge is within 120px of it.
 */
let idx = -1;
const cardCount = await page.locator('article').count();
for (let i = 0; i < Math.min(cardCount, 10); i++) {
  const c = page.locator('article').nth(i);
  const d = c.locator('[data-testid="post-card-drawer"]');
  if ((await d.count()) === 0) continue;
  await c.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -180));
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);
  const b = await c.boundingBox();
  if (!b) continue;
  /* ★ CLICK, NOT HOVER (2026-08-25): the drawer opens on an empty-space click;
     hovering does nothing. */
  if (!(await openCardDrawer(page, c))) continue;
  await page.waitForTimeout(1200);
  /* ★ THE SCROLL RE-CHECK IS NO LONGER ABOUT SCROLL (2026-08-25). It used to
     exist because §8 closed any open card on the first scroll event — including
     the browser's own scroll-anchoring as feed images loaded — and re-armed
     150ms later. Scroll no longer closes anything, so that race is gone. The
     second read is kept only because `/api/discussion` is a live chain read and
     the drawer can still be measuring 0 while it is in flight. */
  let h = await d.evaluate((el) => el.getBoundingClientRect().height);
  if (h <= 10) {
    await page.waitForTimeout(1200);
    h = await d.evaluate((el) => el.getBoundingClientRect().height);
  }
  if (h > 10) { idx = i; break; }
}
if (idx < 0) {
  console.log('   ABORT: no card in the first 10 opened a drawer with a comment in it.');
  console.log('   Nothing below would be measuring the drawer, so this run proves nothing.');
  await browser.close();
  process.exit(1);
}
await page.mouse.move(4, 4);
await page.waitForTimeout(900);
console.log(`   first card with a COMMENT .......... index ${idx}`);

const card = page.locator('article').nth(idx);
const drawer = card.locator('[data-testid="post-card-drawer"]');

/* ★★★ STEPS 3-9 REWRITTEN FOR THE CLICK CONTRACT (2026-08-25). They asserted
   the HOVER contract: hover to open, mouse-out to close, programmatic `.focus()`
   to prove `:focus-within`. All three are now wrong in a way that would read as a
   product failure — the run before this rewrite printed "DID NOT OPEN" and
   "KEYBOARD CANNOT OPEN IT" against a drawer that works correctly. */

// The search loop above left this card OPEN. Close it before measuring "closed".
await closeCardDrawer(page, card);
await page.waitForTimeout(400);
const closedH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`3. drawer height, closed .............. ${closedH}px ${closedH < 10 ? '' : '*** SHOULD BE 0 ***'}`);

// HOVER MUST DO NOTHING. The 140ms prefetch still warms on pointer entry, which
// is why the click below feels instant, but no dwell and no open.
await card.hover();
await page.waitForTimeout(1100);
const hoverH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`4. hover for 1100ms ................... ${hoverH}px ${hoverH < 10 ? '(correctly did NOT open)' : '*** HOVER STILL OPENS IT ***'}`);

await openCardDrawer(page, card);
await page.waitForTimeout(1200); // fetch tail + 340ms animation

const afterHover = discussionCalls.length - onPaint;
const openH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
const text = (await drawer.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 150);
const label = await drawer.locator('text=/top comment/i').count();

console.log(`5. /api/discussion calls .............. ${afterHover}  ${afterHover === 1 ? '(exactly one)' : ''}`);
console.log(`6. drawer height after CLICK .......... ${openH}px  ${openH > closedH + 10 ? 'OPENED' : '*** DID NOT OPEN ***'}`);
console.log(`7. TOP COMMENT label present ......... ${label > 0 ? 'yes' : 'no'}`);
console.log(`8. drawer text ........................ ${text || '(empty)'}`);

/* ★ MOVING THE POINTER AWAY MUST NOT CLOSE IT ANY MORE. Under hover-to-open a
   mouse-out meant "done reading"; under click-to-open the reader ASKED for this,
   and taking it away because the mouse wandered is the same mistake hover was. */
await page.mouse.move(0, 0);
await page.waitForTimeout(900);
const afterOutH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`9. height after mouse-out ............. ${afterOutH}px ${afterOutH > 10 ? '(correctly STAYS open)' : '*** CLOSED ON MOUSE-OUT ***'}`);

/* ★ KEYBOARD, WITH A REAL TAB. The old check called `.focus()` directly, which is
   programmatic focus — indistinguishable from the focus Radix restores when a
   menu closes, and deliberately NOT treated as "the reader navigated here". Only
   a genuine navigation key arms the modality flag, so the probe has to press one. */
await closeCardDrawer(page, card);
await page.waitForTimeout(400);
await page.evaluate(() => document.body.focus());
let landed = false;
for (let i = 0; i < 30 && !landed; i++) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(110);
  landed = await card.evaluate((el) => el.contains(document.activeElement));
}
await page.waitForTimeout(700);
const focusH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`10. height after real Tab into card ... ${focusH}px ${focusH > 10 ? 'OPENED (keyboard path intact)' : '*** KEYBOARD CANNOT OPEN IT ***'}`);

await page.mouse.move(0, 0);
await page.waitForTimeout(700);
const stillThere = await drawer.count();
console.log(`11. drawer still in DOM when closed ... ${stillThere > 0 ? 'yes (a11y tree intact)' : '*** REMOVED ***'}`);

await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/drawer-open.png' });
await openCardDrawer(page, card);
await page.waitForTimeout(1500);
await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/drawer-open.png' });
await browser.close();
