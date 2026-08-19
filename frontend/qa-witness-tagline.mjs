/**
 * MARGIN PROOF for the `break-words` fix on the witness tagline.
 *
 * The full typography pass now reports F=0 (no clipped text anywhere). On its
 * own that is NOT proof the fix works — F would also read 0 if today's witness
 * list simply happened to contain no bare-URL descriptions, i.e. if the check
 * had nothing to inspect. A gate with nothing in front of it always passes.
 *
 * So this probe does two things the aggregate cannot:
 *   1. proves the RISKY INPUT IS STILL PRESENT — counts tagline cells whose text
 *      carries an unbreakable token (a bare URL) long enough to have overflowed
 *      the fixed 340px box at 14px;
 *   2. reports the MARGIN for every cell (scrollWidth - clientWidth), not a
 *      pass/fail, so a cell that fits by 1px is visible as the near-miss it is.
 *
 * It also re-checks that `break-words` is the computed style actually in force,
 * not merely a class in the markup.
 */
import { openApp, BASE } from './qa-harness.mjs';

const { browser, page } = await openApp({ loggedIn: true });
await page.goto(BASE + '/witnesses', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
await page.evaluate(() => document.fonts.ready);

const out = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('div')].filter((e) =>
    /max-w-\[340px\]/.test(String(e.className))
  );
  return cells.map((e) => {
    const s = getComputedStyle(e);
    const t = (e.textContent || '').trim();
    // longest run with no break opportunity — this is what a URL creates
    const longest = t.split(/\s+/).reduce((m, w) => (w.length > m.length ? w : m), '');
    return {
      text: t.slice(0, 60),
      fontSize: s.fontSize,
      overflowWrap: s.overflowWrap,
      wordBreak: s.wordBreak,
      clientWidth: e.clientWidth,
      scrollWidth: e.scrollWidth,
      overflowPx: e.scrollWidth - e.clientWidth,
      longestToken: longest.slice(0, 40),
      longestLen: longest.length,
      hasUrl: /https?:\/\/|www\.|\.(com|org|io|net|eco)\b/i.test(t)
    };
  });
});

const risky = out.filter((c) => c.hasUrl || c.longestLen >= 20);
const over = out.filter((c) => c.overflowPx > 1);
const wrapOff = out.filter((c) => c.overflowWrap !== 'break-word' && c.wordBreak !== 'break-word');

console.log(`tagline cells rendered ............ ${out.length}`);
console.log(`  of which carry an unbreakable
  token >=20 chars or a URL ........ ${risky.length}   <-- the risky input MUST be > 0`);
console.log(`cells with computed break-words ... ${out.length - wrapOff.length}/${out.length}`);
console.log(`cells still overflowing ........... ${over.length}   (expect 0)`);
console.log(`font-size in force ................ ${[...new Set(out.map((c) => c.fontSize))].join(', ')}`);
console.log('');
console.log('RISKY CELLS, with margin:');
for (const c of risky.slice(0, 12)) {
  console.log(
    `  ${String(c.overflowPx).padStart(4)}px over | ${c.clientWidth}/${c.scrollWidth} | tok ${String(c.longestLen).padStart(3)} "${c.longestToken}" | ${c.text.slice(0, 42)}`
  );
}
if (over.length) {
  console.log('');
  console.log('STILL OVERFLOWING:');
  for (const c of over) console.log(`  +${c.overflowPx}px  ${c.text}`);
}
await browser.close();
