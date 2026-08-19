/**
 * DOES THE PAYOUT HOVER CARD RENDER ON TOP, OR UNDER THE NEXT CARD?
 *
 * Owner report: "the hover over payout renders behind cards."
 *
 * A screenshot is weak evidence here — the popover is opaque, so a reader cannot
 * always tell "drawn under the next card" from "drawn slightly off-position".
 * `document.elementFromPoint()` can: it returns whatever the browser would deliver
 * a click to at that pixel, which IS the paint order. If the topmost element at
 * the centre of the popover is not inside the popover, the popover is behind
 * something, and the answer says exactly what.
 *
 * Also reported: whether the content is portalled to <body> or nested inside the
 * card, because that is the cause rather than the symptom — a descendant cannot
 * escape an ancestor's stacking context whatever its z-index says, and every feed
 * card is a stacking context three times over (will-change, :hover transform, and
 * the `both` fill on the entrance animation).
 */
import { openApp, BASE } from './qa-harness.mjs';

const { browser, page } = await openApp({ loggedIn: true });
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3500);
await page.evaluate(() => document.fonts.ready);
// let the entrance animation finish so we measure the resting state
await page.waitForTimeout(1200);

const chips = page.locator('[data-testid="medium-card-payout"]');
const n = await chips.count();
console.log(`payout chips on the feed .................. ${n}`);

let measured = null;
for (let i = 0; i < Math.min(n, 6); i++) {
  const chip = chips.nth(i);
  await chip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await chip.hover();
  await page.waitForTimeout(700);

  const r = await page.evaluate((idx) => {
    const content = document.querySelector('[data-testid="payout-post-card-tooltip"]');
    if (!content) return { open: false };
    const b = content.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) return { open: false };

    // where does the browser think a click lands, across the popover's face?
    const pts = [
      [b.left + b.width / 2, b.top + b.height / 2],
      [b.left + 6, b.top + 6],
      [b.right - 6, b.bottom - 6],
      [b.left + b.width / 2, b.bottom - 4]
    ];
    const hits = pts.map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { covered: true, by: '(nothing)' };
      const inside = content.contains(el) || el === content;
      const card = el.closest('article, .lm-card');
      return {
        covered: !inside,
        by: inside
          ? 'the popover itself'
          : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}${card ? ' [inside a feed card]' : ''}`
      };
    });

    // ancestor chain: portalled to body, or trapped inside a card?
    const chain = [];
    let p = content.parentElement;
    while (p && chain.length < 12) {
      chain.push(
        `${p.tagName.toLowerCase()}${p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`
      );
      p = p.parentElement;
    }
    const trappedIn = content.closest('article, .lm-card');

    // which ancestors are stacking contexts?
    const stackers = [];
    let q = content.parentElement;
    while (q && q !== document.documentElement) {
      const s = getComputedStyle(q);
      const why = [];
      if (s.transform !== 'none') why.push(`transform:${s.transform.slice(0, 26)}`);
      if (s.willChange !== 'auto') why.push(`will-change:${s.willChange}`);
      if (s.isolation === 'isolate') why.push('isolation:isolate');
      if (s.opacity !== '1') why.push(`opacity:${s.opacity}`);
      if (s.filter !== 'none') why.push('filter');
      if (why.length)
        stackers.push(
          `${q.tagName.toLowerCase()}${q.className && typeof q.className === 'string' ? '.' + q.className.trim().split(/\s+/)[0] : ''} -> ${why.join(', ')}`
        );
      q = q.parentElement;
    }

    return {
      open: true,
      idx,
      zIndex: getComputedStyle(content).zIndex,
      box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
      hits,
      portalled: !trappedIn,
      trappedIn: trappedIn
        ? `${trappedIn.tagName.toLowerCase()}.${String(trappedIn.className).trim().split(/\s+/).slice(0, 2).join('.')}`
        : null,
      chain,
      stackers
    };
  }, i);

  if (r.open) {
    measured = r;
    break;
  }
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
}

if (!measured) {
  console.log('NO PAYOUT HOVER CARD OPENED — nothing measured, this run proves nothing.');
  console.log('(every chip tried had payout <= 0, which renders a plain div and no hover card)');
  await browser.close();
  process.exit(2);
}

const covered = measured.hits.filter((h) => h.covered);
console.log(`hover card opened on chip #${measured.idx}`);
console.log(`  z-index ................................. ${measured.zIndex}`);
console.log(`  box ..................................... ${measured.box.w}x${measured.box.h} at ${measured.box.x},${measured.box.y}`);
console.log(`  portalled to <body> ..................... ${measured.portalled ? 'YES' : 'NO'}`);
if (measured.trappedIn) console.log(`  trapped inside .......................... ${measured.trappedIn}`);
console.log(`  points covered by something else ........ ${covered.length}/4   (expect 0)`);
for (const h of measured.hits) console.log(`     ${h.covered ? 'COVERED by' : 'on top   —'} ${h.by}`);
console.log('  stacking contexts between it and <html>:');
if (measured.stackers.length === 0) console.log('     (none)');
for (const s of measured.stackers) console.log(`     ${s}`);
console.log('');
console.log(covered.length === 0 ? 'VERDICT: the payout hover card is ON TOP.' : 'VERDICT: the payout hover card is BEHIND something.');

await page.screenshot({ path: '/mnt/o/LUMEN-DOCS/lora-spec/shots/payout-hover.png' });

// ── MUTATION CHECK ──────────────────────────────────────────────────────────
// "It is on top" is only evidence that the PORTAL is what puts it there if the
// measurement can also report the opposite. So put the popover back where it used
// to live — inside the card that triggered it — and measure again with everything
// else identical. If it goes behind, the portal is the fix; if it stays on top,
// the clean reading above was not earned by this change and the real cause is
// something else.
const mutated = await page.evaluate(() => {
  const content = document.querySelector('[data-testid="payout-post-card-tooltip"]');
  const wrapper = content?.closest('[data-radix-popper-content-wrapper]') || content;
  const card = document.querySelector('article');
  if (!content || !card) return { ran: false };
  // ★ POSITION IT RELATIVE TO THE CARD, NOT WITH `position: fixed`.
  // A first attempt pinned it with `fixed` at its old viewport coordinates and the
  // popover vanished off-screen, so the probe measured empty pixels and "proved"
  // nothing. The reason is the bug itself: `.lm-card` carries a transform, and a
  // transformed ancestor becomes the containing block for `position: fixed`
  // descendants too — so `fixed` stopped meaning "relative to the viewport" the
  // moment the node moved inside the card. Absolute placement inside the card is
  // the honest reproduction of how this rendered before the portal.
  card.style.position = card.style.position || 'relative';
  card.appendChild(wrapper);
  wrapper.style.position = 'absolute';
  wrapper.style.transform = 'none';
  wrapper.style.left = '40px';
  wrapper.style.top = (card.getBoundingClientRect().height - 30) + 'px';
  void document.body.offsetHeight;

  const b = content.getBoundingClientRect();
  const inViewport = b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth && b.width > 4;
  if (!inViewport) return { ran: false, why: `re-parented box is not measurable: ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}` };
  const pts = [
    [b.left + b.width / 2, b.top + b.height / 2],
    [b.left + 6, b.top + 6],
    [b.right - 6, b.bottom - 6],
    [b.left + b.width / 2, b.bottom - 4]
  ];
  const describe = (el) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const hits = pts.map(([x, y]) => {
    // `elementsFromPoint` (plural) IS the paint order at that pixel, front to back.
    // The singular call can answer `null`, which says "nothing here" and does not
    // distinguish "clipped away" from "off-screen" — not good enough to base a
    // claim on.
    const stack = document.elementsFromPoint(x, y);
    const top = stack[0];
    const inside = top && (content.contains(top) || top === content);
    const depth = stack.findIndex((e) => content.contains(e) || e === content);
    return {
      covered: !inside,
      by: !top ? '(outside the viewport)' : inside ? 'the popover itself' : describe(top),
      depth,
      stack: stack.slice(0, 4).map(describe)
    };
  });
  return { ran: true, hits, nowInside: !!content.closest('article'), visible: content.getBoundingClientRect().width > 4 };
});

if (!mutated.ran && mutated.why) {
  console.log('');
  console.log(`MUTATION DID NOT RUN — ${mutated.why}`);
  console.log('Treat the clean reading above as measured but NOT yet attributed to the portal.');
}
if (mutated.ran) {
  const mCovered = mutated.hits.filter((h) => h.covered);
  console.log('');
  console.log('MUTATION — the same popover moved back inside the card:');
  console.log(`  now nested in a feed card ............... ${mutated.nowInside ? 'yes' : 'no'}`);
  console.log(`  points covered by something else ........ ${mCovered.length}/4   (must be > 0)`);
  for (const h of mutated.hits)
    console.log(
      `     ${h.covered ? 'COVERED by' : 'on top   —'} ${h.by}` +
        (h.covered ? `   | popover sits at depth ${h.depth < 0 ? 'NOT PAINTED HERE' : h.depth} in the stack [${h.stack.join(' > ')}]` : '')
    );
  console.log('');
  console.log(
    covered.length === 0 && mCovered.length > 0
      ? 'MUTATION VERDICT: the check can report a covered popover, and the portal is what prevents it.'
      : 'MUTATION VERDICT: INCONCLUSIVE — the clean reading was not earned by the portal.'
  );
}

await browser.close();
process.exit(covered.length === 0 ? 0 : 1);
