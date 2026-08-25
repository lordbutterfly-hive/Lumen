/**
 * DOES SIGNING OUT REALLY CLEAR THE POST CARD'S TOP-COMMENT PICKS?
 *
 * `lib/top-comment.ts` caches, per post per session, which comment the card opens
 * onto. Its header always said the cache must be cleared on logout; until
 * 2026-08-19 `resetTopCommentPicks()` had zero callers.
 *
 * ★★★ WHY THE OBVIOUS TEST IS WORTHLESS, AND THIS ONE IS NOT.
 *
 * A first version engaged some cards, signed out, and re-hovered the SAME cards.
 * It reported 10 of 10 picks unchanged — which looks like a failed reset and is
 * actually a test that could never have passed. Two reasons, both measured:
 *
 *   1. `medium-post-card.tsx:143` — `engaged` "flips once and never back". Hovering
 *      an already-engaged card changes no state, so the card does not re-render and
 *      the drawer keeps the comment it computed the first time. The pick could have
 *      been cleared a dozen times over and the pixels would not move.
 *   2. The pick is only RANDOM where comments tie on direct replies. On a thread
 *      with one clear winner the rule is deterministic and returns the same comment
 *      forever, reset or not — so those cards carry no information at all.
 *
 * So this version (a) forces a real REMOUNT with client-side navigation, which is
 * what makes a fresh pick observable, (b) proves no page RELOAD happened — a reload
 * would clear the module-level Map for free and the test would pass with the wire
 * ripped out — and (c) reports how many of the compared posts can actually re-roll,
 * so the result is never read as stronger than the evidence.
 *
 * It also runs the same remount WITHOUT signing out first, as a control: if the
 * cache does not survive an ordinary remount, nothing after it means anything.
 */
import { openApp, BASE } from './qa-harness.mjs';
import { openCardDrawer } from './qa/lib/open-drawer.mjs';

const { browser, page } = await openApp({ loggedIn: true });
const HOME = '/';
// Whatever link the feed actually has. `/communities` is not linked from the home
// feed, so the round trip used a locator that never resolved.

/** Stamp the window so a page RELOAD becomes detectable. */
const stamp = () => page.evaluate(() => { window.__qaModuleMarker = (window.__qaModuleMarker || 0) + 1; return window.__qaModuleMarker; });
const marker = () => page.evaluate(() => window.__qaModuleMarker ?? 0);

/** Client-side navigation only — never `page.goto`, which reloads and clears the module. */
async function softRoundTrip() {
  // A post permalink is the one Next <Link> guaranteed to be on this page.
  const link = page.locator('article a[href]').filter({ hasNotText: '@' }).first();
  const href = await page.evaluate(() =>
    [...document.querySelectorAll('article a[href]')].map((x) => x.getAttribute('href'))
      .find((h) => /^\/[^/]+\/@[^/]+\/[^/?#]+$/.test(h || '')) || null);
  if (!href) throw new Error('no permalink link on the page to navigate with');
  await page.locator(`a[href="${href}"]`).first().click({ timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.goBack();                 // App Router handles popstate client-side
  await page.waitForTimeout(4000);
}

async function readPicks() {
  const cards = page.locator('article');
  const n = Math.min(await cards.count(), 12);
  const picks = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    try {
      await card.scrollIntoViewIfNeeded({ timeout: 5000 });
      /* ★ CLICK, NOT HOVER (2026-08-25) — hovering no longer opens the drawer.
         `engage()` still warms on pointer entry, so hover first, then click. */
      await card.hover({ timeout: 5000 });
      await openCardDrawer(page, card);
    } catch { continue; }
    await page.waitForTimeout(700);
    const p = await page.evaluate((idx) => {
      const c = document.querySelectorAll('article')[idx];
      if (!c) return null;
      const d = c.querySelector('[data-testid="post-card-drawer"]');
      if (!d || d.getBoundingClientRect().height < 10) return null;
      const permalink = [...c.querySelectorAll('a[href]')].map((x) => x.getAttribute('href'))
        .find((h) => /^\/[^/]+\/@[^/]+\/[^/?#]+$/.test(h || '')) || `card${idx}`;
      const author = d.querySelector('a[href^="/@"]')?.getAttribute('href') || '';
      // ★ THE META LINE IS EXCLUDED, AND A RUN THAT COUNTED IT OVERSTATED THE RESULT.
      // The drawer renders `<TimeAgo>` — a RELATIVE timestamp — next to the author.
      // Hashing the whole drawer text made "59 minutes ago" -> "1 hour ago" look like
      // a different comment, and a previous run reported 4 re-rolls of which 3 were
      // that drift on posts whose pick is deterministic (tie = 1). Comparing the
      // comment BODY with the meta line removed identifies the comment itself.
      const meta = d.querySelector('[class*="commentMeta"]');
      const whole = (d.textContent || '').trim();
      const metaText = meta ? (meta.textContent || '').trim() : '';
      const body = (metaText && whole.startsWith(metaText) ? whole.slice(metaText.length) : whole).trim().slice(0, 70);
      return { permalink, author, body };
    }, i);
    if (p) picks.push(p);
    await page.mouse.move(3, 3);
    await page.waitForTimeout(120);
  }
  return picks;
}

/**
 * How many of these posts CAN re-roll (only ties are random), AND a signature of
 * each thread's exact comment set.
 *
 * ★ THE SIGNATURE IS NOT DECORATION. A first real-Chrome run came back INVALID
 * because a pick changed during the CONTROL phase, where nothing should change.
 * The cause was not the cache: this runs against a LIVE feed for several minutes,
 * new comments arrive mid-run, and a thread that gains a comment legitimately
 * re-resolves to a different one. Any post whose comment set moved between phases
 * is therefore not evidence about the cache in either direction, and is dropped.
 */
async function threadState(permalinks) {
  return page.evaluate(async (hrefs) => {
    const out = {};
    for (const href of hrefs) {
      const m = href.match(/\/@([^/]+)\/([^/?#]+)/);
      if (!m) continue;
      const [, author, permlink] = m;
      try {
        const payload = await (await fetch(`/api/discussion?author=${encodeURIComponent(author)}&permlink=${encodeURIComponent(permlink)}`)).json();
        const disc = payload?.discussion ?? payload ?? {};
        const rootKey = `${author}/${permlink}`;
        const counts = new Map();
        for (const e of Object.values(disc)) {
          if (!e?.parent_author || !e?.parent_permlink) continue;
          const k = `${e.parent_author}/${e.parent_permlink}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const comments = Object.keys(disc).filter((k) => k !== rootKey);
        if (!comments.length) { out[href] = { tie: 0, sig: '' }; continue; }
        const max = Math.max(...comments.map((k) => counts.get(k) ?? 0));
        out[href] = {
          tie: comments.filter((k) => (counts.get(k) ?? 0) === max).length,
          sig: comments.sort().join('|')
        };
      } catch { out[href] = { tie: 0, sig: 'ERROR' }; }
    }
    return out;
  }, permalinks);
}

const compare = (a, b) => {
  const byKey = new Map(a.map((p) => [p.permalink, p]));
  const rows = [];
  for (const y of b) {
    const x = byKey.get(y.permalink);
    if (!x) continue;
    rows.push({
      permalink: y.permalink,
      from: x.author, to: y.author,
      fromBody: x.body, toBody: y.body,
      // ★ TWO STRENGTHS OF EVIDENCE, REPORTED SEPARATELY. A changed AUTHOR is an
      // unambiguous re-roll. A changed body with the same author can also be one
      // (two comments by the same person), but it can equally be the same comment
      // re-rendered — so it is counted apart and never used to carry the verdict.
      authorChanged: x.author !== y.author,
      changed: x.author !== y.author || x.body !== y.body
    });
  }
  return rows;
};

await page.goto(BASE + HOME, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(4000);
await stamp();

const first = await readPicks();
console.log(`picks recorded, signed in ................ ${first.length}`);

const before = await threadState(first.map((p) => p.permalink));
const ties = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.tie]));
const canReroll = first.filter((p) => (ties[p.permalink] ?? 0) > 1);
console.log(`of those, posts whose pick is RANDOM ..... ${canReroll.length}   (ties: ${canReroll.map((p) => ties[p.permalink]).join(', ') || 'none'})`);
if (canReroll.length === 0) {
  console.log('\nABORT: every pick on this feed is deterministic, so nothing here can show a re-roll.');
  await browser.close();
  process.exit(2);
}
const odds = canReroll.reduce((a, p) => a / ties[p.permalink], 1);
console.log(`chance they all repeat by luck ........... ${odds.toExponential(2)}`);

// ── CONTROL: remount WITHOUT signing out. The cache must survive this. ──────
await softRoundTrip();
console.log(`\nCONTROL — remounted without signing out`);
console.log(`  page reloaded? .......................... ${(await marker()) === 1 ? 'no (module intact)' : 'YES — test invalid'}`);
const controlPicks = await readPicks();
const midState = await threadState(controlPicks.map((p) => p.permalink));
const controlAll = compare(first, controlPicks);
const drifted1 = controlAll.filter((r) => midState[r.permalink] && before[r.permalink] && midState[r.permalink].sig !== before[r.permalink].sig);
const control = controlAll.filter((r) => !drifted1.some((d) => d.permalink === r.permalink));
const controlChanged = control.filter((r) => r.changed).length;
console.log(`  cards compared .......................... ${controlAll.length}`);
console.log(`  dropped: thread gained/lost a comment ... ${drifted1.length}`);
console.log(`  picks that changed ...................... ${controlChanged} of ${control.length}   (expect 0 — the cache holds)`);

// ── sign out in place ───────────────────────────────────────────────────────
await page.locator('[data-testid="profile-avatar-button"]').first().click({ timeout: 20000 });
await page.waitForTimeout(700);
const logout = page.locator('[data-testid="user-profile-menu-logout-link"]');
if (!(await logout.count())) { console.log('\nABORT: logout control not reachable.'); await browser.close(); process.exit(2); }
await logout.click();
await page.waitForTimeout(3500);
console.log(`\nsigned out ............................... ${(await page.locator('[data-testid="profile-avatar-button"]').count()) === 0 ? 'yes' : 'NO'}`);
console.log(`page reloaded during logout? ............. ${(await marker()) === 1 ? 'no (module intact)' : 'YES — test invalid'}`);

// ── TEST: the same remount, now after a sign-out ────────────────────────────
await softRoundTrip();
console.log(`page reloaded during remount? ............ ${(await marker()) === 1 ? 'no (module intact)' : 'YES — test invalid'}`);
const afterPicks = await readPicks();
const endState = await threadState(afterPicks.map((p) => p.permalink));
const afterAll = compare(first, afterPicks);
const drifted2 = afterAll.filter((r) => endState[r.permalink] && before[r.permalink] && endState[r.permalink].sig !== before[r.permalink].sig);
const after = afterAll.filter((r) => !drifted2.some((d) => d.permalink === r.permalink));
console.log(`  dropped: thread gained/lost a comment ... ${drifted2.length}`);
const changed = after.filter((r) => r.changed);
const comparableRandom = after.filter((r) => (ties[r.permalink] ?? 0) > 1);
console.log(`\ncards compared across the sign-out ....... ${after.length}`);
console.log(`  of those, able to re-roll ............... ${comparableRandom.length}`);
console.log(`  picks that RE-ROLLED ................... ${changed.length}`);
const authorChanged = after.filter((r) => r.authorChanged);
console.log(`  of those, with a CHANGED AUTHOR ........ ${authorChanged.length}   <- the unambiguous ones`);
for (const r of after.slice(0, 12)) {
  const tag = r.authorChanged ? 'RE-ROLLED' : r.changed ? 'body-only' : 'same     ';
  console.log(`   ${tag} tie=${String(ties[r.permalink] ?? 0).padStart(2)}  ${r.from} -> ${r.to}`);
  if (r.changed && !r.authorChanged) {
    console.log(`      before: "${r.fromBody}"`);
    console.log(`      after : "${r.toBody}"`);
  }
}

console.log('');
if ((await marker()) !== 1) {
  console.log('VERDICT: INVALID — the page reloaded, which clears the cache for free.');
  process.exitCode = 2;
} else if (controlChanged > 0) {
  console.log('VERDICT: INVALID — the cache did not even survive the control remount.');
  process.exitCode = 2;
} else if (comparableRandom.length === 0) {
  console.log('VERDICT: INCONCLUSIVE — no post that survived the run could re-roll at all.');
  process.exitCode = 2;
} else if (authorChanged.length > 0) {
  console.log(`VERDICT: PROVEN. The cache survived a remount while signed in (${control.length}/${control.length} identical)`);
  console.log(`         and after signing out ${authorChanged.length} pick(s) resolved to a DIFFERENT COMMENT AUTHOR,`);
  console.log(`         with no page reload and no thread drift in between.`);
  if (changed.length > authorChanged.length)
    console.log(`         (${changed.length - authorChanged.length} further row(s) differed only in body text and are NOT counted.)`);
} else {
  console.log('VERDICT: NOT PROVEN — nothing re-rolled after the sign-out.');
  process.exitCode = 1;
}
await browser.close();
