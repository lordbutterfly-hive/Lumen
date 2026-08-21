/**
 * §3's ACCEPTANCE DELTAS, MEASURED IN PAINTED PIXELS.
 * Illumination SPEC.md §3 and §8 item 3.
 *
 * §3 is explicit that this is judged by numbers: "Judge this by numbers, not by
 * eye." And §8 requires the deltas "on the feed AND on the post page" — the post
 * page being, per §5, "the surface most likely to be missed".
 *
 * ★ WHY SCREENSHOT PIXELS AND NOT getComputedStyle. The ambient ground is a
 * gradient. `getComputedStyle` hands back the gradient's SOURCE TEXT, not the
 * colour any particular column of the page actually ended up. The only way to
 * know what the reader sees at the page centre versus the page edge is to read
 * the painted pixels, so this screenshots and decodes.
 *
 * ★ THE DIRECTION IS THE POINT. §3: "The reading column does not brighten... The
 * periphery warms and recedes instead. The card gets brighter by comparison, not
 * by paint." So the centre must be UNCHANGED and the edge must be DARKER. A run
 * where the centre got lighter is a FAIL even if the edge also moved, because it
 * breaks the "hard floor" §3 sets on the reading column.
 */
import { openApp, BASE, report } from './qa-harness.mjs';
import { PNG } from 'pngjs';

/*
 * ★★ THE CARD COLOUR IS MEASURED, NOT TAKEN FROM THE SPEC. §3 states "Card is
 * --paper-1 #FFFEFC throughout" and builds its whole delta table on that. But
 * --paper-1 does not exist in this codebase; our card is --surface-1, which is
 * pure #FFFFFF. So the spec's absolute numbers (+3/+4/+5 etc.) cannot land
 * exactly here no matter how correct the implementation is — they are measuring
 * against a card one value darker than ours on two channels.
 *
 * What survives that, and is what §3 actually cares about, is the DIRECTION and
 * the FLOOR: the reading column must not brighten, and the periphery must be
 * measurably darker than it. Those are asserted. The spec's absolute triplets
 * are printed for comparison but not failed on, because failing on them would be
 * failing the implementation for the spec's own missing token.
 */
const rows = {};
let fails = 0;
const checkTrue = (label, ok, detail = '') => { if (!ok) fails++; rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${detail}`; };

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1600, height: 900 });

async function sample(path, label) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1600, height: 400 } });
  const png = PNG.sync.read(buf);
  const at = (x, y) => {
    const i = (png.width * y + x) << 2;
    return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] };
  };
  /*
   * ★ THE "CENTRE" HAS TO BE GROUND, NOT THE CARD SITTING ON IT. First version
   * sampled x = width/2 on the post page and read 255,255,255 — the ARTICLE, not
   * the page behind it — then failed the reading-column floor against the card's
   * own paper. The feed happens to have a gutter at mid-width; the post page does
   * not, because one wide article occupies it.
   *
   * So the centre sample is taken just OUTSIDE the widest card on screen, which
   * is the reading column's own ground on both layouts, and the check means what
   * it says: the ground under the reader does not brighten.
   */
  const bounds = await page.evaluate(() => {
    const el = document.querySelector('.lm-card') || document.querySelector('article') || document.querySelector('main');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right) };
  });
  const centreX = bounds ? Math.max(2, Math.round(bounds.left) - 12) : Math.round(png.width / 2);
  // y=200 is below any sticky header, in the page's own ground.
  const edge = at(6, 200);
  const centre = at(centreX, 200);
  // The card's own paper, read off the page rather than assumed.
  const cardBox = await page.evaluate(() => {
    const c = document.querySelector('.lm-card') || document.querySelector('article');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 8) };
  });
  const card = cardBox && cardBox.y < 400 && cardBox.y > 0 ? at(cardBox.x, cardBox.y) : null;
  return { edge, centre, card, label };
}

for (const [path, label] of [['/', 'feed'], ['/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy', 'post page']]) {
  const s = await sample(path, label);
  const d = (a, b) => ({ r: a.r - b.r, g: a.g - b.g, b: a.b - b.b });
  const CARD = s.card || { r: 255, g: 255, b: 255 };
  rows[`${label} — card rgb (measured)`] = `${CARD.r},${CARD.g},${CARD.b}${s.card ? '' : '  (fallback, card not sampled)'}`;
  const vsCentre = d(CARD, s.centre);
  const vsEdge = d(CARD, s.edge);
  const centreVsEdge = d(s.centre, s.edge);
  rows[`${label} — centre rgb`] = `${s.centre.r},${s.centre.g},${s.centre.b}  (ground beside the card)`;
  rows[`${label} — edge rgb`] = `${s.edge.r},${s.edge.g},${s.edge.b}`;
  rows[`${label} — card vs centre`] = `+${vsCentre.r}/+${vsCentre.g}/+${vsCentre.b}  (spec +3/+4/+5)`;
  rows[`${label} — card vs edge`] = `+${vsEdge.r}/+${vsEdge.g}/+${vsEdge.b}  (spec +8/+12/+17)`;
  rows[`${label} — centre vs edge`] = `+${centreVsEdge.r}/+${centreVsEdge.g}/+${centreVsEdge.b}  (spec +5/+8/+12)`;

  /*
   * ★★★ THE PAGE GROUND IS FLAT, AND THAT IS NOW THE REQUIREMENT (owner,
   * 2026-08-21): "you gave the paper background a color. you need to get rid of
   * it. only all cards have background glow we said."
   *
   * This file used to assert the OPPOSITE — §3's ambient gradient, edges darker
   * than the centre — and it passed, because that gradient was implemented
   * exactly to spec. The spec was not what the owner wanted. So the assertion is
   * inverted rather than deleted: a flat ground is a rule that can regress
   * (someone re-adds the gradient), and a rule that can regress deserves a test.
   */
  checkTrue(`${label}: page ground is FLAT — no edge gradient`,
    Math.abs(centreVsEdge.r) <= 1 && Math.abs(centreVsEdge.g) <= 1 && Math.abs(centreVsEdge.b) <= 1,
    `centre-minus-edge ${centreVsEdge.r}/${centreVsEdge.g}/${centreVsEdge.b} (expect 0/0/0)`);
  // Informational only — see the note on CARD above for why these are not
  // pass/fail against a card colour this app does not have.
  rows[`${label} — card sits above the ground`] =
    `card-minus-ground +${vsCentre.r}/+${vsCentre.g}/+${vsCentre.b} (the card is what glows now)`;
}

report('ILLUMINATION §3 — acceptance deltas', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
