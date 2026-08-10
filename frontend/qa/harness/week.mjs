/**
 * A week in the life of one Lumen reader.
 *
 * This harness exists because every previous QA pass sampled the product in
 * slices — one charter, one screen, one minute. Nobody has ever lived in it: made
 * an account, said what they like, come back day after day, voted on things, and
 * watched whether the feed noticed. That is the only way to see whether the
 * ranking engine does anything at all for a real person, and it is the one thing
 * the product is actually for.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MATTERS MOST
 *
 * **An empty feed is a STOP, never a shrug.**
 *
 * Prior rounds repeatedly walked past a feed showing nothing and carried on
 * testing whatever was next — which is how a structurally empty signed-out feed
 * survived for a long time. `assertPopulated()` THROWS. If a feed that should
 * have posts has none, the run halts, dumps the page text, the network log and a
 * screenshot, and the day is recorded as a failure. Do not catch it and continue.
 * ─────────────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import { openApp, BASE } from '/home/clauderfly/hive-blog-rebuild/qa-harness.mjs';

export const OUT = '/tmp/week';
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything the run learns, written to disk so a crash never loses the week.
 *
 * ★ BUG FOUND AND FIXED MID-WEEK (day 3): each day runs as its OWN `node`
 * process (per the runbook: `node week-run.mjs <day>`), and this used to hold
 * the journal in a module-level `{ days: [], failures: [] }` initialized fresh
 * on every import — then `writeFileSync` the WHOLE in-memory object on every
 * `record()` call. That doesn't append to the file; it REPLACES it. Every
 * day's run silently discarded every previous day's journal entries, and only
 * the most recent day ever survived on disk. Days 1 and 2 had to be
 * reconstructed from this conversation's own earlier reads of their output
 * before this fix landed. Now `record`/`recordFailure` load the CURRENT file
 * from disk, append to it, and save — so multiple process invocations
 * accumulate correctly, which is the entire point of a week-long journal.
 */
function loadJournalFile() {
  const p = path.join(OUT, 'journal.json');
  if (!fs.existsSync(p)) return { days: [], failures: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { days: [], failures: [] };
  }
}
export function record(entry) {
  const journal = loadJournalFile();
  journal.days.push(entry);
  fs.writeFileSync(path.join(OUT, 'journal.json'), JSON.stringify(journal, null, 2));
}
export function recordFailure(f) {
  const journal = loadJournalFile();
  journal.failures = journal.failures || [];
  journal.failures.push(f);
  fs.writeFileSync(path.join(OUT, 'journal.json'), JSON.stringify(journal, null, 2));
}

/**
 * Open a session as our reader. `dayLabel` only tags artefacts — the account is
 * the same person every day, which is the entire point.
 */
export async function session(privateKey, dayLabel) {
  const { browser, page, username } = await openApp({ loggedIn: true, privateKey });
  const net = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) net.push(`${r.status()} ${u.replace(BASE, '')}`);
  });
  page.on('pageerror', (e) => net.push(`PAGEERROR ${String(e.message).slice(0, 120)}`));
  return { browser, page, username, net, dayLabel };
}

/** The interest picker blocks the page until answered. Deal with it like a person. */
export async function handleInterestPicker(page, picks = []) {
  const dialog = page.locator('[role="dialog"]');
  if ((await dialog.count()) === 0) return { appeared: false, picked: [] };
  const chosen = [];
  for (const want of picks) {
    const pill = page.getByRole('button', { name: new RegExp(want, 'i') }).first();
    if (await pill.count()) {
      await pill.click().catch(() => {});
      chosen.push(want);
      await sleep(250);
    }
  }
  const go = page.getByRole('button', { name: /continue with|skip for now/i }).first();
  if (await go.count()) await go.click().catch(() => {});
  await sleep(3500);
  return { appeared: true, picked: chosen };
}

/**
 * ★ A feed with nothing in it halts the run.
 *
 * `why` should say what the reader was doing, so the failure reads as a story
 * rather than an assertion id.
 */
export async function assertPopulated(page, why, { min = 1 } = {}) {
  const count = await page.locator('[data-testid="medium-card-title"]').count();
  if (count >= min) return count;

  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const shot = path.join(OUT, `EMPTY-${why.replace(/[^a-z0-9]+/gi, '-')}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const detail = {
    why,
    url: page.url(),
    postsFound: count,
    expectedAtLeast: min,
    pageText: body.slice(0, 600),
    screenshot: shot
  };
  recordFailure(detail);
  throw new Error(`EMPTY FEED — ${why}\n${JSON.stringify(detail, null, 2)}`);
}

/** What the feed actually served: who, what tags, in what order. */
export async function snapshotFeed(page, label) {
  const posts = await page.locator('article').evaluateAll((els) =>
    els.slice(0, 40).map((e) => {
      const a = e.querySelector('[data-testid="medium-card-title"]');
      const href = a?.getAttribute('href') || '';
      const m = href.match(/^\/([^/]+)\/@([^/]+)\/(.+)$/);
      return {
        category: m?.[1] || '',
        author: m?.[2] || '',
        permlink: m?.[3] || '',
        title: (a?.textContent || '').trim().slice(0, 70)
      };
    })
  );
  const snap = { label, at: new Date().toISOString(), count: posts.length, posts };
  fs.writeFileSync(path.join(OUT, `feed-${label}.json`), JSON.stringify(snap, null, 2));
  log(`   feed[${label}]: ${posts.length} posts, ${new Set(posts.map((p) => p.author)).size} distinct authors`);
  return snap;
}

/** How much did today's feed differ from an earlier day's? */
export function compareFeeds(a, b) {
  const ka = new Set(a.posts.map((p) => `${p.author}/${p.permlink}`));
  const kb = new Set(b.posts.map((p) => `${p.author}/${p.permlink}`));
  const shared = [...kb].filter((k) => ka.has(k)).length;
  const catsA = new Set(a.posts.map((p) => p.category).filter(Boolean));
  const catsB = new Set(b.posts.map((p) => p.category).filter(Boolean));
  return {
    overlapPosts: shared,
    overlapPct: kb.size ? Math.round((shared / kb.size) * 100) : 0,
    newPosts: kb.size - shared,
    categoriesBefore: [...catsA],
    categoriesAfter: [...catsB],
    categoriesGained: [...catsB].filter((c) => !catsA.has(c))
  };
}

/** Read a post properly: open it, look at it, come back. */
export async function readPost(page, index = 0) {
  const titles = page.locator('[data-testid="medium-card-title"]');
  if ((await titles.count()) <= index) return null;
  const href = await titles.nth(index).getAttribute('href');
  await titles.nth(index).click({ timeout: 20000 }).catch(() => {});
  await sleep(4000);
  const opened = page.url().includes((href || '').split('/').pop() || 'x');
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  await page.goBack({ waitUntil: 'networkidle' }).catch(() => {});
  await sleep(3000);
  return { href, opened, chars: text.length };
}

/** Upvote whatever is at `index`, and say whether the number actually moved. */
export async function votePost(page, index = 0) {
  const cards = page.locator('article');
  if ((await cards.count()) <= index) return null;
  const card = cards.nth(index);
  const countBefore = (await card.innerText().catch(() => '')).match(/(\d[\d,]*)\s*votes?/i)?.[1] ?? null;
  const btn = card.locator('[data-testid="upvote-button"]').first();
  if ((await btn.count()) === 0) return { voted: false, reason: 'no upvote control' };
  await btn.click({ timeout: 20000 }).catch(() => {});
  await sleep(3500);
  const countAfter = (await card.innerText().catch(() => '')).match(/(\d[\d,]*)\s*votes?/i)?.[1] ?? null;
  return { voted: true, countBefore, countAfter, moved: countBefore !== countAfter };
}

export async function goHome(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(6000);
}

/** Following tab lives at ?tab=feed on the same page (feed-tabs.tsx). */
export async function goToFollowing(page) {
  await page.goto(`${BASE}/?tab=feed`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(5000);
}

/**
 * Vote on cards whose visible title matches `regex`, until `max` FRESH votes
 * are cast (not just `max` matches — see below). Teaches the ranker on-theme.
 *
 * ★ A post we already upvoted on an earlier day shows the SAME
 * `[data-testid="upvote-button"]`, but clicking it now opens a
 * VoteRemovalDialog confirmation instead of voting — the click target didn't
 * change, its MEANING did (votes-component.tsx: `vote_upvoted` branch). Voting
 * blind here would silently strip a real vote instead of casting a new one.
 * So: click, then check for the dialog; if it appeared, Cancel and record the
 * card as "already voted" rather than counting it as a fresh vote.
 *
 * ★ Stopping at `hits.length >= max` (counting already-voted hits too) meant
 * day 3 scanned the same two early-feed posts it had already voted on days
 * 1–2, hit `max`, and stopped — casting ZERO new votes while still reporting
 * two "hits". Now the loop keeps scanning until `max` genuinely NEW votes are
 * cast (or the feed runs out), and already-voted matches are recorded but
 * don't count against the budget.
 */
export async function voteByKeyword(page, regex, max = 2) {
  const cards = page.locator('article');
  const n = await cards.count();
  const hits = [];
  let fresh = 0;
  for (let i = 0; i < n && fresh < max; i++) {
    const card = cards.nth(i);
    const title = (await card.locator('[data-testid="medium-card-title"]').first().innerText().catch(() => '')) || '';
    const author = (await card.locator('[data-testid="medium-card-author"]').first().innerText().catch(() => '')) || '';
    if (!regex.test(title)) continue;
    const btn = card.locator('[data-testid="upvote-button"]').first();
    if ((await btn.count()) === 0) continue;
    await btn.click({ timeout: 20000 }).catch(() => {});
    await sleep(2000);
    const removalDialog = page.locator('[data-testid="vote-removal-dialog-cancel"]').first();
    if (await removalDialog.count()) {
      await removalDialog.click({ timeout: 8000 }).catch(() => {});
      await sleep(1000);
      hits.push({ index: i, author, title: title.slice(0, 70), alreadyVoted: true });
      continue;
    }
    await sleep(1000);
    hits.push({ index: i, author, title: title.slice(0, 70) });
    fresh++;
  }
  return hits;
}

// ★ The LIVE redesigned profile (profile-actions.tsx) toggles the button's
// own label "Follow" -> "Following" (t('profile.following')), NOT "Unfollow"
// as the older classic follow-button.tsx would suggest — checked against
// source, not assumed. Matching only /unfollow/i silently reported every
// successful follow as failed. "Follow" is a strict PREFIX of "Following",
// so the not-following test must anchor to the exact string.
const NOT_FOLLOWING_TEXT = /^follow$/i;
const FOLLOWING_TEXT = /^following$/i;

/** Follow (or confirm-follow) an author from their profile page. Returns before/after button text. */
export async function followAuthor(page, username) {
  await page.goto(`${BASE}/@${username}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(3500);
  const btn = page.locator('[data-testid="profile-follow-button"]').first();
  if ((await btn.count()) === 0) return { username, followed: false, reason: 'no follow button found' };
  const before = (await btn.innerText().catch(() => '')).trim();
  if (FOLLOWING_TEXT.test(before)) return { username, followed: true, before, after: before, alreadyFollowing: true };
  await btn.click({ timeout: 20000 }).catch(() => {});
  await sleep(4000);
  const after = (await btn.innerText().catch(() => '')).trim();
  return { username, followed: FOLLOWING_TEXT.test(after), before, after };
}

/** Check the CURRENT state of the follow button on a profile, without clicking. */
export async function followState(page, username) {
  await page.goto(`${BASE}/@${username}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(3000);
  const btn = page.locator('[data-testid="profile-follow-button"]').first();
  if ((await btn.count()) === 0) return { username, found: false };
  const text = (await btn.innerText().catch(() => '')).trim();
  return { username, found: true, text, following: FOLLOWING_TEXT.test(text), notFollowing: NOT_FOLLOWING_TEXT.test(text) };
}

// ★ The reply/post body editor (MdEditor) is CodeMirror 6, not a plain
// <textarea> — confirmed live: `[data-testid="reply-editor"]` and the
// /submit.html body field both render `.cm-content[contenteditable="true"]`.
// `.fill()` on a `textarea` locator inside either just times out waiting for
// an element that doesn't exist. Click the contenteditable region to focus it,
// then drive real key events with `keyboard.type` — verified this dispatches
// the input CodeMirror listens for (Post/Submit correctly went from
// disabled -> enabled after typing this way).
async function fillCodeMirror(page, container, text) {
  const cm = container.locator('.cm-content').first();
  await cm.waitFor({ state: 'visible', timeout: 15000 });
  await cm.click();
  await page.keyboard.type(text, { delay: 4 });
}

/**
 * Reply to the TOP-LEVEL post at `path` via the real reply editor
 * (comment-reply -> reply-editor -> CodeMirror -> Post), the same component
 * lite accounts use (proxied to /api/lite/posts).
 *
 * ★ A lite reply is NOT synchronous. reply-textbox.tsx: "A lite reply is
 * accepted here and BROADCAST LATER by the publisher account... The wait is
 * real" — the toast says "Reply sent... usually within a minute." Checking
 * for the text on the page immediately after Post is checking the WRONG
 * thing and will always read as a failure; honesty rule #4 says judge the
 * communication (the toast), not the (temporary, promised) absence. This
 * waits past the promised window before checking.
 */
export async function commentOnPost(page, path, text, { waitForArrivalMs = 75000 } = {}) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(4500);
  const replyBtn = page.locator('[data-testid="comment-reply"]').first();
  if ((await replyBtn.count()) === 0) return { commented: false, reason: 'no comment-reply control' };
  await replyBtn.click({ timeout: 15000 }).catch(() => {});
  await sleep(2000);
  const editor = page.locator('[data-testid="reply-editor"]').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await fillCodeMirror(page, editor, text);
  await sleep(800);
  const postBtn = editor.getByRole('button', { name: /^Post$/i }).first();
  const disabled = await postBtn.isDisabled().catch(() => null);
  await postBtn.click({ timeout: 15000 }).catch(() => {});
  await sleep(3000);
  const toast = (await page.locator('ol li').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ');
  const bodyImmediately = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const appearedImmediately = bodyImmediately.includes(text.slice(0, 30));
  // Give the publisher its promised window, then reload and look again.
  await sleep(waitForArrivalMs);
  await page.reload({ waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(3000);
  const bodyAfterWait = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const appearedAfterWait = bodyAfterWait.includes(text.slice(0, 30));
  return {
    commented: true,
    disabledBeforeClick: disabled,
    toast,
    appearedImmediately,
    appearedAfterWait,
    appeared: appearedAfterWait,
    url: page.url()
  };
}

/** Re-check that specific comment text is still visible on a post page later in the week. */
export async function commentStillThere(page, path, text) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(4500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  return body.includes(text.slice(0, 30));
}

/** Short-form composer on the home feed ("What's on your mind?"). */
export async function writeComposerPost(page, text) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(3000);
  await page.getByText("What's on your mind?").first().click({ timeout: 15000 }).catch(() => {});
  const ta = page.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 10000 });
  await ta.fill(text);
  const before = page.url();
  const postBtn = page.getByRole('button', { name: /^Post$/ }).first();
  await postBtn.click({ timeout: 15000 }).catch(() => {});
  await sleep(7000);
  const toast = (await page.locator('ol li').allInnerTexts().catch(() => [])).join(' ');
  return { navigated: page.url() !== before, url: page.url(), toast };
}

/**
 * The full editor at /submit.html — title + CodeMirror body + tags + Submit.
 * ★ Tags are REQUIRED here: post-form.tsx computes
 * `tagsRequired = !categoryParam && watchedValues.category === "blog"`, true
 * on a bare /submit.html visit, and Submit stays disabled without one — a
 * body-only fill (this helper's earlier version) would silently never enable
 * Submit. Confirmed live: "Post published" toast + redirect to "/" on success
 * (use-post-form-actions.ts), matching the short composer's own confirmation.
 */
export async function writeFullEditorPost(page, title, body, tags = 'photography food travel') {
  await page.goto(`${BASE}/submit.html`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(3500);
  const titleInput = page.locator('[data-testid="post-title-input"]').first();
  await titleInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await titleInput.fill(title);
  const formContainer = page.locator('[data-testid="form-container"]').first();
  await fillCodeMirror(page, formContainer, body);
  const tagsInput = page.getByPlaceholder(/enter your tags/i).first();
  await tagsInput.fill(tags).catch(() => {});
  await sleep(1500);
  const submitBtn = page.locator('[data-testid="submit-post-button"]').first();
  const disabled = await submitBtn.isDisabled().catch(() => null);
  await submitBtn.click({ timeout: 15000 }).catch(() => {});
  await sleep(3000);
  const toast = (await page.locator('ol li').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ');
  await sleep(5000);
  return { url: page.url(), disabledBeforeClick: disabled, toast };
}

/** Check a post (by matching leading text) is present on the author's own profile. */
export async function postStillOnProfile(page, username, textSnippet) {
  await page.goto(`${BASE}/@${username}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(4000);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  return body.includes(textSnippet.slice(0, 30));
}

/** Scroll repeatedly and report whether the card count actually grew (infinite scroll proof). */
export async function scrollDeep(page, rounds = 6) {
  const before = await page.locator('[data-testid="medium-card-title"]').count();
  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 3000);
    await sleep(1800);
  }
  await sleep(2500);
  const after = await page.locator('[data-testid="medium-card-title"]').count();
  return { before, after, grew: after > before };
}

/** Visit a topic page for one of our chosen interests and count what's there. */
export async function visitTopic(page, tag) {
  await page.goto(`${BASE}/topics/${tag}`, { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});
  await sleep(4500);
  const count = await page.locator('[data-testid="medium-card-title"]').count();
  return { tag, count, url: page.url() };
}

export { BASE };
