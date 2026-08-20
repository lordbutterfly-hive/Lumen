/**
 * §9 NAVIGATION AND CLICK MODEL, MEASURED.
 *
 * "Comment block, in the drawer -> Navigate to the post, then jump directly to
 * that comment." Three things can each fail on their own and two of them fail
 * SILENTLY, which is why this is measured rather than eyeballed:
 *
 *   1. the href carries the comment, not just the post
 *   2. the reader LANDS on that comment — with headroom, not pinned to the top
 *   3. the flash fires, so they can see WHICH of 50 comments they were sent to
 *
 * ★ THE ONE THAT SILENTLY FAILS IS THE PAGE. The comment list paginates at 50
 * main comments. For any comment past page 1 the anchor is not in the DOM when
 * the hash lands, the browser does nothing, and the reader is left at the top of
 * the post with no error at all. So this also reports WHICH page the target was
 * on — a run that only ever tests page-1 comments has not tested the fix.
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const rows = {};
let fails = 0;
const px = (n) => `${Math.round(n)}px`;
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

// open a drawer
const n = await page.locator('[data-testid="medium-card"]').count();
let link = null, idx = -1;
for (let i = 0; i < Math.min(n, 8); i++) {
  const card = page.locator('[data-testid="medium-card"]').nth(i);
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const b = await card.boundingBox();
  if (!b) continue;
  await page.mouse.move(b.x + b.width / 2, b.y + 40);
  /* ★ POLL, DO NOT FIXED-WAIT — `/api/discussion` is a live chain read, measured
     4.5-6.4s cold. See the sibling probe for the full note. */
  for (let w = 0; w < 90; w++) {
    const h = await card.locator('[data-testid="post-card-drawer"]').evaluate((el) => el.getBoundingClientRect().height).catch(() => 0);
    if (h > 10) break;
    await page.waitForTimeout(100);
  }
  const l = card.locator('[data-testid="post-card-comment-link"]');
  if ((await l.count()) && (await l.isVisible().catch(() => false))) { link = l; idx = i; break; }
}
if (!link) {
  console.log('ABORT: no drawer exposed a comment link.');
  await browser.close();
  process.exit(1);
}
rows['card used'] = `#${idx}`;

const href = await link.getAttribute('href');
rows['href'] = href;
checkTrue('§9 href points at the post', /^\/[^/]+\/@[^/]+\/[^#]+/.test(href || ''), '');
checkTrue('§9 href carries the comment fragment', /#@[^/]+\/.+$/.test(href || ''), (href || '').split('#')[1] || 'no fragment');
const fragment = decodeURIComponent((href || '').split('#')[1] || '');

// pointer-events: the counts must not swallow the click
const countsSwallow = await page.locator('[data-testid="medium-card"]').nth(idx).evaluate((c) => {
  const counts = c.querySelector('[class*="counts"]');
  return counts ? getComputedStyle(counts).pointerEvents : 'missing';
});
checkTrue('§9 counts do not swallow the block click', countsSwallow === 'none', `pointer-events: ${countsSwallow}`);

await link.click();
await page.waitForURL((u) => u.pathname.includes('/@'), { timeout: 60000 });
await page.waitForTimeout(400);

// catch the flash while it is still on
let flashed = false;
for (let i = 0; i < 40 && !flashed; i++) {
  flashed = await page.evaluate(() => !!document.querySelector('.lm-comment-flash'));
  if (!flashed) await page.waitForTimeout(100);
}
checkTrue('§9 arrival flash fires', flashed, flashed ? 'lm-comment-flash seen' : 'never applied');

await page.waitForTimeout(3600); // let the re-pin window close before measuring
const landing = await page.evaluate((frag) => {
  const el = document.getElementById(frag);
  const section = document.querySelector('[data-testid="comments-empty"]')?.parentElement || null;
  return {
    exists: !!el,
    top: el ? el.getBoundingClientRect().top : null,
    scrollY: window.scrollY,
    hash: decodeURIComponent(location.hash),
    totalComments: document.querySelectorAll('[data-testid="comment-list-item"]').length,
    pager: [...document.querySelectorAll('button')].some((b) => /^\d+$/.test(b.textContent.trim()))
  };
}, fragment);
rows['target in DOM'] = String(landing.exists);
rows['comments rendered'] = String(landing.totalComments);
rows['thread is paginated'] = String(landing.pager);

checkTrue('§9 the linked comment exists on the landed page', landing.exists, landing.exists ? '' : 'anchor missing');
if (landing.exists) {
  checkTrue('§9 landed ON the comment (in viewport)', landing.top > -50 && landing.top < 400, `rect.top ${px(landing.top)}`);
  checkTrue('§9 headroom above it, not pinned to top', landing.top > 24, `rect.top ${px(landing.top)} (spec ~96)`);
}
checkTrue('§9 did not just sit at the top of the post', landing.scrollY > 200, `scrollY ${px(landing.scrollY)}`);

report('§9 NAVIGATION — comment jump', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
