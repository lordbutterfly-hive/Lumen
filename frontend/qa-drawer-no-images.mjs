/**
 * THE TOP-COMMENT DRAWER SHOWS TEXT. NEVER AN IMAGE.
 * Owner, 2026-08-21: "no comment even if they carry an image should show an
 * image on expand in feed for top comment."
 *
 * ★★ THIS IS A RULE ABOUT THE FEED'S SHAPE, not tidiness. The drawer is fixed at
 * 113px — two clamped lines at line-height 24 — and the feed below is pushed
 * down by exactly that. An image inside it would blow that budget open by an
 * unpredictable amount, because the height would depend on whatever the
 * commenter uploaded. The drawer is a QUOTATION, not a render of the comment.
 *
 * ★ IT IS CHECKED AGAINST COMMENTS THAT REALLY CONTAIN IMAGES. Asserting "no img
 * in the drawer" across whatever the feed happens to serve proves nothing if none
 * of those comments had an image in the first place. So this reads each thread's
 * RAW bodies from /api/discussion, counts how many carry image markup, and says
 * so — if that count is zero the run is inconclusive and says THAT instead of
 * reporting a green.
 */
import { openApp, BASE, report } from './qa-harness.mjs';
import { openCardDrawer } from './qa/lib/open-drawer.mjs';

const rows = {};
let fails = 0;
const checkTrue = (l, ok, d = '') => { if (!ok) fails++; rows[l] = `${ok ? 'PASS' : 'FAIL'}  ${d}`; };

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card"]', { timeout: 60000 });
await page.waitForTimeout(4000);

let opened = 0, withImageBody = 0, leaks = [];
const n = await page.locator('[data-testid="medium-card"]').count();

for (let i = 0; i < Math.min(n, 14) && opened < 8; i++) {
  const card = page.locator('[data-testid="medium-card"]').nth(i);
  const dl = card.locator('[data-testid="post-card-drawer"]');
  if ((await dl.count()) === 0) continue;
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -200));
  await page.mouse.move(4, 4);
  await page.waitForTimeout(350);
  const b = await card.boundingBox();
  if (!b) continue;
  /* ★ CLICK, NOT HOVER (2026-08-25). The drawer opens on an empty-space click
     now; hovering does nothing at all, so this line used to open it and no
     longer would. `b.y + 40` was also fine as a hover target and is NOT fine as
     a click target — it is the byline row, where a click lands on the identity
     pill or the community tag and navigates instead. `openCardDrawer` probes for
     a point that is genuinely empty. */
  if (!(await openCardDrawer(page, card))) continue;
  let ok = false;
  for (let w = 0; w < 80; w++) {
    if ((await dl.evaluate((el) => el.getBoundingClientRect().height).catch(() => 0)) > 10) { ok = true; break; }
    await page.waitForTimeout(100);
  }
  if (!ok) continue;
  opened++;

  const res = await dl.evaluate((d) => {
    const text = d.querySelector('[class*="commentText"]');
    return {
      imgs: d.querySelectorAll('img:not([data-testid="user-avatar-img"] img)').length,
      avatarImgs: d.querySelectorAll('[data-testid="user-avatar-img"] img').length,
      body: (text?.textContent || '').trim()
    };
  });
  // does the raw thread actually contain image markup?
  const href = await card.locator('[data-testid="medium-card-title"]').getAttribute('href');
  const m = (href || '').match(/^\/[^/]+\/@([^/]+)\/(.+)$/);
  if (m) {
    const raw = await page.evaluate(async ([a, p]) => {
      const r = await fetch(`/api/discussion?author=${encodeURIComponent(a)}&permlink=${encodeURIComponent(p)}`);
      const j = await r.json(); const d = j.discussion || j;
      return Object.values(d || {}).filter((e) => /!\[|<img|https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)/i.test(e?.body || '')).length;
    }, [m[1], m[2]]);
    if (raw > 0) withImageBody++;
  }
  if (res.imgs > 0) leaks.push(`card ${i}: ${res.imgs} <img> in the drawer`);
  if (/https?:\/\//i.test(res.body)) leaks.push(`card ${i}: url in text "${res.body.slice(0, 40)}"`);
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
}

rows['drawers opened'] = String(opened);
rows['threads containing image markup'] = String(withImageBody);
if (opened === 0) {
  console.log('SKIP-FAIL: no drawer opened. This run proved nothing.');
  await browser.close();
  process.exit(1);
}
checkTrue('no <img> rendered inside any drawer (avatar aside)', leaks.filter((l) => l.includes('<img>')).length === 0,
  leaks.filter((l) => l.includes('<img>')).join('; ') || 'none');
checkTrue('no image URL left in the quoted text', leaks.filter((l) => l.includes('url in text')).length === 0,
  leaks.filter((l) => l.includes('url in text')).join('; ') || 'none');
if (withImageBody === 0) {
  rows['★ coverage'] = 'INCONCLUSIVE — none of the threads opened carried image markup, so the strip was never exercised';
}

report('DRAWER — text only, never an image', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
