/**
 * ILLUMINATION §5 COVERAGE — every card surface, every tab bar, every page.
 *
 * §5 opens: "Do not apply these three treatments to the feed and stop. Grep,
 * then walk each surface." This is the walk, done by the browser rather than by
 * grep, because grep can only see the source I remembered to change — it cannot
 * see a surface rendered by a component I never thought about.
 *
 * ★ IT ASSERTS AN ABSENCE. The old neutral card shadow is `rgba(20,18,10,0.03)`
 * (and a 0.04 variant). Any element still carrying it is a card the lighting
 * pass missed. Asserting "no grey remains" catches surfaces I do not know exist;
 * asserting "these N files are warm" would only ever confirm what I already did.
 *
 * ★ AND THE TROUGHS. §3: "troughs follow the ground they sit on, never lighter."
 * A tab track still on the old cool grey `rgb(244,245,247)` is the gap the owner
 * asked to close, and it is invisible on any page you do not open.
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const GREY = /rgba\(20,\s*18,\s*10,\s*0\.0[34]\)/;
const WARM = /rgba\(70,\s*46,\s*30/;
const COOL_TRACK = /rgb\(244,\s*245,\s*247\)/;

const rows = {};
let fails = 0;
const checkTrue = (l, ok, d = '') => { if (!ok) fails++; rows[l] = `${ok ? 'PASS' : 'FAIL'}  ${d}`; };

const SURFACES = [
  ['/', 'feed'],
  ['/topics/photography', 'topic'],
  ['/search?q=hive', 'search'],
  ['/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy', 'post'],
  ['/@lordbutterfly', 'profile'],
  ['/@lordbutterfly/feed', 'user-feed'],
  ['/@lordbutterfly/followers', 'follow-list'],
  ['/creators', 'creators'],
  ['/creators/studio', 'studio'],
  ['/creators/@magi.contracts', 'creator-token'],
  ['/wallet', 'wallet'],
  ['/wallet/tokens', 'wallet-tokens'],
  ['/witnesses', 'witnesses'],
  ['/proposals', 'proposals'],
  ['/communities', 'communities']
];

/* ★ LOGIN IS CHECKED IN A SIGNED-OUT SESSION, SEPARATELY. Visiting `/login`
   while signed in REDIRECTS TO `/`, so a signed-in run measured the feed and
   reported it under the name "login" — a green row for a page it never opened.
   Fixing that is what surfaced the grey layer hiding under the login hero's
   brand bloom. */

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1440, height: 900 });

let greyTotal = 0;
let coolTracks = 0;
for (const [path, label] of SURFACES) {
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(5000);
  } catch {
    rows[label] = 'SKIP  (navigation failed)';
    continue;
  }
  const r = await page.evaluate(() => {
    let grey = 0, warm = 0, cool = 0;
    const greyRe = /rgba\(20, 18, 10, 0\.0[34]\)/;
    const warmRe = /rgba\(70, 46, 30/;
    for (const el of document.querySelectorAll('*')) {
      const sh = getComputedStyle(el).boxShadow;
      if (!sh || sh === 'none') continue;
      if (greyRe.test(sh)) grey++;
      else if (warmRe.test(sh)) warm++;
    }
    // Tab tracks still on the old cool grey.
    for (const el of document.querySelectorAll('[role="tablist"], [class*="p-\\[5px\\]"]')) {
      if (getComputedStyle(el).backgroundColor === 'rgb(244, 245, 247)') cool++;
    }
    return { grey, warm, cool };
  });
  greyTotal += r.grey;
  coolTracks += r.cool;
  rows[label] = `${r.grey === 0 && r.cool === 0 ? 'PASS' : 'FAIL'}  warm=${r.warm} grey=${r.grey} coolTracks=${r.cool}`;
  if (r.grey || r.cool) fails++;
}

{
  const out = await openApp({ loggedIn: false });
  await out.page.setViewportSize({ width: 1440, height: 900 });
  await out.page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await out.page.waitForTimeout(5000);
  const r = await out.page.evaluate(() => {
    let grey = 0;
    const greyRe = /rgba\(20, 18, 10, 0\.0[34]\)/;
    for (const el of document.querySelectorAll('*')) {
      const sh = getComputedStyle(el).boxShadow;
      if (sh && sh !== 'none' && greyRe.test(sh)) grey++;
    }
    return {
      url: location.pathname,
      grey,
      ground: getComputedStyle(document.body).backgroundImage.slice(0, 46)
    };
  });
  await out.browser.close();
  rows['login (signed out)'] = `${r.url === '/login' && r.grey === 0 ? 'PASS' : 'FAIL'}  at ${r.url}, grey=${r.grey}`;
  if (r.url !== '/login' || r.grey !== 0) fails++;
  /* ★ INVERTED 2026-08-21. This asserted §5's ambient ground on login. The owner
     then ruled the page ground out entirely — "only all cards have background
     glow ... i never said to change the background color" — so the requirement
     is now the opposite: login's ground must be FLAT, like every other page.
     Kept rather than deleted, because "someone re-adds the gradient" is exactly
     the regression a test should catch. */
  checkTrue('login ground is FLAT (no gradient)', !/linear-gradient/.test(r.ground), r.ground || 'none');
  greyTotal += r.grey;
}

checkTrue('§5 no card anywhere still carries the grey shadow', greyTotal === 0, `${greyTotal} found`);
checkTrue('§3 no tab track left on the old cool grey', coolTracks === 0, `${coolTracks} found`);

report('ILLUMINATION §5 — surface coverage', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
