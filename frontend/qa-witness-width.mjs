/**
 * Targeted probe: does the witnesses table overflow its container after the
 * all-Lora size bump, and if so BY HOW MUCH?
 *
 * A screenshot showed the right-hand column clipped. That is not enough to act
 * on — the table may have always scrolled, and `overflow-x: auto` is a legitimate
 * design for a wide table. The number that matters is the overflow in pixels and
 * whether the container was built to scroll.
 */
import { openApp, BASE } from './qa-harness.mjs';

const { browser, page } = await openApp({ loggedIn: true });
await page.goto(BASE + '/witnesses', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.fonts.ready);

const out = await page.evaluate(() => {
  const res = { scrollers: [], widestRow: null, cells: [] };
  for (const el of document.querySelectorAll('div,section,table,ul')) {
    const s = getComputedStyle(el);
    const over = el.scrollWidth - el.clientWidth;
    if (over > 2 && el.clientWidth > 200) {
      res.scrollers.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 90),
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        overflowPx: over,
        overflowX: s.overflowX,
        scrollable: s.overflowX === 'auto' || s.overflowX === 'scroll'
      });
    }
  }
  // the header cells, so we can see which column is the widest contributor
  const heads = [...document.querySelectorAll('[data-testid*="witness"] , thead th, [role="columnheader"]')];
  res.cells = heads.slice(0, 12).map((h) => ({
    text: (h.textContent || '').trim().slice(0, 22),
    w: Math.round(h.getBoundingClientRect().width)
  }));
  return res;
});

console.log('--- containers whose content is wider than their box ---');
for (const s of out.scrollers.slice(0, 10)) {
  console.log(
    `  ${s.tag}.${s.cls.split(' ').slice(0, 3).join('.')}\n     client=${s.clientWidth} scroll=${s.scrollWidth} OVER=${s.overflowPx}px overflow-x=${s.overflowX} ${s.scrollable ? '(SCROLLABLE — by design)' : '*** CLIPPED, NOT SCROLLABLE ***'}`
  );
}
console.log('\n--- column widths ---');
for (const c of out.cells) console.log(`  ${String(c.w).padStart(5)}px  ${c.text}`);
await browser.close();
