/**
 * ALL-LORA TYPOGRAPHY QA — the spec's §9 checklist, run on every rendering route.
 *
 * The typography spec ships five checks (A-E). This runs all five plus two the
 * spec does not have but this migration needs, on all 30 routes that actually
 * paint, signed in, against the PRODUCTION origin.
 *
 *   A  no element renders in a family that is not Lora (mono + iframes excluded)
 *   B  no element requests a weight above 700 (Lora's axis stops there)
 *   C  no LOWERCASE leaf text below 14px (Lora's x-height is 8% smaller)
 *   D  no synthesised small-caps (Lora ships no `smcp` table)
 *   E  how many distinct font sizes the page actually renders
 *   F  (added) text nodes whose ink overflows their own box — the failure a
 *      family swap causes that none of A-E can see
 *   G  (added) the document itself scrolling horizontally
 *
 * ★ ASSERT THE LANDED URL BEFORE RECORDING ANYTHING. A prior visual pass on this
 * app sampled `/creators/launch` logged-out, got bounced to `/login`, and half
 * the "palette" it reported was Google's sign-in button. Every row below carries
 * the URL the browser actually ended on.
 *
 * Run:
 *   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem node qa-typography.mjs
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
  ['/login', 'login'],
  ['/security', 'security'],
  ['/upgrade', 'upgrade'],
  ['/submit.html', 'composer'],
  ['/help.html', 'help'],
  ['/tos.html', 'tos'],
  ['/privacy.html', 'privacy'],
  ['/healthchecker', 'healthchecker'],
  ['/service-unavailable', 'service unavailable'],
  ['/this-route-does-not-exist', '404'],
  // ★ THE POST DETAIL PAGE WAS MISSING FROM THE FIRST RUN AND IT IS THE BIGGEST
  // SURFACE IN THE APP — the 36px hero title (§6, the one element that needed
  // real weight compensation), the 18px/68ch article body, the in-body heading
  // ramp, and the whole comment thread. A typography pass that skips it is not a
  // typography pass. Real permalink, taken from live trending.
  ['/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy', 'post detail'],
  ['/@lordbutterfly', 'profile'],
  ['/@lordbutterfly/settings', 'settings'],
  ['/@lordbutterfly/followers', 'followers'],
  ['/@lordbutterfly/following', 'following'],
  ['/@lordbutterfly/communities', 'profile communities'],
  ['/@lordbutterfly/feed', 'profile feed']
];

/** Runs INSIDE the page. Everything it returns is measured, nothing inferred. */
const PROBE = () => {
  const isMono = (f) => /mono|consolas|menlo|cascadia|courier/i.test(f);
  const all = [...document.querySelectorAll('body *')].filter((e) => {
    const s = getComputedStyle(e);
    return s.display !== 'none' && s.visibility !== 'hidden' && e.tagName !== 'IFRAME';
  });
  const leaf = all.filter((e) => !e.children.length && (e.textContent || '').trim().length > 0);

  const describe = (e) => {
    const s = getComputedStyle(e);
    return `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : ''} "${(e.textContent || '').trim().slice(0, 42)}" ${s.fontSize}/${s.fontWeight}`;
  };

  // A — family
  const nonLora = all.filter((e) => {
    const f = getComputedStyle(e).fontFamily;
    return !/lora/i.test(f) && !isMono(f);
  });

  // B — weight above Lora's 700 ceiling
  const overweight = all.filter((e) => Number(getComputedStyle(e).fontWeight) > 700);

  // C — lowercase leaf text under 14px
  const tooSmall = leaf.filter((e) => {
    const s = getComputedStyle(e);
    if (s.textTransform === 'uppercase') return false;
    const t = (e.textContent || '').trim();
    // A string with no lowercase letter is a label or a number, not lowercase prose.
    if (!/[a-z]/.test(t)) return false;
    return parseFloat(s.fontSize) < 14;
  });

  // D — synthesised small caps
  const smallCaps = all.filter((e) => /small-caps/.test(getComputedStyle(e).fontVariantCaps));

  // E — size ladder discipline
  const sizes = [...new Set(leaf.map((e) => getComputedStyle(e).fontSize))].sort(
    (a, b) => parseFloat(a) - parseFloat(b)
  );

  // F — ink wider than its own box. `+1` absorbs sub-pixel rounding.
  //
  // ★ `sr-only` IS EXCLUDED, AND THE FIRST RUN PROVED WHY. Screen-reader-only
  // text is deliberately clamped to a 1x1 box with `overflow:hidden`, so
  // `scrollWidth > clientWidth` is its DESIGN, not a defect. Counting it gave 97
  // "clipped" nodes across 29 routes, of which the witnesses page alone
  // contributed 65 — every one a `<span class="sr-only">gtg profile</span>`.
  // A check that reports its own harness noise buries the real finding.
  const clipped = leaf.filter((e) => {
    const s = getComputedStyle(e);
    if (s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowX === 'auto') return false;
    if (s.overflow === 'hidden' && e.clientWidth <= 2) return false;
    if (/(^|\s)sr-only(\s|$)/.test(e.className || '')) return false;
    if (e.clientHeight <= 2) return false;
    return e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 2;
  });

  return {
    url: location.pathname + location.search,
    counted: all.length,
    A: { n: nonLora.length, eg: nonLora.slice(0, 4).map(describe) },
    B: { n: overweight.length, eg: overweight.slice(0, 4).map(describe) },
    C: { n: tooSmall.length, eg: tooSmall.slice(0, 6).map(describe) },
    D: { n: smallCaps.length, eg: smallCaps.slice(0, 3).map(describe) },
    E: { n: sizes.length, sizes },
    F: { n: clipped.length, eg: clipped.slice(0, 5).map(describe) },
    G: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  };
};

const rows = [];
const { browser, page } = await openApp({ loggedIn: true });
fs.mkdirSync('/mnt/o/LUMEN-DOCS/lora-spec/shots', { recursive: true });

for (const [path, label] of ROUTES) {
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(1200);
    // ★ Fonts must be settled or every family reading is the fallback.
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(PROBE);
    const landed = new URL(page.url()).pathname;
    const redirected = landed !== path.split('?')[0];
    const shot = `/mnt/o/LUMEN-DOCS/lora-spec/shots/${label.replace(/[^a-z0-9]+/gi, '-')}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    rows.push({ label, path, landed, redirected, ...r });
    console.log(
      `${redirected ? '↪' : ' '} ${label.padEnd(20)} A=${r.A.n} B=${r.B.n} C=${r.C.n} D=${r.D.n} E=${r.E.n} F=${r.F.n} ${r.G ? 'H-SCROLL' : ''}`
    );
    if (r.A.n) console.log('     A:', r.A.eg.join(' | '));
    if (r.B.n) console.log('     B:', r.B.eg.join(' | '));
    if (r.C.n) console.log('     C:', r.C.eg.slice(0, 3).join(' | '));
    if (r.F.n) console.log('     F:', r.F.eg.slice(0, 3).join(' | '));
  } catch (e) {
    rows.push({ label, path, error: String(e).slice(0, 160) });
    console.log(`  ${label.padEnd(20)} ERROR ${String(e).slice(0, 90)}`);
  }
}

await browser.close();
fs.writeFileSync('/mnt/o/LUMEN-DOCS/lora-spec/qa-typography.json', JSON.stringify(rows, null, 1));

const sum = (k) => rows.reduce((a, r) => a + (r[k]?.n || 0), 0);
console.log('\n════ TOTALS across', rows.length, 'routes ════');
console.log('A non-Lora elements .......', sum('A'), '(expect 0)');
console.log('B weight > 700 ............', sum('B'), '(expect 0)');
console.log('C lowercase < 14px ........', sum('C'), '(expect 0)');
console.log('D small-caps ..............', sum('D'), '(expect 0)');
console.log('F clipped text nodes ......', sum('F'));
console.log('G routes scrolling sideways', rows.filter((r) => r.G).length);
console.log('errors ....................', rows.filter((r) => r.error).length);
