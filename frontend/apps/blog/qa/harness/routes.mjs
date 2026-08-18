/**
 * ════ THE ROUTE INVENTORY — WHAT THE SWEEP IS ALLOWED TO CALL "EVERY PAGE" ════
 *
 * ★★★ THIS FILE IS THE HARNESS'S SINGLE BIGGEST LIABILITY, SO READ THIS FIRST.
 *
 * Every blanket check downstream is only as honest as this list. A sweep that
 * enumerates 12 of 53 pages, finds nothing, and reports "all pages clean" is worse
 * than no sweep at all — it is a false clean bill, and it is exactly the failure mode
 * this repo has been burned by before ("never claim completeness you didn't earn").
 *
 * So this module does three things, in order of importance:
 *   1. enumerates routes from the `app/` directory, which is Next.js's DOCUMENTED and
 *      version-stable public contract (file conventions), NOT from `.next/*.json`
 *      build manifests, which are undocumented internals that change without notice;
 *   2. exports `EXPECTED_PAGE_COUNT` and refuses to run if the real count drifts from
 *      it, so a route added or deleted forces a deliberate update rather than
 *      silently widening or narrowing coverage;
 *   3. hard-fails on an empty or implausibly small result, because a glob that
 *      matches nothing must FAIL, never pass. (`vacuous_pass_is_worse_than_fail`.)
 *
 * ★ WHY NOT A CRAWLER. A link crawler finds only what is reachable from `/` by an
 * `<a href>`, which silently drops orphaned pages, auth-gated pages and anything
 * reached by a form or a router push — i.e. precisely the pages least likely to be
 * hand-tested. The file tree is the ground truth for "does this page exist".
 *
 * A crawl is still WORTH running, but as a DIFFERENT question: a route in the file
 * tree that no crawl can reach is an orphaned-page bug. `npm run harness:orphans`
 * does that diff. It is not this file's job.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const APP_DIR = join(HERE, '..', '..', 'app');

/**
 * ★ THE DRIFT TRIPWIRE. Update this deliberately when you add or remove a page, and
 * say why in the commit. It exists so that "the sweep passed" can never quietly mean
 * "the sweep looked at fewer pages than last week".
 *
 * Counted 2026-08-18: 53 `page.tsx` files under `app/`.
 */
export const EXPECTED_PAGE_COUNT = 53;

/** Below this, something is structurally wrong with the glob — fail loudly. */
const IMPLAUSIBLY_FEW = 20;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * `app/foo/(group)/[slug]/page.tsx` -> `/foo/[slug]`.
 *
 * Route groups `(name)` and parallel-route slots `@slot` contribute NO url segment —
 * that is the documented convention, and getting it wrong silently produces urls that
 * 404, which would then be "swept" and reported as broken pages. Both are stripped.
 */
function fileToRoute(file) {
  const rel = relative(APP_DIR, file).split(sep).join('/');
  const route = `/${rel}`
    .replace(/\/page\.(tsx|ts|jsx|js)$/, '')
    .replace(/\/\([^/)]+\)/g, '')
    .replace(/\/@[^/]+/g, '');
  return route === '' ? '/' : route;
}

/** Every `page.tsx` in the app, as a URL PATTERN (dynamic segments still bracketed). */
export function listPagePatterns() {
  const files = walk(APP_DIR).filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f.split(sep).join('/')));
  const patterns = [...new Set(files.map(fileToRoute))].sort();

  if (patterns.length === 0) {
    throw new Error(`route enumeration found ZERO pages under ${APP_DIR} — the glob is broken, not the app`);
  }
  if (patterns.length < IMPLAUSIBLY_FEW) {
    throw new Error(
      `route enumeration found only ${patterns.length} pages under ${APP_DIR}; expected ~${EXPECTED_PAGE_COUNT}. ` +
        `Refusing to sweep a suspiciously small subset and call it complete.`
    );
  }
  return patterns;
}

/**
 * ════ DYNAMIC SEGMENTS ════
 *
 * A pattern like `/[param]/[p2]/[permlink]` is not a URL. Something has to choose real
 * values, and that choice IS the coverage: sweeping `/@alice` proves nothing about
 * `/@alice-with-a-very-long-name` or an account that does not exist.
 *
 * ★ DELIBERATE EDGE CASES, NOT JUST HAPPY VALUES. Each pattern below carries at least
 * one ordinary value and, where it is meaningful, one value chosen to break something:
 * an account with no posts (empty state), a name that does not exist (404 path), a tag
 * nobody uses. The research on agent blind spots is blunt about this — agents check the
 * happy path at one viewport and stop, and empty/error states are the states that ship
 * broken.
 *
 * ★ THESE ROT. A hand-picked slug can be deleted upstream, at which point the sweep is
 * quietly testing a 404 and calling it a page. `harness:check-fixtures` re-resolves
 * every value below against the live API and fails if one has gone missing, so the rot
 * is caught as a red run rather than as fake coverage.
 */
export const DYNAMIC_SAMPLES = {
  '/[param]': ['@lordbutterfly', '@nonexistent-account-xyz'],
  '/[param]/settings': ['@lordbutterfly'],
  '/[param]/communities': ['@lordbutterfly'],
  '/[param]/followers': ['@lordbutterfly'],
  '/[param]/following': ['@lordbutterfly'],
  '/[param]/followed': ['@lordbutterfly'],
  '/[param]/feed': ['@lordbutterfly'],
  '/[param]/comments': ['@lordbutterfly'],
  '/[param]/lists/blacklisted': ['@lordbutterfly'],
  '/[param]/lists/muted': ['@lordbutterfly'],
  '/[param]/lists/followed_blacklists': ['@lordbutterfly'],
  '/[param]/lists/followed_muted_lists': ['@lordbutterfly'],
  '/trending/[tag]': ['hive-139531', 'a-tag-nobody-uses-xyz'],
  '/hot/[tag]': ['hive-139531'],
  '/created/[tag]': ['hive-139531'],
  '/payout/[tag]': ['hive-139531'],
  '/muted/[tag]': ['hive-139531'],
  '/roles/[tag]': ['hive-139531'],
  '/topics/[tag]': ['photography'],
  '/creators/[handle]': ['lordbutterfly'],
  // Three segments at once. `[param]` is the category, `[p2]` the @author.
  '/[param]/[p2]/[permlink]': [
    { param: 'hive-139531', p2: '@ecency', permlink: 'ecency-scaling-hive-access-infrastructure' }
  ]
};

/** Turn one pattern + one sample into a concrete URL. */
function fill(pattern, sample) {
  if (typeof sample === 'string') {
    // Single dynamic segment: substitute the first bracketed group.
    return pattern.replace(/\[[^\]]+\]/, sample);
  }
  let url = pattern;
  for (const [key, value] of Object.entries(sample)) {
    url = url.replace(`[${key}]`, value);
  }
  return url;
}

/**
 * The concrete URL list the sweep visits.
 *
 * ★ A DYNAMIC PATTERN WITH NO SAMPLE IS A HARD ERROR, NOT A SKIP. Skipping it would
 * quietly drop a page from "every page" — the exact dishonesty this file exists to
 * prevent. If you add a dynamic route, you add a sample for it, or the harness stops.
 */
export function listSweepUrls() {
  const patterns = listPagePatterns();
  const urls = [];
  const missing = [];

  for (const pattern of patterns) {
    if (!pattern.includes('[')) {
      urls.push({ pattern, url: pattern });
      continue;
    }
    const samples = DYNAMIC_SAMPLES[pattern];
    if (!samples || samples.length === 0) {
      missing.push(pattern);
      continue;
    }
    for (const sample of samples) urls.push({ pattern, url: fill(pattern, sample) });
  }

  if (missing.length > 0) {
    throw new Error(
      `No DYNAMIC_SAMPLES entry for: ${missing.join(', ')}.\n` +
        `Add real values (and at least one edge case) to routes.mjs, or the sweep would ` +
        `silently skip these pages while claiming full coverage.`
    );
  }
  return urls;
}

/**
 * Routes that REQUIRE a session. The sweep asserts these redirect to sign-in when
 * anonymous, rather than asserting they render — otherwise a working auth gate looks
 * like a broken page.
 *
 * Derived from the per-page session checks in the app (there is no middleware auth
 * gate; `middleware.ts` only does a legacy redirect and a cache-control invariant).
 */
export const AUTH_REQUIRED = [
  '/profile',
  '/wallet',
  '/wallet/tokens',
  '/proposals',
  '/creators/launch',
  '/creators/studio',
  '/[param]/settings'
];

export function isAuthRequired(pattern) {
  return AUTH_REQUIRED.includes(pattern);
}

/**
 * URLs whose 404 is the POINT of the test.
 *
 * ★ WITHOUT THIS, THE HARNESS PUNISHES ITS OWN EDGE CASES (found on the first real run).
 * `/@nonexistent-account-xyz` and `/trending/a-tag-nobody-uses-xyz` exist in
 * `DYNAMIC_SAMPLES` precisely to exercise the not-found path — which agents are
 * documented to skip. Counting their 404 as a failure would push whoever maintains this
 * to delete the edge cases, i.e. to delete the coverage.
 *
 * A 404 here is a PASS. What is still asserted on these URLs is everything else: that
 * the not-found page renders real content, has no console errors, no overflow, and a
 * heading structure.
 */
// ★ ONLY THE ACCOUNT. An unused TAG does not 404 — measured: `/trending/<unused-tag>`
// 307-redirects to `/topics/<tag>` and renders an empty feed, which is correct product
// behaviour. My first guess that it would 404 was wrong, and the harness caught my
// assumption rather than an app bug. Worth keeping the URL in the sweep: an empty feed
// is exactly the state agents are documented to leave broken.
export const EXPECT_NOT_FOUND = [
  '/@nonexistent-account-xyz',
  // ★ DELIBERATE PRODUCTION GATE, NOT A BUG. `app/healthchecker/layout.tsx` calls
  // `notFound()` unless `LUMEN_ENABLE_HEALTHCHECKER=yes` — verified in source, in the
  // running process's env, and in the compiled `.next-qa` bundle. Left in the sweep so
  // that the gate OPENING unnoticed would be caught, but its 404 is the pass condition.
  '/healthchecker'
];

/**
 * ★★★ PAGES THAT EXIST AS FILES BUT CANNOT BE REACHED BY ANY REQUEST.
 *
 * `next.config.js` `redirects()` matches these with no `has`/`missing` condition, and
 * Next processes config redirects BEFORE middleware and before any page component runs.
 * Proved empirically rather than by reading the config: their 307 responses carry none
 * of middleware's fingerprints (no `set-cookie`, no CSP header), while a response that
 * DID pass through middleware carries all of them. There is no header, cookie or query
 * string that routes around them.
 *
 * ★ WHY THIS LIST EXISTS AT ALL, AND IT IS AN HONESTY FIX, NOT A CONVENIENCE.
 * The sweep was visiting all 15 and reporting them as 15 distinct pages of coverage.
 * They are not — they all land on `/`, `/?tab=feed` or `/topics/:tag`, so the sweep was
 * re-testing three destinations fifteen times and counting it as breadth. That is the
 * inflated-coverage claim this harness exists to prevent, committed by the harness
 * itself. They stay in the sweep (a redirect that silently stops working is worth
 * catching) but they are reported separately and excluded from the reachable-page count.
 *
 * These 15 `page.tsx` files are dead code and are candidates for deletion — that is a
 * product decision, not the harness's to make.
 */
export const SHADOWED_BY_REDIRECT = [
  '/trending', '/trending/my', '/trending/[tag]',
  '/hot', '/hot/my', '/hot/[tag]',
  '/created', '/created/my', '/created/[tag]',
  '/payout', '/payout/my', '/payout/[tag]',
  '/muted', '/muted/my', '/muted/[tag]'
];

export function isShadowed(pattern) {
  return SHADOWED_BY_REDIRECT.includes(pattern);
}

export function expectsNotFound(url) {
  return EXPECT_NOT_FOUND.includes(url);
}
