/**
 * PROOF that the NSFW gate actually holds at the SERVED OUTPUT.
 *
 * Not a typecheck and not a unit test: it drives the real production build over
 * HTTPS, on a page that genuinely contains NSFW-tagged mainnet posts, and
 * asserts on what the browser did — including whether the flagged image was
 * ever REQUESTED. A blurred-but-fetched image is still a fetched image.
 *
 *   node qa/harness/nsfw-gate-proof.mjs
 *
 * Exit 0 = gate holds. Exit 1 = it does not (or the fixture was empty, which is
 * also a failure: a check with nothing to inspect must never pass).
 */
import { chromium } from 'playwright';

const BASE = process.env.QA_BASE ?? 'https://localhost:3443';
const TOPIC = '/topics/nsfw';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

// Every image the page actually asks the network for.
const imageRequests = [];
page.on('request', (req) => {
  if (req.resourceType() === 'image') imageRequests.push(req.url());
});

await page.goto(`${BASE}${TOPIC}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
// The feed hydrates client-side; wait for cards rather than a fixed sleep.
await page
  .waitForSelector('[data-testid="medium-card-title"]', { timeout: 45000 })
  .catch(() => null);
await page.waitForTimeout(2500);

const cards = await page.locator('[data-testid="medium-card-title"]').count();
const notices = await page.locator('[data-testid="medium-card-nsfw-notice"]').count();
const hiddenThumbs = await page.locator('[data-testid="medium-card-nsfw-thumbnail-hidden"]').count();
const shownThumbs = await page.locator('[data-testid="medium-card-thumbnail"]').count();

console.log(
  `\n${TOPIC}: ${cards} cards · ${notices} NSFW notices · ${hiddenThumbs} gated thumbnails · ${shownThumbs} visible thumbnails\n`
);

// ── Rule 8 of _honesty.md: an empty fixture is a FAILURE, not a pass. ────────
check('fixture is non-empty (the page rendered post cards at all)', cards > 0, `${cards} cards`);
check(
  'the fixture actually contains NSFW-flagged posts to gate',
  notices > 0,
  `${notices} flagged`
);

// ── The gate itself ─────────────────────────────────────────────────────────
check(
  'every flagged card is gated (default preference is warn, so none may show its image)',
  notices > 0 && hiddenThumbs === notices,
  `${hiddenThumbs} gated of ${notices} flagged`
);
check(
  'no flagged card rendered a real thumbnail',
  shownThumbs === 0,
  `${shownThumbs} visible thumbnails on a page where every post is flagged`
);

// ── The part a blur would miss: was the picture ever fetched? ────────────────
const postImages = imageRequests.filter(
  (u) => !u.includes('/api/avatar') && !/\/_next\/|favicon|\.svg(\?|$)/.test(u)
);
check(
  'the flagged images were never REQUESTED (not merely hidden with CSS)',
  postImages.length === 0,
  postImages.length ? `fetched ${postImages.length}, e.g. ${postImages[0].slice(0, 90)}` : 'zero image requests'
);

// ── Mutation check: the gate must be the thing doing the work. ───────────────
// Reveal one card by hand; the image must appear only THEN. If it appears
// without this, the assertions above were passing for some unrelated reason.
let revealedOk = false;
if (notices > 0) {
  const toggle = page.locator('[data-testid="medium-card-nsfw-toggle"]').first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(2000);
    const afterShown = await page.locator('[data-testid="medium-card-thumbnail"]').count();
    revealedOk = afterShown > 0;
    check(
      'clicking "Show anyway" reveals the image (the gate is live, not a dead branch)',
      revealedOk,
      `${afterShown} thumbnail(s) after reveal`
    );
  } else {
    check('reveal control is present on a flagged card', false, 'no toggle found');
  }
}

// ── THE POST PAGE — where the card's link actually lands ────────────────────
// The card gate above was shipped first and did NOT reach here: measured on a
// flagged post, 21 <img> and 24 real image requests at every preference value,
// signed in or out. So the preference protected the reader right up until the
// click, which is the one moment it mattered. This half of the proof exists so
// that can never quietly come back.
const postPage = await context.newPage();
const postImageReqs = [];
postPage.on('request', (req) => {
  if (req.resourceType() === 'image') postImageReqs.push(req.url());
});
await postPage.goto(`${BASE}/hive-149888/@erotics/impressions-1`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await postPage.waitForTimeout(4000);

const gate = await postPage.locator('[data-testid="post-nsfw-gate"]').count();
// Selector note: this app does not wrap the body in <article>/.entry-body —
// an earlier version of this check used those and measured 0 both before AND
// after reveal, i.e. it would have passed for the wrong reason. Count real
// post images by their source instead.
const countBodyImgs = () =>
  postPage.locator('img[src*="images.hive.blog"]').count();
const bodyImgs = await countBodyImgs();
const realPostImgs = postImageReqs.filter(
  (u) => !u.includes('/api/avatar') && !/\/_next\/|favicon|\.svg(\?|$)/.test(u)
);

console.log(
  `\npost page: gate=${gate} bodyImages=${bodyImgs} imageRequests=${realPostImgs.length}\n`
);

check('post page shows the NSFW gate', gate > 0, `${gate} gate element(s)`);
check(
  'post page did not REQUEST the flagged images',
  realPostImgs.length === 0,
  realPostImgs.length ? `fetched ${realPostImgs.length}` : 'zero image requests'
);

// Mutation check: the body must appear only after the reader asks for it.
if (gate > 0) {
  await postPage.locator('[data-testid="post-nsfw-show"]').first().click();
  await postPage.waitForTimeout(3000);
  const afterImgs = await countBodyImgs();
  check(
    'post page reveals the body on "Show" (gate is live, not a dead branch)',
    afterImgs > 0,
    `${afterImgs} image(s) after reveal`
  );
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
