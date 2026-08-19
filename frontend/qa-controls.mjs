/**
 * EVERY CONTROL ON EVERY PAGE WE OWN.
 *
 * For each button, link-styled-as-button and menu item on all 30 rendering
 * routes, signed in, this measures the things a reader actually experiences:
 *
 *   1. NAME        does it have an accessible name at all (text, aria-label,
 *                  title)? An icon button with none is unusable with a screen
 *                  reader and unnameable in a bug report.
 *   2. FONT        family / size / weight — the all-Lora sweep must reach controls
 *                  too, and a control is the easiest place for a stray family to
 *                  survive because nobody reads a button, they press it.
 *   3. CLIPPING    scrollWidth > clientWidth — a label whose ink runs past its own
 *                  box. This is the failure a font swap causes on controls, since
 *                  buttons are the widest collection of fixed-width boxes we own.
 *   4. HIT TARGET  WCAG 2.2 AA (2.5.8) wants 24x24 CSS px minimum. Reported, and
 *                  exempt where the spec exempts it (inline in a sentence).
 *   5. PRESS       does the press feedback rule actually reach it? globals.css
 *                  promises "every control acknowledges a click" via a 90ms
 *                  transform transition; a control with `transition-property`
 *                  overridden never got the promise.
 *   6. FOCUS       tab to it and measure whether ANYTHING visibly changes
 *                  (outline, box-shadow, background, border). A keyboard user who
 *                  cannot see where they are cannot use the page at all.
 *
 * ★ NOTHING IS CLICKED. These pages are signed in against real chain data: a click
 * sweep would vote, reblog, follow, mute, publish and transfer. Everything here is
 * measured from computed style and geometry, plus keyboard focus, which changes no
 * state. Where a control's behaviour needs proving, that belongs in a targeted
 * script that knows what it is about to do.
 */
import { openApp, BASE } from './qa-harness.mjs';
import fs from 'fs';

const ROUTES = [
  ['/', 'home feed'],
  ['/topics/photography', 'topic'],
  ['/search?q=hive', 'search'],
  ['/communities', 'communities'],
  ['/creators', 'creators'],
  ['/creators/launch', 'meritum launch'],
  ['/creators/studio', 'creator studio'],
  ['/creators/@magi.contracts', 'token market'],
  ['/wallet', 'wallet'],
  ['/wallet/tokens', 'your tokens'],
  ['/witnesses', 'witnesses'],
  ['/proposals', 'proposals'],
  ['/ranks', 'ranks'],
  ['/security', 'security'],
  ['/upgrade', 'upgrade'],
  ['/submit.html', 'composer'],
  ['/help.html', 'help'],
  ['/tos.html', 'tos'],
  ['/privacy.html', 'privacy'],
  ['/healthchecker', 'healthchecker'],
  ['/service-unavailable', 'service unavailable'],
  ['/this-route-does-not-exist', '404'],
  ['/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy', 'post detail'],
  ['/@lordbutterfly', 'profile'],
  ['/@lordbutterfly/settings', 'settings'],
  ['/@lordbutterfly/followers', 'followers'],
  ['/@lordbutterfly/following', 'following'],
  ['/@lordbutterfly/communities', 'profile communities'],
  ['/@lordbutterfly/feed', 'profile feed']
];

const INVENTORY = () => {
  const isMono = (f) => /mono|consolas|menlo|cascadia|courier/i.test(f);
  // Google's sign-in button is third-party chrome we cannot restyle — §7 of the
  // typography spec names it. Excluded by its own class prefix, not by route, so
  // it stays excluded wherever it appears and nothing else gets excused with it.
  const isThirdParty = (e) => !!e.closest('[class*="nsm7Bb"], iframe, [id^="credential_picker"]');
  // ★ `aria-hidden` IS NOT IN THE ACCESSIBILITY TREE, so it cannot be a control
  // "with no accessible name" — there is no node to name. Counting it reported a
  // defect on a decorative icon that had been deliberately hidden, which is the
  // harness disagreeing with the platform rather than finding anything.
  const hidden = (e) => !!e.closest('[aria-hidden="true"], [aria-hidden=""]');

  const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], summary')].filter(
    (e) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && !isThirdParty(e) && !hidden(e);
    }
  );

  const name = (e) =>
    (e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent || '').trim() ||
      (e.querySelector('[class*="sr-only"]')?.textContent || '').trim() ||
      e.getAttribute('data-testid') || '').trim();

  return controls.map((e, i) => {
    const s = getComputedStyle(e);
    const b = e.getBoundingClientRect();
    // ★ CLIPPED MEANS THE BOX ACTUALLY CLIPS. A first version compared
    // scrollWidth/scrollHeight against client size and reported 58 hits — exactly
    // two on every route, which is the shape of a harness artefact, not a bug. Both
    // were the header's icon buttons, and both contain absolutely-positioned
    // decorative rings LARGER than the button (48, 43, 50 and 57px rings inside a
    // 36px avatar button) that are meant to paint outside it. With
    // `overflow: visible` nothing is hidden, so that is not clipping — it is the
    // design. Ink is only lost when the box is set to clip it, so that is the test,
    // matching the rule check F in qa-typography.mjs already uses.
    // `sr-only` is deliberately a 1x1 clip and is doing its job, so it is exempt.
    const srOnly = /sr-only/.test(String(e.className));
    // ★ AND `text-overflow: clip` IS NOT A CLIP. The first correction still counted
    // all 58, because it treated `text-overflow` as evidence — but `clip` is that
    // property's INITIAL value, present on every element in the document, and it
    // does nothing at all unless `overflow` is already hidden. Only `ellipsis` is a
    // deliberate truncation. Measured on both header buttons: `overflow: visible`,
    // and their rings and unread badge are painted outside the box on purpose
    // (+3, +6, +9 and +11px, all `visibility: visible`, all topmost at their own
    // coordinates). Nothing is being cut off.
    const clips = !/^visible/.test(s.overflow) || s.webkitLineClamp !== 'none';
    return {
      i,
      tag: e.tagName.toLowerCase(),
      name: name(e).slice(0, 46),
      hasName: name(e).length > 0,
      family: s.fontFamily.split(',')[0].replace(/['"]/g, ''),
      lora: /lora/i.test(s.fontFamily) || isMono(s.fontFamily),
      size: parseFloat(s.fontSize),
      weight: Number(s.fontWeight),
      w: Math.round(b.width),
      h: Math.round(b.height),
      clipped: !srOnly && clips && (e.scrollWidth - e.clientWidth > 1 || e.scrollHeight - e.clientHeight > 1),
      overflowsButVisible: !srOnly && !clips && (e.scrollWidth - e.clientWidth > 1 || e.scrollHeight - e.clientHeight > 1),
      disabled: e.disabled === true || e.getAttribute('aria-disabled') === 'true',
      // The press rule promises a transform transition on every enabled control.
      pressWired: /transform/.test(s.transitionProperty) || s.transitionProperty === 'all',
      inlineInText: (() => {
        const p = e.parentElement;
        if (!p) return false;
        const ps = getComputedStyle(p);
        return /^(p|span|li|td)$/.test(p.tagName.toLowerCase()) && parseFloat(ps.fontSize) >= 14;
      })(),
      testid: e.getAttribute('data-testid') || ''
    };
  });
};

const { browser, page } = await openApp({ loggedIn: true });
const all = [];
let focusChecked = 0;
let focusInvisible = [];

for (const [path, label] of ROUTES) {
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2200);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  } catch {
    console.log(`  ${label.padEnd(22)} PAGE FAILED TO LOAD`);
    continue;
  }

  const landed = new URL(page.url()).pathname;
  const rows = await page.evaluate(INVENTORY);

  // ── focus visibility, measured on every control ──────────────────────────
  const noFocusRing = await page.evaluate(() => {
    const isThirdParty = (e) => !!e.closest('[class*="nsm7Bb"], iframe, [id^="credential_picker"]');
    const controls = [...document.querySelectorAll('button, [role="button"], [role="tab"]')].filter((e) => {
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      return s.display !== 'none' && b.width > 0 && b.height > 0 && !isThirdParty(e) && !e.disabled;
    });
    const sig = (e) => {
      const s = getComputedStyle(e);
      return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.borderColor].join('|');
    };
    const bad = [];
    for (const e of controls) {
      const before = sig(e);
      e.focus({ preventScroll: true });
      const after = sig(e);
      e.blur();
      if (before === after)
        bad.push(
          (e.getAttribute('aria-label') || (e.textContent || '').trim() || e.getAttribute('data-testid') || e.tagName).slice(0, 40)
        );
    }
    return { total: controls.length, bad };
  });
  focusChecked += noFocusRing.total;
  if (noFocusRing.bad.length) focusInvisible.push({ label, bad: noFocusRing.bad });

  const nameless = rows.filter((r) => !r.hasName);
  const nonLora = rows.filter((r) => !r.lora);
  const clipped = rows.filter((r) => r.clipped);
  const small = rows.filter((r) => (r.w < 24 || r.h < 24) && !r.inlineInText);
  const overweight = rows.filter((r) => r.weight > 700);
  const tiny = rows.filter((r) => r.size < 14 && r.size > 0);
  const noPress = rows.filter((r) => !r.disabled && !r.pressWired);

  all.push({ label, path, landed, count: rows.length, nameless, nonLora, clipped, small, overweight, tiny, noPress, focus: noFocusRing });

  console.log(
    `  ${label.padEnd(22)} ${String(rows.length).padStart(3)} controls | noName=${nameless.length} nonLora=${nonLora.length} clipped=${clipped.length} <24px=${small.length} w>700=${overweight.length} <14px=${tiny.length} noPress=${noPress.length} noFocusRing=${noFocusRing.bad.length}`
  );
}

const sum = (k) => all.reduce((a, r) => a + r[k].length, 0);
console.log('\n════ CONTROL TOTALS across ' + all.length + ' routes ════');
console.log(`controls measured ................. ${all.reduce((a, r) => a + r.count, 0)}`);
console.log(`without an accessible name ........ ${sum('nameless')}   (expect 0)`);
console.log(`not rendering in Lora ............. ${sum('nonLora')}   (expect 0)`);
console.log(`with clipped labels ............... ${sum('clipped')}   (expect 0)`);
console.log(`smaller than 24x24 ................ ${sum('small')}`);
console.log(`weight above 700 .................. ${sum('overweight')}   (expect 0)`);
console.log(`label under 14px .................. ${sum('tiny')}`);
console.log(`without press feedback wired ...... ${sum('noPress')}`);
console.log(`focusable controls focus-tested ... ${focusChecked}`);
console.log(`with NO visible focus change ...... ${focusInvisible.reduce((a, r) => a + r.bad.length, 0)}   (expect 0)`);

const detail = (k, title) => {
  const rows = all.flatMap((r) => r[k].map((x) => ({ route: r.label, ...x })));
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const r of rows.slice(0, 30))
    console.log(`  ${r.route.padEnd(20)} <${r.tag}> "${r.name}" ${r.size}px/${r.weight} ${r.family} ${r.w}x${r.h}`);
  if (rows.length > 30) console.log(`  ... and ${rows.length - 30} more`);
};
detail('nameless', 'CONTROLS WITH NO ACCESSIBLE NAME:');
detail('nonLora', 'CONTROLS NOT IN LORA:');
detail('clipped', 'CONTROLS WITH CLIPPED LABELS:');
detail('overweight', 'CONTROLS ABOVE WEIGHT 700:');
detail('tiny', 'CONTROLS WITH SUB-14px LABELS:');
detail('small', 'CONTROLS UNDER 24x24:');
detail('noPress', 'CONTROLS WITH NO PRESS FEEDBACK:');
if (focusInvisible.length) {
  console.log('\nCONTROLS WITH NO VISIBLE FOCUS CHANGE:');
  for (const r of focusInvisible) console.log(`  ${r.label}: ${r.bad.slice(0, 8).join(' | ')}${r.bad.length > 8 ? ` (+${r.bad.length - 8})` : ''}`);
}

fs.writeFileSync('/mnt/o/LUMEN-DOCS/lora-spec/qa-controls.json', JSON.stringify(all, null, 2));
await browser.close();
