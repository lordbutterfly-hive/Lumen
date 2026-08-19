/**
 * MUTATION CHECK on the `break-words` fix.
 *
 * The probe says 0 cells overflow. That is only meaningful if this measurement
 * CAN report overflow on this page at all — a check that cannot reach the
 * failure reports a clean 0 whether or not the fix is doing anything.
 *
 * So: measure, then strip `overflow-wrap`/`word-break` off the very same cells
 * in the live document and measure again. If the overflow reappears, the check
 * reaches the failure and `break-words` is the thing holding it. If it stays 0,
 * the earlier 0 proved nothing and the real cause is elsewhere.
 */
import { openApp, BASE } from './qa-harness.mjs';

const { browser, page } = await openApp({ loggedIn: true });
await page.goto(BASE + '/witnesses', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.fonts.ready);

const r = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('div')].filter((e) =>
    /max-w-\[340px\]/.test(String(e.className))
  );
  const measure = () =>
    cells.map((e) => ({
      over: e.scrollWidth - e.clientWidth,
      w: e.clientWidth,
      t: (e.textContent || '').trim().slice(0, 44)
    }));

  const withFix = measure();
  // strip the fix on the live nodes, nothing else touched
  for (const e of cells) {
    e.style.overflowWrap = 'normal';
    e.style.wordBreak = 'normal';
  }
  void document.body.offsetHeight; // force reflow
  const withoutFix = measure();
  return { withFix, withoutFix };
});

const overFix = r.withFix.filter((c) => c.over > 1);
const overNo = r.withoutFix.filter((c) => c.over > 1);

console.log(`cells measured .......................... ${r.withFix.length}`);
console.log(`overflowing WITH    break-words ......... ${overFix.length}`);
console.log(`overflowing WITHOUT break-words ......... ${overNo.length}   <-- must be > 0`);
console.log('');
if (overNo.length) {
  console.log('cells that overflow the moment the fix is removed:');
  for (const c of overNo.slice(0, 10)) {
    console.log(`  +${String(c.over).padStart(4)}px into a ${c.w}px box | ${c.t}`);
  }
}
console.log('');
console.log(
  overNo.length > 0 && overFix.length === 0
    ? 'VERDICT: the check reaches the failure, and break-words is what prevents it.'
    : 'VERDICT: INCONCLUSIVE — the clean reading was not earned by this fix.'
);
await browser.close();
