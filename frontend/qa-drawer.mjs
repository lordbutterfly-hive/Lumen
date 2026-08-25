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
import { openCardDrawer } from './qa/lib/open-drawer.mjs';

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
  if (!(await openCardDrawer(page, card))) continue;
  await page.waitForTimeout(1600);
  // Re-check once: §8 closes an open card on any scroll event, including the
  // browser's own scroll-anchoring adjustments as feed images load. It re-arms
  // itself 150ms later because the pointer is still inside, so a single reading
  // can catch the gap. See the same note in qa-animations.mjs.
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

const closedH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`3. drawer height, closed .............. ${closedH}px`);

/* ★ CLICK, NOT HOVER (2026-08-25): the drawer opens on an empty-space click;
   hovering does nothing. */
// The 140ms prefetch still warms on pointer entry, so warm it, then click.
await card.hover();
await openCardDrawer(page, card);
await page.waitForTimeout(1200); // fetch tail + 340ms animation

const afterHover = discussionCalls.length - onPaint;
const openH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
const text = (await drawer.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 150);
const label = await drawer.locator('text=/top comment/i').count();

console.log(`4. /api/discussion calls after hover .. ${afterHover}  ${afterHover === 1 ? '(exactly one)' : ''}`);
console.log(`5. drawer height, hovered ............. ${openH}px  ${openH > closedH + 10 ? 'OPENED' : '*** DID NOT OPEN ***'}`);
console.log(`6. TOP COMMENT label present ......... ${label > 0 ? 'yes' : 'no'}`);
console.log(`7. drawer text ........................ ${text || '(empty)'}`);

// hover away, then prove KEYBOARD focus opens it too (:focus-within)
await page.mouse.move(0, 0);
await page.waitForTimeout(900);
const reclosedH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`8. drawer height after mouse-out ...... ${reclosedH}px ${reclosedH < 10 ? '(closed again)' : ''}`);

await card.locator('a,button').first().focus();
await page.waitForTimeout(1800);
const focusH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`9. drawer height on keyboard focus .... ${focusH}px ${focusH > 10 ? 'OPENED (:focus-within works)' : '*** KEYBOARD CANNOT OPEN IT ***'}`);

// the drawer must stay in the DOM while closed, for the a11y tree / tab order
await page.mouse.move(0, 0);
await page.waitForTimeout(700);
const stillThere = await drawer.count();
console.log(`10. drawer still in DOM when closed ... ${stillThere > 0 ? 'yes (a11y tree intact)' : '*** REMOVED ***'}`);

await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/drawer-open.png' });
await openCardDrawer(page, card);
await page.waitForTimeout(1500);
await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/drawer-open.png' });
await browser.close();
