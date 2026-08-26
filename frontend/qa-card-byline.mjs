/**
 * THE CARD BYLINE ROW, MEASURED — tag left, rule under, pill right, no "···".
 *
 * One probe for the whole row because its three parts are not independent: the
 * menu's removal is what let the pill go flush, and the rubric shares a width
 * budget with both. Covers the feed, the profile POSTS tab and the profile
 * COMMENTS tab, which must agree with each other.
 *
 * Owner, 2026-08-26: *"remove the ... for now. they already exist on the post
 * page. remove for now. hide it. dont delete the code, just hide it."*
 *
 * Two claims, and a screenshot proves neither:
 *
 *   1. THE TRIGGER IS GONE. Counting it at zero is the easy half — but zero is
 *      also what a card that failed to render returns, so every count here is
 *      paired with a card count that must be non-zero first. A probe that can
 *      pass on an empty page is not a probe.
 *
 *   2. THE PILL IS NOW FLUSH. This is the part worth measuring. The menu was
 *      never only a menu: it occupied the right end of the byline row, so the
 *      identity pill stopped ~32px short of the header rule's right edge while
 *      the owner's reference draws it flush — and the profile COMMENT cards,
 *      which never had a menu, already WERE flush. Same component family, two
 *      different right edges, visible when switching tabs. Removing the trigger
 *      should close that gap on its own, because the pill's group carries
 *      `ml-auto` and the menu was the only thing after it.
 *      ★ "Should" is the reason this file exists. Asserted, not assumed.
 *
 * The rule element is found by SHAPE (an aria-hidden span, 1-2px tall, spanning
 * the card) rather than by class: CSS-module names are fully hashed in a
 * production build, so a class selector that works in dev silently matches
 * nothing here and every gap reads as 0 — a false pass.
 *
 * §3 re-checks the things the trigger's removal could plausibly have broken: the
 * card's click-to-open drawer (its guard list still names controls that no longer
 * exist), and the four in-byline links.
 */
import { openApp, BASE } from './qa-harness.mjs';
import { closeCardDrawer, openCardDrawer } from './qa/lib/open-drawer.mjs';

const { browser, page } = await openApp({ loggedIn: true });
let failures = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : '*** FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

/**
 * Byline geometry, anchored on THE PILL rather than on a card container.
 *
 * ★ The first version of this took a card selector and looked for the pill
 * inside it, which quietly measured NOTHING on the profile comments tab: that
 * card has no `data-testid` on its root, so the only selector available was the
 * pill's own — and `pill.querySelector('[data-testid="identity-pill"]')` finds
 * no descendant of itself. It returned an empty list, and the two assertions
 * that consumed it passed on `[].every(...)` === true. A vacuous pass, in a file
 * whose own header warns about vacuous passes. Anchoring on the pill removes the
 * need for any per-surface container selector at all.
 *
 * The rule is the byline row's next sibling, verified by SHAPE (aria-hidden,
 * 1-2px tall) so a production build's hashed CSS-module class cannot break it.
 */
const measure = () =>
  page.evaluate(() => {
    const out = [];
    for (const pill of document.querySelectorAll('[data-testid="identity-pill"]')) {
      const row = pill.closest('div');
      const rule = row && row.nextElementSibling;
      if (!rule || rule.tagName !== 'SPAN' || rule.getAttribute('aria-hidden') !== 'true') continue;
      const rr = rule.getBoundingClientRect();
      if (!(rr.height > 0 && rr.height <= 2)) continue;
      const pr = pill.getBoundingClientRect();
      const rubric = row.querySelector('[data-testid$="rubric"]');
      out.push({
        pillRight: Math.round(pr.right),
        ruleRight: Math.round(rr.right),
        gap: Math.round(rr.right - pr.right),
        rubric: rubric ? (rubric.textContent || '').trim() : null,
        rubricHref: rubric ? rubric.getAttribute('href') : null
      });
    }
    return out;
  });

const summarise = (rows) => {
  const gaps = [...new Set(rows.map((r) => r.gap))].sort((a, b) => a - b);
  const withRubric = rows.filter((r) => r.rubric);
  return {
    n: rows.length,
    gaps,
    pillRights: [...new Set(rows.map((r) => r.pillRight))].sort((a, b) => a - b),
    rubrics: withRubric.length,
    // A raw community id reaching the reader is the one thing the shape test exists to stop.
    rawIds: withRubric.filter((r) => /^hive-\d+$/i.test(r.rubric)).map((r) => r.rubric),
    // The label is capitalized for the reader; the href must NOT be.
    badHrefs: withRubric.filter((r) => r.rubricHref && /[A-Z]/.test(r.rubricHref)).map((r) => r.rubricHref),
    samples: withRubric.slice(0, 6).map((r) => `${r.rubric} -> ${r.rubricHref}`)
  };
};

/* ── §1 the feed ─────────────────────────────────────────────────────────── */
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card-title"]', { timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => document.fonts.ready);

const feedCards = await page.locator('[data-testid="medium-card"]').count();
ok('§1 feed rendered cards (non-zero, or the counts below are meaningless)', feedCards > 0, `${feedCards} cards`);

const feedTriggers = await page.locator('[data-testid="medium-card-overflow-trigger"]').count();
ok('§1 "···" triggers on the feed', feedTriggers === 0, `${feedTriggers} found`);

const feedByLabel = await page.locator('[data-testid="medium-card"] [aria-label^="More options"]').count();
ok('§1 anything still labelled "More options" inside a card', feedByLabel === 0, `${feedByLabel} found`);

const feedGeom = summarise(await measure());
ok('§1 feed cards measured', feedGeom.n > 0, `${feedGeom.n} of ${feedCards} had both a pill and a rule`);
ok(
  '§1 feed pill is FLUSH with the header rule',
  feedGeom.n > 0 && feedGeom.gaps.length > 0 && feedGeom.gaps.every((g) => Math.abs(g) <= 1),
  `gaps ${JSON.stringify(feedGeom.gaps)}px (was ~32 with the menu)`
);

/* ── §2 the profile, both tabs — the mismatch this was supposed to close ──── */
const geomFor = async (path, sel, label) => {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector(sel, { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(2500);
  const g = summarise(await measure());
  ok(`§2 ${label} measured`, g.n > 0, `${g.n} cards`);
  return g;
};

const postsGeom = await geomFor('/@gtg', '[data-testid="medium-card"]', 'profile POSTS tab');
ok(
  '§2 profile posts tab: no "···", pill flush',
  postsGeom.n > 0 &&
    (await page.locator('[data-testid="medium-card-overflow-trigger"]').count()) === 0 &&
    postsGeom.gaps.every((g) => Math.abs(g) <= 1),
  `${postsGeom.n} cards, gaps ${JSON.stringify(postsGeom.gaps)}px`
);

/* ★ WAIT FOR THE TAB TO ACTUALLY SWAP, not merely for a pill to exist — the
   POSTS tab has pills too, so `waitForSelector('[data-testid="identity-pill"]')`
   is satisfied by the page we are navigating AWAY from and would measure the
   posts tab a second time under the comments tab's name. The discriminator is
   that comment cards are not `medium-card`s: zero medium-cards with pills
   present is the comments tab and nothing else. */
await page.goto(BASE + '/@gtg?tab=comments', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page
  .waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="medium-card"]').length === 0 &&
      document.querySelectorAll('[data-testid="identity-pill"]').length > 0,
    { timeout: 60000 }
  )
  .catch(() => null);
await page.waitForTimeout(2500);
const commentsGeom = summarise(await measure());
ok('§2 profile COMMENTS tab measured', commentsGeom.n > 0, `${commentsGeom.n} cards`);
/* ★ `n > 0` FIRST, EVERY TIME. `[].every(...)` is `true`, so a surface that
   rendered nothing would report "flush" and "they agree" — the two headline
   claims of this file — without a single pixel having been measured. */
ok(
  '§2 comments tab pill flush (it always was — the control)',
  commentsGeom.n > 0 && commentsGeom.gaps.every((g) => Math.abs(g) <= 1),
  `${commentsGeom.n} cards, gaps ${JSON.stringify(commentsGeom.gaps)}px`
);
ok(
  '§2 FEED AND COMMENTS NOW AGREE (the 32px tab-switch jump)',
  feedGeom.n > 0 &&
    commentsGeom.n > 0 &&
    feedGeom.gaps.every((g) => Math.abs(g) <= 1) &&
    commentsGeom.gaps.every((g) => Math.abs(g) <= 1),
  `feed ${feedGeom.n} cards ${JSON.stringify(feedGeom.gaps)} vs comments ${commentsGeom.n} cards ${JSON.stringify(commentsGeom.gaps)}`
);

/* ── §3 nothing the trigger's removal could have broken ──────────────────── */
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('[data-testid="medium-card-title"]', { timeout: 60000 });
await page.waitForTimeout(2500);

const card = page.locator('[data-testid="medium-card"]').nth(1);
await card.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);

// Hover must still do nothing.
const box = await card.boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
await page.waitForTimeout(1100);
const afterHover = await card.locator('[data-testid="post-card-drawer"]').getAttribute('data-open').catch(() => null);
ok('§3 hover 1100ms leaves the drawer shut', afterHover !== 'true', `data-open=${afterHover}`);

// Empty-space click must still open it.
const opened = await openCardDrawer(page, card);
ok('§3 empty-space click still opens the drawer', opened === true, `opened=${opened}`);
if (opened) await closeCardDrawer(page, card);

// The byline's links must all still resolve.
const links = await card.evaluate((el) => {
  const grab = (sel) => {
    const n = el.querySelector(sel);
    return n ? n.getAttribute('href') || n.closest('a')?.getAttribute('href') || null : null;
  };
  return {
    title: grab('[data-testid="medium-card-title"]'),
    rubric: grab('[data-testid="medium-card-rubric"]'),
    pill: grab('[data-testid="identity-pill-profile"]')
  };
});
ok('§3 title still links', !!links.title, links.title || '(none)');
ok('§3 pill still links', !!links.pill, links.pill || '(none)');
console.log(`      rubric href .......... ${links.rubric || '(no community on this card)'}`);

/* ── §4 the rubric fallback ──────────────────────────────────────────────────
   Owner, 2026-08-26. The comment card printed a rubric ONLY when the post had a
   community, so a reply under a community-less post left an EMPTY styled slot —
   5 of @gtg's 20 most recent comments. Both cards now share `getPostRubric`.
   ★ The claim is "every slot fills", so the assertion is n-of-n, never "more
   than before": a count that merely went up is satisfied by a partial fix. */
console.log('');
console.log(`§4 feed rubrics ....... ${feedGeom.rubrics}/${feedGeom.n}   e.g. ${feedGeom.samples.slice(0, 3).join(' | ')}`);
console.log(`§4 comment rubrics .... ${commentsGeom.rubrics}/${commentsGeom.n}   e.g. ${commentsGeom.samples.slice(0, 3).join(' | ')}`);
ok(
  '§4 EVERY comment card now carries a rubric (was 15/20)',
  commentsGeom.n > 0 && commentsGeom.rubrics === commentsGeom.n,
  `${commentsGeom.rubrics}/${commentsGeom.n}`
);
ok(
  '§4 no raw community id printed as a tag (the hive-\\d+ shape guard)',
  feedGeom.rawIds.length === 0 && commentsGeom.rawIds.length === 0 && postsGeom.rawIds.length === 0,
  `feed ${JSON.stringify(feedGeom.rawIds)} posts ${JSON.stringify(postsGeom.rawIds)} comments ${JSON.stringify(commentsGeom.rawIds)}`
);
ok(
  '§4 rubric hrefs stay lowercase (label is capitalized, the URL is not)',
  feedGeom.badHrefs.length === 0 && commentsGeom.badHrefs.length === 0 && postsGeom.badHrefs.length === 0,
  `feed ${JSON.stringify(feedGeom.badHrefs)} comments ${JSON.stringify(commentsGeom.badHrefs)}`
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `*** ${failures} FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
