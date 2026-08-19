/**
 * EVERY ANIMATION, MEASURED RUNNING — not read off a stylesheet.
 *
 * A `@keyframes` block in a file proves nothing: the rule can be overridden, the
 * class can be unreachable, the element can be `display:none` when it plays, and
 * `prefers-reduced-motion` can switch it off in a way that also breaks the thing
 * it was decorating. Each check below drives the real page and reads geometry or
 * computed style at two points in time.
 *
 *   1. CARD ENTRANCE   `.lm-enter` staggered fade+rise. Measured by capturing
 *                      opacity/transform DURING the animation and again after.
 *   2. CARD HOVER LIFT `.lm-card:hover` translateY(-2px) + shadow step.
 *   3. PRESS FEEDBACK  `:active { transform: scale(.97) }` on a real control,
 *                      driven with mouse down/up rather than assumed from CSS.
 *   4. DRAWER          the top-comment drawer's height transition, 0 -> open.
 *   5. REDUCED MOTION  the same page under `prefers-reduced-motion: reduce` —
 *                      animations must STOP while the content they carry stays
 *                      visible and the drawer still opens. An entrance animation
 *                      that is switched off by setting opacity 0 forever is the
 *                      classic way this breaks, so opacity is asserted, not hoped.
 *   6. KEYFRAME REACH  which of the stylesheet's `@keyframes` are actually bound
 *                      to a rendered element on this page, and which are not.
 */
import { openApp, BASE } from './qa-harness.mjs';

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const { browser, page } = await openApp({ loggedIn: true });

// ── 1. card entrance ────────────────────────────────────────────────────────
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
const entrance = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // wait for cards to exist, then sample the LAST one, whose stagger delay is longest
  for (let i = 0; i < 60 && !document.querySelector('.lm-enter'); i++) await wait(200);
  const cards = [...document.querySelectorAll('.lm-enter')];
  if (!cards.length) return { found: 0 };
  const el = cards[Math.min(4, cards.length - 1)];
  const s = getComputedStyle(el);
  const names = s.animationName;
  const dur = s.animationDuration;
  const fill = s.animationFillMode;
  const running = el.getAnimations().length;
  await wait(1500);
  const after = getComputedStyle(el);
  return {
    found: cards.length,
    names,
    dur,
    fill,
    running,
    afterOpacity: after.opacity,
    afterTransform: after.transform
  };
});
rec('feed cards carry the entrance animation', entrance.found > 0 && entrance.names.includes('lm-enter'),
  `${entrance.found} cards, animation-name=${entrance.names}, ${entrance.dur}, fill=${entrance.fill}`);
rec('the entrance actually ran (Web Animations reported it)', entrance.running > 0, `${entrance.running} animation object(s)`);
rec('and it ends VISIBLE, not stuck at opacity 0', entrance.afterOpacity === '1',
  `opacity after = ${entrance.afterOpacity}, transform = ${entrance.afterTransform}`);

// ── 2. hover lift ───────────────────────────────────────────────────────────
const lift = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const card = document.querySelector('.lm-card');
  if (!card) return { found: false };
  const rest = getComputedStyle(card);
  const restT = rest.transform;
  const restS = rest.boxShadow;
  card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  // computed :hover cannot be forced from JS, so read the RULE that would apply
  // ★ RECURSE. The first version walked only top-level rules and reported "no
  // :hover rule exists" — a false failure. The rule is real; it lives two levels
  // down, inside `@layer utilities { @media (hover: hover) { ... } }`, and a flat
  // scan of `sheet.cssRules` cannot see it.
  const rules = [];
  const walk = (list, depth) => {
    if (depth > 4) return;
    for (const r of list) {
      if (r.selectorText && /\.lm-card:hover/.test(r.selectorText)) rules.push(r.cssText.slice(0, 160));
      if (r.cssRules) { try { walk(r.cssRules, depth + 1); } catch {} }
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, 0); } catch {} }
  await wait(50);
  return { found: true, restT, restS, rules };
});
rec('cards rest with a shadow to lift FROM', lift.found && lift.restS !== 'none', `resting box-shadow = ${String(lift.restS).slice(0, 60)}`);
rec('a :hover lift rule exists in the live stylesheet', (lift.rules || []).length > 0, (lift.rules || [])[0] || 'none found');

// hover for real and measure the painted position
const realLift = await page.evaluate(() => {
  const card = document.querySelector('.lm-card');
  return card ? Math.round(card.getBoundingClientRect().top) : null;
});
await page.locator('.lm-card').first().hover();
await page.waitForTimeout(300);
const liftedTop = await page.evaluate(() => {
  const card = document.querySelector('.lm-card');
  const s = getComputedStyle(card);
  return { top: Math.round(card.getBoundingClientRect().top), transform: s.transform, shadow: s.boxShadow.slice(0, 60) };
});
// ★ COMPARE THE PAINTED POSITION, NOT THE STRING. The first version asserted
// `transform !== 'none'` and passed on `matrix(1, 0, 0, 1, 0, 0)` — the IDENTITY
// matrix, i.e. a card that had not moved at all. It reported a green tick over a
// real regression (the entrance animation's `both` fill was outranking the hover
// transform). A movement check has to measure movement.
rec('hovering a card really moves it', liftedTop.top !== realLift,
  `top ${realLift} -> ${liftedTop.top} (${realLift - liftedTop.top}px), transform under hover = ${liftedTop.transform}`);

// ── 3. press feedback, driven ───────────────────────────────────────────────
const press = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button:not(:disabled)')].find((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  });
  if (!btn) return { found: false };
  btn.setAttribute('data-qa-press-target', '1');
  const s = getComputedStyle(btn);
  return { found: true, transitionProperty: s.transitionProperty, transitionDuration: s.transitionDuration, resting: s.transform };
});
if (press.found) {
  const target = page.locator('[data-qa-press-target="1"]').first();
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(120);
  const pressed = await page.evaluate(() => getComputedStyle(document.querySelector('[data-qa-press-target="1"]')).transform);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const released = await page.evaluate(() => getComputedStyle(document.querySelector('[data-qa-press-target="1"]')).transform);
  rec('a control visibly shrinks while held down', pressed !== press.resting, `resting=${press.resting} -> pressed=${pressed}`);
  rec('and springs back on release', released === press.resting, `released=${released}`);
  rec('the press transition is on the resting state, so both halves animate',
    /transform/.test(press.transitionProperty) && parseFloat(press.transitionDuration) > 0,
    `${press.transitionProperty} ${press.transitionDuration}`);
} else {
  rec('a pressable control was found', false, 'none');
}

// ── 4. drawer transition ────────────────────────────────────────────────────
const drawerCheck = await (async () => {
  // ★ PARK THE CURSOR FIRST. Without this the "at rest" reading is taken with the
  // pointer wherever the press probe left it — which can be on a card — so the
  // drawer is measured mid-transition and reports a fractional height (0.28px was
  // the reading that exposed this). A resting measurement has to be taken at rest.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  const closed = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="post-card-drawer"]');
    return d ? { h: d.getBoundingClientRect().height, transition: getComputedStyle(d).transitionProperty, dur: getComputedStyle(d).transitionDuration } : null;
  });
  if (!closed) return { ok: false, why: 'no drawer in DOM' };
  await page.locator('article').first().hover();
  await page.waitForTimeout(1200);
  const open = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="post-card-drawer"]');
    return d ? d.getBoundingClientRect().height : -1;
  });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  const shut = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="post-card-drawer"]');
    return d ? d.getBoundingClientRect().height : -1;
  });
  return { ok: true, closed: closed.h, open, shut, transition: closed.transition, dur: closed.dur };
})();
if (drawerCheck.ok) {
  rec('drawer is 0-high at rest', drawerCheck.closed === 0, `${drawerCheck.closed}px`);
  rec('drawer opens on hover', drawerCheck.open > 20, `${drawerCheck.open}px`);
  rec('drawer closes again', drawerCheck.shut === 0, `${drawerCheck.shut}px`);
  rec('drawer height is transitioned, not snapped', /height/.test(drawerCheck.transition) && parseFloat(drawerCheck.dur) > 0,
    `${drawerCheck.transition} ${drawerCheck.dur}`);
} else rec('drawer measured', false, drawerCheck.why);

// ── 6. which keyframes are actually reached ─────────────────────────────────
const keyframes = await page.evaluate(() => {
  const defined = new Set();
  for (const sheet of document.styleSheets) {
    try {
      for (const r of sheet.cssRules) if (r.type === CSSRule.KEYFRAMES_RULE) defined.add(r.name);
    } catch {}
  }
  const used = new Set();
  for (const el of document.querySelectorAll('*')) {
    const n = getComputedStyle(el).animationName;
    if (n && n !== 'none') n.split(',').map((x) => x.trim()).forEach((x) => used.add(x));
  }
  return { defined: [...defined].sort(), used: [...used].sort() };
});
console.log(`\n  keyframes defined in the live stylesheet: ${keyframes.defined.length}`);
console.log(`  bound to an element on the home feed ...: ${keyframes.used.length}  [${keyframes.used.join(', ')}]`);
console.log(`  defined but not reached here ..........: ${keyframes.defined.filter((k) => !keyframes.used.includes(k)).join(', ') || '(none)'}`);

await browser.close();

// ── 5. reduced motion, in a fresh context ───────────────────────────────────
const rm = await openApp({ loggedIn: true, reducedMotion: 'reduce' });
try {
  await rm.page.emulateMedia({ reducedMotion: 'reduce' });
} catch {}
await rm.page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await rm.page.waitForTimeout(3000);
const reduced = await rm.page.evaluate(() => {
  const card = document.querySelector('.lm-enter');
  const s = card ? getComputedStyle(card) : null;
  return {
    matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    animationName: s ? s.animationName : null,
    opacity: s ? s.opacity : null,
    transform: s ? s.transform : null,
    visible: card ? card.getBoundingClientRect().height > 20 : false
  };
});
rec('reduced-motion is actually in force for this context', reduced.matches === true, `matchMedia = ${reduced.matches}`);
rec('the entrance animation is switched off', reduced.animationName === 'none', `animation-name = ${reduced.animationName}`);
rec('★ and the card is STILL VISIBLE with it off', reduced.opacity === '1' && reduced.visible,
  `opacity = ${reduced.opacity}, rendered = ${reduced.visible}`);
const rmDrawer = await (async () => {
  await rm.page.locator('article').first().hover();
  await rm.page.waitForTimeout(1200);
  return rm.page.evaluate(() => {
    const d = document.querySelector('[data-testid="post-card-drawer"]');
    return d ? d.getBoundingClientRect().height : -1;
  });
})();
rec('★ and the drawer still opens under reduced motion', rmDrawer > 20, `${rmDrawer}px`);
await rm.browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n════ ${results.length - failed.length}/${results.length} animation checks pass ════`);
if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
process.exit(failed.length ? 1 : 0);
