/**
 * THE SAME NUMBER, THE SAME WAY, ON EVERY SURFACE THAT SHOWS IT.
 *
 * Written 2026-08-20 after the owner reported the post page's payout rendering
 * RED while the feed's was green: "that shows unprofessional as on feed payout
 * is green". The payout is fixed; this exists so the NEXT one is caught by a
 * run rather than by the owner.
 *
 * ★ IT COMPARES ACROSS SURFACES, WHICH NO OTHER PROBE HERE DOES. Every existing
 * check asks "is this element right on this page". None of them could see two
 * pages disagreeing, which is exactly the shape of the defect that was shipped:
 * four payout treatments, each internally consistent, no two alike.
 *
 * Colour is asserted. Size is REPORTED but not failed: a payout legitimately
 * sits at 17px on a feed card and 14px in a comment row — the type scale is
 * meant to differ by density. Hue is not: money is one colour everywhere.
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const rows = {};
let fails = 0;
const checkTrue = (l, ok, d = '') => { if (!ok) fails++; rows[l] = `${ok ? 'PASS' : 'FAIL'}  ${d}`; };

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1500, height: 1000 });

async function sample(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5500);
  return page.evaluate(() => {
    const seen = {};
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (!/^\$\s?[\d.,]+$/.test(txt)) continue;
      const cs = getComputedStyle(el);
      const id = el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || '(none)';
      if (!seen[id]) seen[id] = { color: cs.color, size: cs.fontSize, weight: cs.fontWeight };
    }
    return seen;
  });
}

const feed = await sample('/');
const post = await sample('/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy');
const all = { ...feed, ...post };
for (const [id, v] of Object.entries(all)) rows[id] = `${v.color}  ${v.size}/${v.weight}`;

const colours = [...new Set(Object.values(all).map((v) => v.color))];
checkTrue('money is ONE colour across every surface', colours.length === 1, colours.join('  |  '));

// And that colour must be the money green, not whatever happens to be shared.
checkTrue('and that colour is the payout green (42,107,68)',
  colours.length === 1 && /rgb\(42,\s*107,\s*68\)/.test(colours[0]), colours[0] || 'n/a');

report('SURFACE CONSISTENCY — the payout figure', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
