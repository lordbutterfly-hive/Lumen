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

// find the first card that actually has a drawer
const idx = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('article')];
  return cards.findIndex((c) => c.querySelector('[data-testid="post-card-drawer"]'));
});
console.log(`   first card with a drawer ........... index ${idx}`);

const card = page.locator('article').nth(idx);
const drawer = card.locator('[data-testid="post-card-drawer"]');

const closedH = await drawer.evaluate((el) => el.getBoundingClientRect().height);
console.log(`3. drawer height, closed .............. ${closedH}px`);

await card.hover();
await page.waitForTimeout(2600); // 140ms intent + fetch + 340ms animation

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
await card.hover();
await page.waitForTimeout(1500);
await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/drawer-open.png' });
await browser.close();
