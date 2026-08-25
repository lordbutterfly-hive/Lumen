/**
 * VISUAL CAPTURE — every surface, three viewports, plus the interaction states
 * that only exist under a pointer.
 *
 * ★★★ THIS CAPTURES. IT DOES NOT BLESS. There are no baselines here and nothing
 * is compared. That separation is the whole point: regenerating a baseline is an
 * assertion that what is on screen is CORRECT, and after a day of large visual
 * changes nobody has established that yet. Bless after review, never before, or
 * the suite freezes today's bugs and reports them green forever.
 *
 * ★ FULL-PAGE, NOT VIEWPORT. A clipped element three screens down is exactly the
 * class of defect numeric probes miss and a viewport screenshot also misses.
 *
 * ★ THE HOVER STATES ARE CAPTURED SEPARATELY because they cannot be seen any
 * other way: the post card's drawer is `height: 0` until a 350ms dwell elapses,
 * and the identity pill's two halves only light under a real pointer. A static
 * crawl of the site would photograph none of it.
 *
 * Usage:  node qa-visual-capture.mjs            (all surfaces)
 *         node qa-visual-capture.mjs feed post  (only matching slugs)
 */
import { openApp, BASE } from './qa-harness.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openCardDrawer } from './qa/lib/open-drawer.mjs';

const OUT = process.env.VIS_OUT ?? '/tmp/lumen-visual';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 }
];

const POST = '/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy';
const SURFACES = [
  { slug: 'feed', path: '/' },
  { slug: 'feed-trending', path: '/trending' },
  { slug: 'topic', path: '/topics/photography' },
  { slug: 'post', path: POST },
  { slug: 'profile', path: '/@lordbutterfly' },
  { slug: 'profile-followers', path: '/@lordbutterfly/followers' },
  { slug: 'profile-feed', path: '/@lordbutterfly/feed' },
  { slug: 'search', path: '/search?q=hive' },
  { slug: 'creators', path: '/creators' },
  { slug: 'creators-launch', path: '/creators/launch' },
  { slug: 'creators-studio', path: '/creators/studio' },
  { slug: 'creator-token', path: '/creators/@magi.contracts' },
  { slug: 'wallet', path: '/wallet' },
  { slug: 'wallet-tokens', path: '/wallet/tokens' },
  { slug: 'witnesses', path: '/witnesses' },
  { slug: 'proposals', path: '/proposals' },
  { slug: 'ranks', path: '/ranks' },
  { slug: 'communities', path: '/communities' }
];

const only = process.argv.slice(2);
const wanted = only.length ? SURFACES.filter((s) => only.some((o) => s.slug.includes(o))) : SURFACES;

mkdirSync(OUT, { recursive: true });
const manifest = [];

for (const loggedIn of [true, false]) {
  const { browser, page } = await openApp({ loggedIn });
  const who = loggedIn ? 'in' : 'out';
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const s of wanted) {
      const file = `${OUT}/${s.slug}__${vp.name}__${who}.png`;
      try {
        await page.goto(BASE + s.path, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(4500);
        await page.evaluate(() => document.fonts.ready).catch(() => {});
        await page.screenshot({ path: file, fullPage: true });
        manifest.push({ file, surface: s.slug, path: s.path, viewport: vp.name, session: who });
        console.log(`  ok   ${s.slug} ${vp.name} ${who}`);
      } catch (e) {
        console.log(`  FAIL ${s.slug} ${vp.name} ${who}: ${String(e).split('\n')[0].slice(0, 90)}`);
        manifest.push({ file: null, surface: s.slug, path: s.path, viewport: vp.name, session: who, error: String(e).slice(0, 200) });
      }
    }
  }

  /* ── interaction states, desktop + signed-in only ────────────────────────── */
  if (loggedIn) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('[data-testid="medium-card"]', { timeout: 60000 });
    await page.waitForTimeout(3500);

    // The drawer, open. Needs a real pointer and a 350ms dwell, then the thread.
    const n = await page.locator('[data-testid="medium-card"]').count();
    for (let i = 0; i < Math.min(n, 8); i++) {
      const card = page.locator('[data-testid="medium-card"]').nth(i);
      const dl = card.locator('[data-testid="post-card-drawer"]');
      if ((await dl.count()) === 0) continue;
      await card.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -180));
      await page.mouse.move(4, 4);
      await page.waitForTimeout(400);
      const b = await card.boundingBox();
      if (!b) continue;
      /* ★ CLICK, NOT HOVER (2026-08-25): the drawer opens on an empty-space click;
         hovering does nothing. */
      await openCardDrawer(page, card);
      let open = false;
      for (let w = 0; w < 80; w++) {
        if ((await dl.evaluate((el) => el.getBoundingClientRect().height).catch(() => 0)) > 10) { open = true; break; }
        await page.waitForTimeout(100);
      }
      if (!open) continue;
      const file = `${OUT}/card-drawer-open__desktop__in.png`;
      await card.screenshot({ path: file });
      manifest.push({ file, surface: 'card-drawer-open', path: '/', viewport: 'desktop', session: 'in',
        note: 'One card with its top-comment drawer open (350ms dwell + thread fetch).' });
      console.log('  ok   card-drawer-open');
      break;
    }

    // The identity pill, at rest and with its profile half lit.
    const pill = page.locator('[data-testid="identity-pill"]').first();
    if (await pill.count()) {
      await page.mouse.move(4, 4);
      await page.waitForTimeout(350);
      await pill.screenshot({ path: `${OUT}/identity-pill-rest__desktop__in.png` });
      manifest.push({ file: `${OUT}/identity-pill-rest__desktop__in.png`, surface: 'identity-pill-rest',
        path: '/', viewport: 'desktop', session: 'in', note: 'N1 cluster at rest: 40px face, pill tucked 16px under it.' });
      await page.locator('[data-testid="identity-pill-profile"]').first().hover();
      await page.waitForTimeout(350);
      await pill.screenshot({ path: `${OUT}/identity-pill-hover__desktop__in.png` });
      manifest.push({ file: `${OUT}/identity-pill-hover__desktop__in.png`, surface: 'identity-pill-hover',
        path: '/', viewport: 'desktop', session: 'in', note: 'Profile half lit. The market half must NOT light with it.' });
      console.log('  ok   identity-pill rest + hover');
    }
  }
  await browser.close();
}

writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1));
const ok = manifest.filter((m) => m.file).length;
console.log(`\n  ${ok}/${manifest.length} captured -> ${OUT}`);
console.log('  NOTHING WAS BLESSED. Review before any baseline is written.');
