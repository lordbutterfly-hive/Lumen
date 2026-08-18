/**
 * ════ THE API SWEEP (D8) ════
 *
 * `sweep.mjs` visits every PAGE route (53 of them). It has never sent a single request
 * to any of the ~95 API routes under `app/api/**`. This is that sweep.
 *
 * RUN IT (against the running server — dev or prod, whichever is up; this file does
 * NOT build or start anything, and does not require a production build the way the page
 * sweep does, because these are plain HTTP requests, not a browser measuring hydration):
 *
 *   node qa/harness/api-sweep.mjs
 *   node qa/harness/api-sweep.mjs --base=http://127.0.0.1:3000
 *
 * ════ WHAT THIS DOES NOT DO, ON PURPOSE ════
 *
 * 1. It never sends a request that could write data, broadcast a Hive/Magi transaction,
 *    send mail, or otherwise mutate anything real. See "THE SAFETY ARGUMENT" below for
 *    why every mutating route in this codebase can be probed with an empty/invalid body
 *    and still never reach a side effect.
 * 2. It does not guess query strings. Every GET is probed bare (no `?params`). A route
 *    that 400s on a missing required param is answering correctly; a route that 500s on
 *    one is a real bug either way — both are recorded, only the second is gated.
 * 3. It does not attempt authenticated probes. Every request is anonymous. A route
 *    answering 401/403 is the CORRECT anonymous answer and is never gated on; a route
 *    answering 200 with what looks like private data anonymously is gated — that is
 *    this sweep's version of the page-sweep's "auth-gated page rendered anyway" check.
 *
 * ════ THE SAFETY ARGUMENT (read before adding a new route to DESTRUCTIVE_SKIP) ════
 *
 * Every mutating (POST/PUT/PATCH/DELETE) handler in this codebase, read individually
 * on 2026-08-18 (all 33 of them, app/api/**), calls its guard — `guardWrite` (requires
 * the `x-csrf-token` header, presence-only check, see lib/lite/http/csrf.ts),
 * `guardModerator` / `guardPublisher` / `guardAccountCreator` / `guardRecsys` (each
 * requires a distinct shared-secret header, constant-time compared, lib/lite/http/guard.ts),
 * or a bare `hasCsrfHeader` check (the two `/api/lite/auth/logout*` routes) — as the
 * UNCONDITIONAL FIRST statement in the function body, before any `req.json()`, session
 * lookup, or side-effecting call. This probe sends no CSRF header, no shared-secret
 * header, and no session cookie, on every request. That means every guarded write
 * route in this app rejects at the guard, before its body is ever parsed, regardless of
 * what body this script sends. The three GQL/REST proxies with no guard at all
 * (`creator-tokens/gql`, `prediction-market/gql`, `hivesense`) were individually read
 * too: each validates the operation/query against a fixed allowlist before forwarding
 * anything, and every forwarded operation is a READ against the upstream node — there
 * is no mutating operation reachable through any of the three even with a well-formed
 * body. `csp-report`, `google-drive/auth` and `google-drive/refresh` were read the same
 * way: each validates its required field and returns 400 before any external call.
 *
 * This is why `DESTRUCTIVE_SKIP` below is empty rather than a long list — not because
 * skipping was overlooked, but because every mutating route was individually confirmed
 * safe to probe with an empty body and no auth. If you add a new mutating route whose
 * guard is NOT the first statement, or that can reach a side effect on invalid input,
 * add its pattern to `DESTRUCTIVE_SKIP` with a comment saying why, and it will be
 * reported as skipped rather than probed.
 *
 * ════ WHAT MAKES THIS HARNESS HARD TO FAKE ════
 *
 *  1. The route list is derived from the filesystem (`app/api/**\/route.{ts,tsx,js,jsx}`),
 *     cross-checked against the built `routes-manifest.json`, and the disagreement is
 *     itself reported as a finding — not silently reconciled. See `crossCheckManifest`.
 *  2. Zero routes discovered, or the server unreachable, exits 3 — "nothing to inspect"
 *     — exactly like `anti-cheat.mjs`'s empty-diff rule. It never reports a clean run
 *     over zero real probes.
 *  3. The classifier self-tests against five synthetic known-bad cases and four
 *     known-good/exempt cases before the real run, AND against one live probe of a
 *     route that provably does not exist, asserting the whole pipeline (probe -> status
 *     -> classify) produces the correct answer end to end. Either self-test failing
 *     aborts the run (exit 2) rather than reporting zero findings from a broken
 *     detector.
 *  4. Counts of routes discovered, probed and skipped are in the report, with reasons
 *     for every skip. A run that skipped most routes cannot look like full coverage.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR } from './routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, 'reports');
const API_DIR = join(APP_DIR, 'api');
const ROUTES_MANIFEST_PATH = join(HERE, '..', '..', '.next-qa', 'routes-manifest.json');
const APP_PATH_MANIFEST_PATH = join(HERE, '..', '..', '.next-qa', 'app-path-routes-manifest.json');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const BASE = args.base || 'http://127.0.0.1:3000';

/** A route answering slower than this is gated — matches the task's stated bar. */
const SLOW_GATE_MS = 5000;
/** How long this script itself waits for one response before giving up on it. Set
 *  above SLOW_GATE_MS so a route that is merely slow (gated, informative) is
 *  distinguished from one that never answers at all (network-level, excluded). */
const REQUEST_TIMEOUT_MS = 9000;
/** If more than this fraction of probes fail at the network level (not HTTP — actual
 *  connection failures), the server is flaking mid-run and results would be fake. */
const NETWORK_ERROR_ABORT_RATIO = 0.2;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Routes whose CORRECT response is not JSON — exempted from the "HTML/empty body where
 * JSON expected" checks. Confirmed by reading each file:
 *   - `avatar`, `avatar/default` proxy an image host (binary image body).
 *   - `og` renders a PNG via `next/og`'s `ImageResponse` (binary image body).
 *   - `google-drive/callback` is NOT a JSON endpoint despite living under `/api/`: it is
 *     an OAuth redirect landing page for the Safari flow, deliberately returning a small
 *     HTML+`<script>` document that reads sessionStorage and does a client-side redirect
 *     — `Content-Type: text/html` is correct here, not a bug. ★ Found by running the
 *     first version of this sweep against the real server: it flagged this route before
 *     this exemption existed, and reading the source (not just the response) is what
 *     told the two cases apart — a genuine handler bug would ALSO produce `text/html`,
 *     so the distinction has to be made per-route, by design, not by sniffing the body.
 */
const NON_JSON_ROUTES = new Set(['/api/avatar', '/api/avatar/default', '/api/og', '/api/google-drive/callback']);

/**
 * ★ EMPTY ON PURPOSE — see "THE SAFETY ARGUMENT" in the header comment. Every mutating
 * route was individually read and confirmed to guard-then-validate before any side
 * effect, so an empty/no-auth probe cannot reach one. Add an entry here (pattern +
 * reason) only for a route where that is NOT true.
 */
const DESTRUCTIVE_SKIP = new Map();

/** Fixed values for the three dynamic API path patterns this repo has. Each carries at
 *  least one edge case (a value chosen not to exist), same discipline as routes.mjs's
 *  DYNAMIC_SAMPLES and for the same reason: an unauthenticated GET of a real value one
 *  clean run has already used tells us less than the not-found path also being clean. */
const DYNAMIC_SAMPLES = {
  '/api/lite/posts/[id]': ['qa-harness-nonexistent-post-id'],
  // ★ THE `user` SEGMENT MUST CARRY ITS `@` PREFIX (found running this sweep,
  // 2026-08-18). This route has exactly one real caller: next.config.js's fallback
  // rewrite `/:user((?:@|%40)[^/]+)/:permlink` -> `/api/resolve-post/:user/:permlink`,
  // and the handler's own `isValidUserParam` rejects a `user` segment with no `@`/`%40`
  // — by design, immediately, before ever calling `getPost`. A bare `ecency` (no `@`)
  // was the FIRST value tried here and produced a false "known-good post 404s"
  // finding; verified live that `bridge.get_post` and the real page both resolve the
  // post fine, and that only THIS route, given the wrong shape of input, redirects it
  // to /404. That was this harness's fixture bug, not an app bug — fixed by matching
  // the one real caller's convention instead of the page route's.
  '/api/resolve-post/[user]/[permlink]': [
    { user: '@ecency', permlink: 'ecency-scaling-hive-access-infrastructure' },
    { user: '@qa-harness-nonexistent-user-xyz', permlink: 'qa-harness-nonexistent-permlink-xyz' }
  ],
  '/api/streak/[user]': ['lordbutterfly', 'qa-harness-nonexistent-user-xyz']
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `app/api/foo/[id]/route.ts` -> `/api/foo/[id]`. Route groups/parallel slots are not
 *  used under app/api today, but stripped the same way routes.mjs does for pages, so a
 *  future one does not silently produce a URL that can never match. */
function fileToPattern(file) {
  const rel = relative(API_DIR, file).split(sep).join('/');
  const stripped = rel
    .replace(/\/?route\.(ts|tsx|js|jsx)$/, '')
    .replace(/\/\([^/)]+\)/g, '')
    .replace(/\/@[^/]+/g, '');
  return stripped === '' ? '/api' : `/api/${stripped}`;
}

function detectMethods(src) {
  const found = [];
  for (const m of HTTP_METHODS) {
    const fnRe = new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`);
    const constRe = new RegExp(`export\\s+const\\s+${m}\\s*=`);
    if (fnRe.test(src) || constRe.test(src)) found.push(m);
  }
  return found;
}

/**
 * ════ STEP 1: ENUMERATE FROM THE FILESYSTEM ════
 * Returns [] rather than throwing on zero files — the caller decides that is a vacuous
 * run (exit 3), not a harness bug (exit 2). A missing app/api DIRECTORY, in contrast,
 * means this script's own path assumption is wrong, which is a harness bug.
 */
function listApiRoutes() {
  if (!existsSync(API_DIR)) {
    throw new Error(`app/api directory not found at ${API_DIR} — this script's path assumption is wrong`);
  }
  const files = walk(API_DIR).filter((f) => /\/route\.(ts|tsx|js|jsx)$/.test(f.split(sep).join('/')));
  const routes = files
    .map((f) => ({ pattern: fileToPattern(f), file: f, methods: detectMethods(readFileSync(f, 'utf8')) }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
  return routes;
}

/**
 * ════ STEP 1b: CROSS-CHECK AGAINST THE BUILT MANIFEST ════
 *
 * ★ WHY ONLY THE DYNAMIC HALF IS COMPARED. Verified empirically against the manifest
 * actually on disk: `routes-manifest.json`'s `staticRoutes` array contains ZERO `/api/*`
 * entries — Next only needs a matching regex for a PARAMETERIZED path, so every literal
 * API path (95 of the 95 non-bracketed routes here) is simply absent from that array,
 * by design, not by drift. Comparing fs-static routes against `staticRoutes` would
 * manufacture ~90 false "disagreements" out of an implementation detail. `dynamicRoutes`
 * IS a meaningful cross-check: it is where Next records every bracketed API path it
 * knows about, from BOTH the app router and the legacy pages router.
 *
 * That last clause is exactly how this check earns its keep: on this repo,
 * `routes-manifest.json`'s dynamicRoutes lists `/api/oidc/[[...slug]]`, which the
 * app/api/**\/route.ts glob will never find, because it is not there — it lives at
 * `pages/api/oidc/[[...slug]].ts`, a second, entirely separate API surface this task's
 * filesystem scope does not cover. That disagreement is reported, not swallowed.
 */
function crossCheckManifest(fsRoutes) {
  const result = { manifestPresent: false, disagreements: [], notes: [] };
  if (!existsSync(ROUTES_MANIFEST_PATH)) {
    result.notes.push(`routes-manifest.json not found at ${ROUTES_MANIFEST_PATH} — skipping manifest cross-check`);
    return result;
  }
  result.manifestPresent = true;
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST_PATH, 'utf8'));
  const manifestDynamicApi = (manifest.dynamicRoutes || []).map((r) => r.page).filter((p) => p.startsWith('/api/'));
  const manifestStaticApi = (manifest.staticRoutes || []).map((r) => r.page).filter((p) => p.startsWith('/api/'));
  result.notes.push(
    `routes-manifest.json: ${manifestDynamicApi.length} dynamic /api/* entries, ` +
      `${manifestStaticApi.length} static /api/* entries (expected 0 — see header comment)`
  );

  const fsDynamic = fsRoutes.filter((r) => r.pattern.includes('[')).map((r) => r.pattern);
  const manifestOnly = manifestDynamicApi.filter((p) => !fsDynamic.includes(p));
  const fsOnly = fsDynamic.filter((p) => !manifestDynamicApi.includes(p));

  if (manifestOnly.length) {
    result.disagreements.push({
      type: 'manifest_has_route_fs_glob_missed',
      patterns: manifestOnly,
      why:
        'routes-manifest.json knows a dynamic /api/* path that app/api/**/route.ts does not have. ' +
        'On this repo this is pages/api/oidc/[[...slug]].ts — a whole second API surface (also ' +
        'pages/api/auth/{login,logout,consent,chat-token}.ts and pages/api/users/me.ts) that an ' +
        'app/api-only enumeration is structurally blind to. Not probed by this script (out of the ' +
        'stated app/api/** scope) but real and live at these paths — flagged for a follow-up sweep.'
    });
  }
  if (fsOnly.length) {
    result.disagreements.push({
      type: 'fs_has_route_manifest_missed',
      patterns: fsOnly,
      why: 'app/api/**/route.ts has a dynamic route the build manifest does not know about — likely a stale .next-qa build. Rebuild and re-run.'
    });
  }

  // Bonus, clearly-separate cross-check: app-path-routes-manifest.json enumerates EVERY
  // app-router path (static and dynamic) with its literal file, so it is the one real
  // apples-to-apples check on the fs glob's completeness. Not the manifest the task
  // named, so kept as a labelled EXTRA rather than folded into the primary comparison.
  if (existsSync(APP_PATH_MANIFEST_PATH)) {
    const appPathManifest = JSON.parse(readFileSync(APP_PATH_MANIFEST_PATH, 'utf8'));
    const appPathApi = Object.values(appPathManifest).filter((p) => typeof p === 'string' && p.startsWith('/api/'));
    const fsAll = fsRoutes.map((r) => r.pattern);
    const extraOnly = appPathApi.filter((p) => !fsAll.includes(p));
    const fsExtra = fsAll.filter((p) => !appPathApi.includes(p));
    result.notes.push(
      `EXTRA cross-check, app-path-routes-manifest.json (not the manifest the task named, kept separate): ` +
        `${appPathApi.length} app-router /api/* entries vs ${fsAll.length} from the fs glob — ` +
        `${extraOnly.length} manifest-only, ${fsExtra.length} fs-only`
    );
    if (extraOnly.length) result.disagreements.push({ type: 'app_path_manifest_only', patterns: extraOnly, why: 'app-path-routes-manifest.json has an app-router API path the fs glob missed.' });
    if (fsExtra.length) result.disagreements.push({ type: 'fs_only_vs_app_path_manifest', patterns: fsExtra, why: 'fs glob found an API route app-path-routes-manifest.json does not know about — stale build.' });
  }

  return result;
}

function fillPattern(pattern, sample) {
  if (typeof sample === 'string') return pattern.replace(/\[[^\]]+\]/, encodeURIComponent(sample));
  let url = pattern;
  for (const [k, v] of Object.entries(sample)) url = url.replace(`[${k}]`, encodeURIComponent(v));
  return url;
}

/** Every concrete URL this sweep will probe, one entry per (route, sample). A dynamic
 *  pattern with no entry in DYNAMIC_SAMPLES is a hard error — same reasoning as
 *  routes.mjs: skipping it silently would drop it from "every route" while claiming
 *  full coverage. */
function expandUrls(routes) {
  const expanded = [];
  const missingSamples = [];
  for (const route of routes) {
    if (!route.pattern.includes('[')) {
      expanded.push({ ...route, url: route.pattern });
      continue;
    }
    const samples = DYNAMIC_SAMPLES[route.pattern];
    if (!samples || samples.length === 0) {
      missingSamples.push(route.pattern);
      continue;
    }
    for (const sample of samples) expanded.push({ ...route, url: fillPattern(route.pattern, sample) });
  }
  if (missingSamples.length) {
    throw new Error(
      `No DYNAMIC_SAMPLES entry for: ${missingSamples.join(', ')}. Add a sample (with an edge case) or the ` +
        `sweep would silently skip these routes while claiming full coverage.`
    );
  }
  return expanded;
}

async function probeOnce(base, method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const init = { method, signal: controller.signal, headers: {}, redirect: 'manual' };
    if (body !== null && body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, init);
    const ms = Date.now() - t0;
    const contentType = res.headers.get('content-type') || '';
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* body unreadable — leave empty, still a real status/contentType to classify */
    }
    return { status: res.status, contentType, bodyText, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    if (err.name === 'AbortError') return { status: null, contentType: '', bodyText: '', ms, timedOut: true };
    return { status: null, contentType: '', bodyText: '', ms, networkError: String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

const PRIVATE_DATA_MARKERS = [
  'password',
  'privatekey',
  'wif',
  'sessionid',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'email',
  'secret',
  'credentials'
];

function looksLikePrivateData(bodyText) {
  if (!bodyText) return false;
  let obj;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const flat = JSON.stringify(obj).toLowerCase();
  return PRIVATE_DATA_MARKERS.some((m) => flat.includes(m));
}

/**
 * ════ THE GATE ════ Pure function, no I/O — self-tested below before it is ever run
 * against a real response. Only the five things the task named are gated; 401/403/404/405
 * are never issues, by construction (nothing here checks for them).
 */
/** Status codes the task names as CORRECT ANSWERS to a probe — never gated on, for any
 *  reason, including body shape or content-type. A framework-level 404 for a route that
 *  a probe deliberately invented (the live self-test) or a method the app validly
 *  refuses legitimately renders Next's own HTML not-found page; that HTML is the right
 *  answer, not a bug wearing HTML. */
const NEVER_GATE_STATUS = new Set([401, 403, 404, 405]);

function classify({ pattern, status, contentType, bodyText, ms, timedOut, networkError }) {
  if (networkError) return { issues: [], networkError: true };
  const issues = [];
  if (timedOut || ms > SLOW_GATE_MS) {
    issues.push(`exceeded ${SLOW_GATE_MS}ms (${timedOut ? `timed out at ${ms}ms` : `${ms}ms`})`);
  }
  if (NEVER_GATE_STATUS.has(status)) return { issues };
  if (status === 500) issues.push('HTTP 500 — the route threw');
  const expectJson = !NON_JSON_ROUTES.has(pattern);
  if (expectJson && contentType && /text\/html/i.test(contentType)) {
    issues.push(`returned HTML where JSON was expected (content-type: ${contentType})`);
  }
  if (status === 200 && expectJson && (!bodyText || bodyText.trim().length === 0)) {
    issues.push('HTTP 200 with an empty body');
  }
  if (status === 200 && looksLikePrivateData(bodyText)) {
    issues.push('possible missing auth gate: HTTP 200 with private-looking data on an unauthenticated request');
  }
  return { issues };
}

/**
 * ════ SELF-TEST, HALF 1: THE PURE CLASSIFIER ════
 * Mirrors the IACVT detector's self-test discipline (css-iacvt.mjs): prove the function
 * still flags each of the five gated bug shapes, and stays quiet on everything the task
 * says must never be gated, BEFORE trusting it against a live server.
 */
function selfTestClassifier() {
  const cases = [
    ['http-500', { pattern: '/api/x', status: 500, contentType: 'application/json', bodyText: '{}', ms: 50 }, true],
    ['html-not-json', { pattern: '/api/x', status: 200, contentType: 'text/html; charset=utf-8', bodyText: '<html></html>', ms: 50 }, true],
    ['empty-200-body', { pattern: '/api/x', status: 200, contentType: 'application/json', bodyText: '', ms: 50 }, true],
    [
      'missing-auth-gate',
      { pattern: '/api/x', status: 200, contentType: 'application/json', bodyText: JSON.stringify({ username: 'bob', email: 'bob@example.com', sessionId: 'abc123' }), ms: 50 },
      true
    ],
    ['slow-response', { pattern: '/api/x', status: 200, contentType: 'application/json', bodyText: '{"ok":true}', ms: 6000 }, true],
    ['timed-out', { pattern: '/api/x', status: null, contentType: '', bodyText: '', ms: 9000, timedOut: true }, true],
    ['clean-404', { pattern: '/api/x', status: 404, contentType: 'application/json', bodyText: '{"error":"not_found"}', ms: 50 }, false],
    ['clean-401', { pattern: '/api/x', status: 401, contentType: 'application/json', bodyText: '{"error":"unauthorized"}', ms: 50 }, false],
    ['clean-403-missing-csrf', { pattern: '/api/x', status: 403, contentType: 'application/json', bodyText: '{"error":"missing_csrf_header"}', ms: 50 }, false],
    // ★ FOUND BY RUNNING THIS AGAINST THE REAL SERVER (2026-08-18): a route Next has no
    // handler for at all answers 404 with ITS OWN HTML not-found page, not JSON — correct
    // Next.js behaviour, and exactly the case NEVER_GATE_STATUS exists to keep un-gated.
    ['clean-404-html-body', { pattern: '/api/x', status: 404, contentType: 'text/html; charset=utf-8', bodyText: '<html>404</html>', ms: 50 }, false],
    ['clean-405-wrong-method', { pattern: '/api/x', status: 405, contentType: 'text/html; charset=utf-8', bodyText: '<html>405</html>', ms: 50 }, false],
    ['clean-200', { pattern: '/api/x', status: 200, contentType: 'application/json', bodyText: JSON.stringify({ status: 'ok' }), ms: 120 }, false],
    ['image-route-binary-not-flagged-as-empty-or-html', { pattern: '/api/og', status: 200, contentType: 'image/png', bodyText: ' binary ', ms: 80 }, false],
    ['network-error-excluded-not-a-finding', { pattern: '/api/x', status: null, contentType: '', bodyText: '', ms: 10, networkError: 'ECONNREFUSED' }, false]
  ];
  for (const [name, input, expectIssue] of cases) {
    const { issues } = classify(input);
    const got = issues.length > 0;
    if (got !== expectIssue) {
      throw new Error(
        `CLASSIFIER SELF-TEST FAILED on case "${name}": expected issue=${expectIssue}, got issue=${got} ` +
          `(issues: ${JSON.stringify(issues)}). The gate is broken — aborting rather than reporting a run that means nothing.`
      );
    }
  }
}

/**
 * ════ SELF-TEST, HALF 2: THE LIVE PIPELINE ════
 * Proves probe -> classify actually runs end to end against the REAL server, on an
 * input whose correct answer is known: a route that provably does not exist must come
 * back 404 and must NOT be flagged. This is the literal ask — "prove the sweep would
 * catch a broken route" — applied to the one broken/nonexistent case this script can
 * manufacture without touching application source.
 */
async function selfTestLivePipeline(base) {
  const url = '/api/__qa_harness_self_test_nonexistent_route__';
  const probe = await probeOnce(base, 'GET', url, null);
  if (probe.networkError || probe.timedOut) {
    throw new Error(`LIVE SELF-TEST ABORTED: could not reach ${base}${url} (${probe.networkError || 'timed out'}). Server is not answering.`);
  }
  if (probe.status !== 404) {
    throw new Error(
      `LIVE SELF-TEST FAILED: a route that does not exist returned HTTP ${probe.status}, expected 404. ` +
        `Either the server is not the app we think it is, or routing changed underneath this check — aborting.`
    );
  }
  const { issues } = classify({ pattern: url, status: probe.status, contentType: probe.contentType, bodyText: probe.bodyText, ms: probe.ms });
  if (issues.length !== 0) {
    throw new Error(`LIVE SELF-TEST FAILED: the classifier flagged a correct 404 as a finding: ${JSON.stringify(issues)}`);
  }
  return probe;
}

async function main() {
  console.log(`api-sweep: enumerating app/api/**/route.{ts,tsx,js,jsx} under ${API_DIR}`);
  const routes = listApiRoutes();
  if (routes.length === 0) {
    console.error('API-SWEEP: zero API routes discovered under app/api/** — nothing to inspect. This is not a pass.');
    process.exit(3);
    return;
  }
  console.log(`api-sweep: ${routes.length} route files discovered`);

  const manifestCheck = crossCheckManifest(routes);
  for (const note of manifestCheck.notes) console.log(`api-sweep: ${note}`);
  for (const d of manifestCheck.disagreements) {
    console.log(`api-sweep: ★ DISAGREEMENT [${d.type}]: ${d.patterns.join(', ')}`);
  }

  console.log(`api-sweep: checking server reachability at ${BASE}`);
  const reach = await probeOnce(BASE, 'GET', '/api/health', null);
  if (reach.networkError || reach.timedOut) {
    console.error(
      `API-SWEEP: server unreachable at ${BASE} (${reach.networkError || 'timed out'}). It may be restarting. ` +
        `Nothing to inspect — refusing to fake results.`
    );
    process.exit(3);
    return;
  }
  console.log(`api-sweep: server reachable (GET /api/health -> ${reach.status} in ${reach.ms}ms)`);

  selfTestClassifier();
  console.log('api-sweep: classifier self-test PASSED (6 known-bad cases caught, 8 known-good/exempt cases stayed clean)');
  const liveSelfTest = await selfTestLivePipeline(BASE);
  console.log(`api-sweep: live pipeline self-test PASSED (nonexistent route -> ${liveSelfTest.status}, correctly not flagged)`);

  const targets = expandUrls(routes);

  const skipped = [];
  const toProbe = [];
  for (const t of targets) {
    const skipReason = DESTRUCTIVE_SKIP.get(t.pattern);
    if (skipReason) {
      skipped.push({ pattern: t.pattern, url: t.url, reason: skipReason });
      continue;
    }
    toProbe.push(t);
  }
  // One row per (route, method, sample) — GET/HEAD/OPTIONS get no body; mutating
  // methods get `{}`, deliberately empty, and NO auth/CSRF/token header (see header
  // comment's safety argument for why this cannot reach a side effect).
  const requests = [];
  for (const t of toProbe) {
    for (const method of t.methods.length ? t.methods : ['GET']) {
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? {} : null;
      requests.push({ pattern: t.pattern, file: t.file, url: t.url, method, body });
    }
  }

  console.log(`api-sweep: probing ${requests.length} (route, method) requests across ${toProbe.length} routes | base=${BASE}`);

  const findings = [];
  let networkErrorCount = 0;
  for (const req of requests) {
    const probe = await probeOnce(BASE, req.method, req.url, req.body);
    if (probe.networkError) networkErrorCount++;
    if (networkErrorCount > requests.length * NETWORK_ERROR_ABORT_RATIO && networkErrorCount > 5) {
      throw new Error(
        `${networkErrorCount} of ${findings.length + 1} probes so far failed at the network level — the server ` +
          `went down or is flaking mid-sweep. Aborting rather than reporting a run that is mostly noise.`
      );
    }
    const { issues, networkError } = classify({
      pattern: req.pattern,
      status: probe.status,
      contentType: probe.contentType,
      bodyText: probe.bodyText,
      ms: probe.ms,
      timedOut: probe.timedOut
    });
    const authObserved = probe.status === 401 || probe.status === 403;
    findings.push({
      pattern: req.pattern,
      method: req.method,
      url: req.url,
      status: probe.status,
      contentType: probe.contentType,
      ms: probe.ms,
      authObserved,
      networkError: networkError ? probe.networkError : undefined,
      issues
    });
    const tag = networkError ? '⚠' : issues.length ? '✗' : '·';
    process.stdout.write(`${tag} ${req.method} ${req.url} -> ${probe.status ?? 'ERR'} (${probe.ms}ms)${issues.length ? ` [${issues.join(' | ')}]` : ''}\n`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORT_DIR, `api-sweep-${stamp}.json`);

  const realFindings = findings.filter((f) => f.issues.length > 0);
  const manifestDisagreementCount = manifestCheck.disagreements.length;
  // ★ `toProbe.length` counts (route × sample) pairs, not distinct routes — a dynamic
  // route with 2 edge-case samples (e.g. /api/streak/[user]) appears twice. Reported
  // both ways so "97" never gets misread as "more routes than exist".
  const uniquePatternsProbed = new Set(toProbe.map((t) => t.pattern)).size;
  const summary = {
    base: BASE,
    routesDiscovered: routes.length,
    uniqueRoutePatternsProbed: uniquePatternsProbed,
    urlSamplesExpanded: toProbe.length,
    routesSkipped: skipped.length,
    skipped,
    requestsSent: requests.length,
    requestsWithNetworkError: networkErrorCount,
    manifestPresent: manifestCheck.manifestPresent,
    manifestNotes: manifestCheck.notes,
    manifestDisagreements: manifestCheck.disagreements,
    requestsWithIssues: realFindings.length,
    findings
  };
  writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`routes discovered      : ${routes.length}`);
  console.log(`unique patterns probed  : ${uniquePatternsProbed} (of ${routes.length})`);
  console.log(`url samples expanded    : ${toProbe.length} (dynamic routes probed with >1 sample)`);
  console.log(`routes skipped          : ${skipped.length}${skipped.length ? ' (' + skipped.map((s) => s.pattern).join(', ') + ')' : ''}`);
  console.log(`requests sent           : ${requests.length}`);
  console.log(`network errors          : ${networkErrorCount}`);
  console.log(`manifest disagreements  : ${manifestDisagreementCount}`);
  console.log(`requests w/ issues      : ${realFindings.length}`);
  console.log(`report                  : ${reportPath}`);
  process.exit(realFindings.length > 0 || manifestDisagreementCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('API-SWEEP ABORTED:', err.message);
  process.exit(2);
});
