/**
 * OPTION (B): the feed card's comment count corrects itself once the thread is known.
 *
 * Owner report: "the blocked accounts still show up as if their comments exist.
 * the comments are hidden but under the card it says 2."
 *
 * The card prints Hivemind's `children`, which is blind to BOTH block mechanisms
 * (the post owner's, server-side and global; the reader's own, client-side and
 * personal). On hover the drawer fetches the thread, and `useVisibleDiscussion`
 * filters it the way the reader would actually see it — so from that moment the
 * card can print a number that matches the page they land on.
 *
 * ★ WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the displayed count equals
 * the visible thread size after engagement. It does NOT prove the blocked case
 * end-to-end, because that needs a post whose commenter the owner has blocked,
 * and the live feed rarely offers one. Where the counts already agree, this is a
 * NO-REGRESSION check — it would catch the count breaking, going blank, or
 * drifting off the thread — and it says so rather than claiming more.
 */
import { openApp, BASE, report } from './qa-harness.mjs';
import { openCardDrawer } from './qa/lib/open-drawer.mjs';

const rows = {};
let fails = 0;
const checkTrue = (l, ok, d = '') => { if (!ok) fails++; rows[l] = `${ok ? 'PASS' : 'FAIL'}  ${d}`; };

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1400, height: 1000 });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card"]', { timeout: 60000 });
await page.waitForTimeout(3000);

const n = await page.locator('[data-testid="medium-card"]').count();
let checked = 0;
for (let i = 0; i < Math.min(n, 6) && checked < 2; i++) {
  const card = page.locator('[data-testid="medium-card"]').nth(i);
  const dl = card.locator('[data-testid="post-card-drawer"]');
  if ((await dl.count()) === 0) continue;
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -180));
  await page.mouse.move(4, 4);
  await page.waitForTimeout(400);

  const before = await card.locator('[data-testid="post-children"]').innerText().catch(() => null);
  const b = await card.boundingBox();
  if (!b) continue;
  /* ★ CLICK, NOT HOVER (2026-08-25). The drawer opens on an empty-space click
     now; hovering does nothing at all, so this line used to open it and no
     longer would. `b.y + 40` was also fine as a hover target and is NOT fine as
     a click target — it is the byline row, where a click lands on the identity
     pill or the community tag and navigates instead. `openCardDrawer` probes for
     a point that is genuinely empty. */
  if (!(await openCardDrawer(page, card))) continue;
  for (let w = 0; w < 90; w++) {
    const h = await dl.evaluate((el) => el.getBoundingClientRect().height).catch(() => 0);
    if (h > 10) break;
    await page.waitForTimeout(100);
  }
  const after = await card.locator('[data-testid="post-children"]').innerText().catch(() => null);
  const href = await card.locator('[data-testid="medium-card-title"]').getAttribute('href');
  const m = (href || '').match(/^\/[^/]+\/@([^/]+)\/(.+)$/);
  if (!m) continue;
  // the thread the reader would see, straight from the same route the card used
  const truth = await page.evaluate(async ([a, p]) => {
    const r = await fetch(`/api/discussion?author=${encodeURIComponent(a)}&permlink=${encodeURIComponent(p)}`);
    const j = await r.json();
    const d = j.discussion || j;
    return Object.keys(d || {}).filter((k) => k !== `${a}/${p}`).length;
  }, [m[1], m[2]]);

  checked++;
  rows[`card ${i} — count before hover`] = String(before).trim();
  rows[`card ${i} — count after hover`] = String(after).trim();
  rows[`card ${i} — visible thread size`] = String(truth);
  checkTrue(`card ${i}: the count still renders after correction`, after !== null && after !== '', String(after).trim());
  checkTrue(`card ${i}: the corrected count matches the visible thread`,
    Number(String(after).trim()) === truth, `card says ${String(after).trim()}, thread has ${truth}`);
}
if (checked === 0) {
  console.log('SKIP-FAIL: no card with a drawer was found. This run proved nothing.');
  await browser.close();
  process.exit(1);
}
report('COMMENT COUNT — corrected on engage (option b)', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
