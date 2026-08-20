/**
 * §9's SILENT FAILURE, PROVED FIXED: jumping to a comment that is NOT on page 1.
 *
 * The sibling probe (`qa-comment-jump.mjs`) walks the real feed, and the feed's
 * threads are small — the busiest post on trending had 15 comments the day this
 * was written. So that probe only ever exercises page 1, and page 1 is exactly
 * the case that works WITHOUT the fix. Passing it proves nothing about the
 * blocker §9 actually names:
 *
 *   "On a thread with 183 comments, confirm whether the target comment is in the
 *    DOM at click time or whether the list is paginated or virtualised. If it
 *    is, resolve and render the correct page BEFORE the jump, or the anchor does
 *    not exist and the jump silently fails."
 *
 * It IS paginated. So this probe goes looking for a genuinely busy thread on
 * chain, picks the LAST main comment in it — the one furthest from page 1 —
 * and lands on it cold, straight from the URL.
 *
 * ★ IT SKIPS LOUDLY RATHER THAN PASSING QUIETLY. If no thread with enough
 * comments can be found, that is a probe that tested nothing, and it says so and
 * exits non-zero rather than reporting a green it did not earn.
 */
import { openApp, BASE, report } from './qa-harness.mjs';

const MIN_COMMENTS = 60; // comfortably past the 50-per-page cap
const rows = {};
let fails = 0;
const checkTrue = (label, ok, detail = '') => {
  if (!ok) fails++;
  rows[label] = `${ok ? 'PASS' : 'FAIL'}  ${detail}`;
};

// ── find a busy thread ──────────────────────────────────────────────────────
const api = async (method, params) => {
  const r = await fetch('https://api.hive.blog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
  });
  return (await r.json()).result;
};
let busy = null;
for (const tag of ['', 'hive-125125', 'hive-140217', 'hive-167922']) {
  const posts = (await api('bridge.get_ranked_posts', { sort: 'trending', limit: 20, tag })) || [];
  for (const p of posts) if ((p.children || 0) >= MIN_COMMENTS) { busy = p; break; }
  if (busy) break;
}
if (!busy) {
  console.log(`SKIP-FAIL: no thread with >=${MIN_COMMENTS} comments found on chain right now.`);
  console.log('This probe tested NOTHING. Do not read its silence as a pass.');
  process.exit(1);
}
const postHref = `/${busy.category}/@${busy.author}/${busy.permlink}`;
rows['thread'] = `${postHref} (${busy.children} comments)`;

const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1400, height: 1000 });

// ── pick the LAST main comment: furthest from page 1 ────────────────────────
await page.goto(BASE + postHref, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(4000);
const target = await page.evaluate(async ([author, permlink]) => {
  const res = await fetch(`/api/discussion?author=${encodeURIComponent(author)}&permlink=${encodeURIComponent(permlink)}`);
  const j = await res.json();
  const d = j.discussion || j;
  const root = `${author}/${permlink}`;
  const mains = Object.entries(d).filter(
    ([k, e]) => k !== root && e && e.parent_author === author && e.parent_permlink === permlink
  );
  if (!mains.length) return null;
  const last = mains[mains.length - 1];
  return { key: last[0], total: Object.keys(d).length, mains: mains.length };
}, [busy.author, busy.permlink]);

if (!target) {
  console.log('SKIP-FAIL: could not read the thread through /api/discussion. Tested nothing.');
  await browser.close();
  process.exit(1);
}
rows['main comments'] = `${target.mains} (of ${target.total} total nodes)`;
rows['target comment'] = target.key;
checkTrue('the thread really is multi-page', target.mains > 50, `${target.mains} main comments vs 50/page`);

/* ★ PROVE THE TARGET IS ACTUALLY OFF PAGE 1, or this probe is just the sibling
   one again with extra steps. Load the post with NO fragment — that is page 1 by
   definition — and confirm the anchor is absent. If it were present, everything
   below would pass without the page-resolution code ever running. */
await page.goto(BASE + postHref, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(6000);
const onPageOne = await page.evaluate((k) => !!document.getElementById('@' + k), target.key);
checkTrue('the target is NOT on page 1 (so resolution is required)', !onPageOne,
  onPageOne ? 'it IS on page 1 — this run proves nothing' : 'absent from page 1, as needed');

/* ── land on it COLD, straight from the URL ─────────────────────────────────
   ★ THE `goto` HOME FIRST IS LOAD-BEARING, and leaving it out cost an hour.
   The step above is already ON `postHref`; going to `postHref#fragment` from
   there differs only in the hash, which the browser treats as a SAME-DOCUMENT
   navigation. Nothing remounts, the arrival effect never re-runs, and the probe
   reports "anchor missing — page never resolved" against code that resolves it
   correctly on a real load. Bouncing through another route forces the real
   thing: a cold load at the fragment, which is what a shared link does. */
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(500);
await page.goto(`${BASE}${postHref}#@${target.key}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(7000); // page resolution + render + the re-pin window

const landing = await page.evaluate((key) => {
  const el = document.getElementById('@' + key);
  const active = [...document.querySelectorAll('button')]
    .filter((b) => /^\d+$/.test(b.textContent.trim()))
    .map((b) => ({ n: b.textContent.trim(), on: b.getAttribute('aria-current') || b.className }));
  return {
    exists: !!el,
    top: el ? Math.round(el.getBoundingClientRect().top) : null,
    scrollY: Math.round(window.scrollY),
    rendered: document.querySelectorAll('[data-testid="comment-list-item"]').length,
    pagerButtons: active.map((a) => a.n).join(',')
  };
}, target.key);

rows['comments rendered'] = String(landing.rendered);
rows['pager pages'] = landing.pagerButtons || 'none';
checkTrue('§9 the off-page comment is IN THE DOM after arrival', landing.exists, landing.exists ? '' : 'anchor missing — page never resolved');
if (landing.exists) {
  checkTrue('§9 landed on it', landing.top > -80 && landing.top < 500, `rect.top ${landing.top}px`);
  checkTrue('§9 headroom above it', landing.top > 24, `rect.top ${landing.top}px`);
}
checkTrue('§9 did not sit at the top of the post', landing.scrollY > 200, `scrollY ${landing.scrollY}px`);

report('§9 JUMP TO AN OFF-PAGE COMMENT', rows);
console.log(`\n  ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
