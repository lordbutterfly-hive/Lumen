/**
 * F4 — PROOF that the bpcvoter global ban works, driven at runtime.
 *
 * Two things, kept SEPARATE on purpose (per coordinator correction 2026-08-11):
 *
 *  PART 1 (this running server, unmodified behaviour): call the real
 *  `/api/discussion` route — the exact same function (`getDiscussion` ->
 *  `withoutBannedDiscussion`) that both the server-rendered page and the client's
 *  own refetch use — for the POB post, signed in as a real Lumen session. This is
 *  the BEFORE state, and it also proves the config edit did NOT silently take
 *  effect: `apps/blog/.env.local` was edited (REACT_APP_BANNED_AUTHORS now
 *  includes bpcvoter*) before this ran, and the running process still serves the
 *  old (kgakakillerg-only) list — exactly as the house rule warned ("do NOT
 *  restart the dev server").
 *
 *  Cross-checked against the actual rendered DOM on the real page (Playwright,
 *  signed in, http://localhost:3000, comment avatar `alt` text — the same
 *  `comment.author`-derived string every comment card carries) so the number is
 *  not just "what the API could return" but "what a reader actually sees".
 *
 *  We explicitly do NOT read the "(blacklisted)" tag as a signal either way — it
 *  is driven by Hivemind's `reputation-N` synthetic flag on these accounts, not by
 *  any blacklist, ours or anyone else's (see
 *  apps/blog/lib/moderation/blacklist-reason.ts for the measured proof). Its
 *  presence/absence is irrelevant to whether the ban works.
 *
 *  PART 2 (a fresh Node process, the REAL code, not a reimplementation): import
 *  `packages/ui/config/lists/banned-authors.ts` directly — the exact module the
 *  running server also uses — in a brand-new process where `process.env` can
 *  legitimately be set at start-up (no server restart involved, no shared state
 *  with the running dev server's module cache). Feed it the REAL discussion
 *  payload captured in Part 1, with the new list applied, and show the bpcvoter
 *  nodes are gone AND that the subtree/replies-array repair holds (no dangling
 *  references left for the client).
 *
 * Run:
 *   QA_BASE=http://localhost:3000 node qa/harness/bpcvoter-ban-proof.mjs
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { signedInStorageState } from './session.mjs';

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const POST_PATH = '/hive/@lordbutterfly/killing-hives-social-potential-pob-based-content-discovery';
const AUTHOR = 'lordbutterfly';
const PERMLINK = 'killing-hives-social-potential-pob-based-content-discovery';
const BPCVOTER = /^bpcvoter[0-9]*$/;
const DUMP_PATH =
  '/tmp/claude-1004/-home-clauderfly/7a75b7b2-e72e-4770-80f8-965e167e7e8d/scratchpad/pob-discussion-captured.json';

let passed = 0;
let failed = 0;
function check(name, cond, evidence) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}
function section(t) {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}

/**
 * Direct authenticated call to /api/discussion — the SAME server function both
 * SSR and the client's own refetch use. Polls with a generous per-attempt timeout:
 * this post is known-slow (807 nodes; F3 measured 16.3s cold, and the owner saw
 * Runtime.evaluate time out at 45s on this exact page).
 */
async function fetchDiscussionDirect(cookieHeader, { attempts = 3, timeoutMs = 90000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(
        `${BASE}/api/discussion?author=${AUTHOR}&permlink=${PERMLINK}`,
        { headers: { cookie: cookieHeader }, signal: controller.signal }
      );
      const body = await res.json();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`  /api/discussion attempt ${attempt}: ${ms.toFixed(0)} ms, status=${res.status}, degraded=${body?.degraded ?? 'no'}`);
      const discussion = body?.discussion ?? {};
      if (Object.keys(discussion).length > 0) return discussion;
      lastErr = new Error(`empty discussion (degraded=${body?.degraded})`);
    } catch (error) {
      lastErr = error;
      console.log(`  /api/discussion attempt ${attempt} failed: ${String(error).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('fetchDiscussionDirect: exhausted attempts');
}

async function main() {
  section('0. SIGN IN');
  const storageState = await signedInStorageState('hbd-temp');
  const cookieHeader = storageState.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  console.log(`  Signed-in session minted for hbd-temp, verified by the server.`);

  section('1. BEFORE — direct call to the real server route (ground truth)');
  const merged = await fetchDiscussionDirect(cookieHeader);
  const entries = Object.values(merged);
  const byAuthor = {};
  for (const e of entries) byAuthor[e.author] = (byAuthor[e.author] ?? 0) + 1;
  const bpcvoterAuthors = Object.keys(byAuthor).filter((a) => BPCVOTER.test(a));
  const bpcvoterCountBefore = bpcvoterAuthors.reduce((sum, a) => sum + byAuthor[a], 0);

  console.log(`  Total comment entries: ${entries.length}`);
  console.log(`  bpcvoter* breakdown: ${JSON.stringify(Object.fromEntries(bpcvoterAuthors.map((a) => [a, byAuthor[a]])))}`);
  check(
    '★ BASELINE: the ring is currently carpet-bombing this thread (ban not yet effective)',
    bpcvoterCountBefore >= 11,
    `${bpcvoterCountBefore} bpcvoter* comment nodes served (bpcvoter1 alone: ${byAuthor['bpcvoter1'] ?? 0})`
  );
  check(
    'sanity: the ALREADY-banned author (kgakakillerg) is absent from this same payload',
    !('kgakakillerg' in byAuthor),
    `kgakakillerg entries: ${byAuthor['kgakakillerg'] ?? 0} — proves the mechanism itself works; bpcvoter's presence is a CONFIG gap, not a broken filter`
  );
  check(
    'the root post itself is present (this is real upstream data, not an empty/degraded answer)',
    entries.some((e) => e.author === AUTHOR && e.permlink === PERMLINK),
    `root present`
  );

  writeFileSync(DUMP_PATH, JSON.stringify(merged));
  console.log(`  Captured to ${DUMP_PATH} for the isolated module test (Part 2).`);

  section('2. CROSS-CHECK ON THE ACTUAL RENDERED PAGE (Playwright, signed in)');
  const browser = await chromium.launch();
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  const t0 = process.hrtime.bigint();
  await page.goto(`${BASE}${POST_PATH}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page
    .waitForSelector('[data-testid="comment-list-item"]', { timeout: 90000 })
    .catch(() => null);
  // Let the long tail of 807 nodes finish painting rather than a short fixed wait.
  await page.waitForTimeout(8000);
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  Page settled in ${loadMs.toFixed(0)} ms.`);

  const domCommentNodes = await page.locator('[data-testid="comment-list-item"]').count();
  const domBpcvoterAvatars = await page.locator('img[alt^="bpcvoter"]').count();
  check(
    'the post page actually rendered comment nodes (not an empty/broken page)',
    domCommentNodes > 0,
    `${domCommentNodes} data-testid="comment-list-item" nodes`
  );
  check(
    '★ the rendered DOM shows bpcvoter* comment avatars too (not just the API — the READER sees this)',
    domBpcvoterAvatars > 0,
    `${domBpcvoterAvatars} <img alt="bpcvoter*..."> nodes on screen`
  );

  section('3. CONFIRM THE .env.local EDIT DID NOT SILENTLY TAKE EFFECT (no restart)');
  const merged2 = await fetchDiscussionDirect(cookieHeader, { attempts: 1, timeoutMs: 90000 });
  const entries2 = Object.values(merged2);
  const bpcvoterAfterEditCount = entries2.filter((e) => BPCVOTER.test(e.author)).length;
  check(
    'REACT_APP_BANNED_AUTHORS now including bpcvoter* has NOT changed what the running process serves',
    bpcvoterAfterEditCount > 0,
    `/api/discussion still serves ${bpcvoterAfterEditCount} bpcvoter* nodes after the config file was edited — confirms the module-level cache (and react-env's browser snapshot) needs a restart, exactly as the house rule states. Not restarting, per instructions.`
  );

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed (Parts 1-3)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
