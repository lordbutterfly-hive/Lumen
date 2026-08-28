/**
 * LUMEN SURGICAL HARNESS
 * ======================
 *
 * One browser. Real numbers. No check may pass without a control that proves it
 * could have failed.
 *
 * Written 2026-08-15 after a night in which (a) the box hard-died twice from
 * concurrent browser fan-out, and (b) three separate "verified" claims turned
 * out to be curl output, a stale bundle, or an agent's self-report. Every rule
 * below is a scar.
 *
 * ─── THE FIVE RULES ────────────────────────────────────────────────────────
 *
 * 1. ONE BROWSER PER AGENT, ONE CONTEXT, REUSED.
 *    Two `next dev` servers plus several headless Chromes plus real recsys and
 *    Hive traffic is more than this box's 19GB holds. Measured: free memory hit
 *    143MB and the VM stopped. `openLumen()` gives you ONE browser; reuse its
 *    page across every check. Never call it twice in one script.
 *
 * 2. NEVER TRUST `QA_BASE`.
 *    Its default is https://localhost:3443, which for most of last night served
 *    an Aug-14 bundle containing NONE of the work under test. Pass the origin
 *    explicitly. `openLumen` refuses to start without one, and `fingerprint()`
 *    proves which build answered before you believe any number.
 *
 * 3. THE SESSION COOKIE TRAP.
 *    `qa-harness.mjs` mints cookies as `domain:'localhost', secure:true`. On an
 *    http origin the browser rejects them twice (domain mismatch + secure over
 *    http), the app sees an anonymous visitor, and it looks exactly like "login
 *    is broken". `openLumen` re-stamps them for the origin you asked for.
 *
 * 4. A CHECK WITH NO CONTROL IS NOT A PASS.
 *    `check()` requires a `control` — evidence the same probe reports failure
 *    when the thing is genuinely absent. Without it the result is recorded as
 *    VACUOUS, which counts as a failure. A green suite that cannot go red is
 *    worse than no suite.
 *
 * 5. MEASURE THE MARGIN.
 *    "It passed" hides "it passed by 1ms". Timings carry p50/p95 over repeats,
 *    and budgets record how much room was left.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────
 *
 *   import { openLumen, timed, check, pills, report, ROUTES }
 *     from '/home/clauderfly/hive-blog-rebuild/qa/harness/lumen-surgical.mjs';
 *
 *   const L = await openLumen({ origin: 'https://localhost:3443', loggedIn: true, label: 'ab' });
 *   await L.fingerprint();                       // prove WHICH build answered
 *   const t = await timed(L, '/');               // { ttfb, dcl, lcp, total, rendered }
 *   check('home renders posts', t.articles > 0, { control: 'a 404 route yields 0' });
 *   report('my lane');                           // exits non-zero if anything failed
 *   await L.close();
 *
 * Run it:
 *   cd /home/clauderfly/hive-blog-rebuild
 *   NODE_EXTRA_CA_CERTS=$PWD/.tls/cert.pem node /path/to/your-lane.mjs
 *
 * ★ `label` must be SHORT (<= 3 chars). The lite signup rejects long account
 *   names with `invalid_name: Account name should be shorter` and you will get a
 *   silently anonymous session.
 */

import { chromium } from 'playwright';

// ─── PERFORMANCE BUDGETS ────────────────────────────────────────────────────
// Anchored to the competitors this product is measured against, not invented.
// PeakD and Ecency are the bar; a production Lumen build should be inside these
// on a warm cache. Dev-server timings are MEANINGLESS here — a `next dev` route
// compiles on first hit (measured: 55s cold, 1.5s warm) — so only judge speed on
// a production build behind :3443.
export const BUDGET_MS = {
  ttfb: 600,
  domContentLoaded: 2500,
  lcp: 2500, // Core Web Vitals "good"
  total: 4000,
  apiFeed: 1500
};

// ─── THE ROUTE INVENTORY ────────────────────────────────────────────────────
// Every reader-facing surface. `auth` routes 307 to /login when signed out —
// that is CORRECT behaviour, not a failure.
export const ROUTES = [
  { path: '/', name: 'home', auth: false },
  { path: '/trending', name: 'trending', auth: false },
  { path: '/hot', name: 'hot', auth: false },
  { path: '/created', name: 'created', auth: false },
  { path: '/payout', name: 'payout', auth: false },
  { path: '/communities', name: 'communities', auth: false },
  { path: '/search?q=hive', name: 'search', auth: false },
  { path: '/creators', name: 'meritum-intro', auth: false },
  { path: '/creators/launch', name: 'meritum-launch', auth: true },
  { path: '/creators/launch/classic', name: 'launch-classic', auth: true },
  { path: '/creators/studio', name: 'creator-studio', auth: true },
  { path: '/wallet', name: 'wallet', auth: true },
  { path: '/wallet/tokens', name: 'wallet-tokens', auth: true },
  { path: '/profile', name: 'profile', auth: true },
  { path: '/login', name: 'login', auth: false }
];

/**
 * ★ TWO ROUTES REMOVED, 2026-08-15 — three independent lanes reported them as
 * 404s and each spent time deciding whether that was a product regression.
 *   `/settings`  — there is no bare settings route. It lives under the profile:
 *                  `app/[param]/(user-profile)/settings/page.tsx`, i.e.
 *                  `/@<account>/settings`. Added below as a template.
 *   `/welcome`   — no such directory exists anywhere under `apps/blog/app/`.
 * A harness that lists dead routes teaches every future lane to expect 404s and
 * eventually to ignore a real one.
 *
 * ★ ALSO WORTH KNOWING: `/trending`, `/hot`, `/created` and `/payout` all
 * 307-redirect to `/` at the middleware level regardless of auth — an owner
 * ruling dated 2026-08-08, "Lumen has one feed". They are kept in ROUTES on
 * purpose (the redirect itself is worth regression-testing) but do NOT read
 * them as four distinct surfaces.
 */

/** Routes that need an account name interpolated. Call with a bare handle. */
export const ACCOUNT_ROUTES = [
  { path: (a) => `/@${a}`, name: 'profile-page', auth: false },
  { path: (a) => `/@${a}/settings`, name: 'settings', auth: true }
];

const results = [];
let vacuousCount = 0;

// ─── OPEN ───────────────────────────────────────────────────────────────────

/**
 * One browser, one context, session cookies re-stamped for `origin`.
 * @param {{origin:string, loggedIn?:boolean, privateKey?:string, label?:string, viewport?:{width:number,height:number}}} opts
 */
export async function openLumen({
  origin,
  loggedIn = false,
  privateKey,
  label = 'sx',
  viewport = { width: 1440, height: 900 }
}) {
  if (!origin) throw new Error('openLumen: `origin` is required. Never rely on QA_BASE — its default is a stale bundle.');
  if (label.length > 3) throw new Error(`openLumen: label "${label}" too long; lite signup rejects long names. Use <= 3 chars.`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });

  let username = null;
  if (loggedIn) {
    process.env.QA_BASE = origin; // liteSession reads this to know where to sign up
    const { liteSession } = await import('/home/clauderfly/hive-blog-rebuild/qa-harness.mjs');
    // ★ A PUBLIC HARDHAT TEST KEY, not a secret (2026-08-28). This used to be a
    // privately generated throwaway, which is indistinguishable from a real key
    // to anyone reading the repo, and this file is committed. Hardhat account #2
    // from the standard "test test ... junk" mnemonic is published in Hardhat's
    // own docs and controls nothing. QA identities only ever hold a lite account.
    const s = await liteSession(
      privateKey || '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      label
    );
    username = s.username;
    // RULE 3: re-stamp for THIS origin, or the app sees an anonymous visitor.
    const isHttps = origin.startsWith('https://');
    const host = new URL(origin).hostname;
    await ctx.addCookies(
      s.cookies.map((c) => ({ name: c.name, value: c.value, domain: host, path: '/', secure: isHttps }))
    );
  }

  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const hydrationErrors = [];
  page.on('pageerror', (e) => {
    const t = String(e).slice(0, 300);
    consoleErrors.push(t);
    if (/[Hh]ydrat/.test(t)) hydrationErrors.push(t);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().slice(0, 300);
    consoleErrors.push(t);
    if (/[Hh]ydrat/.test(t)) hydrationErrors.push(t);
  });
  page.on('requestfailed', (r) =>
    failedRequests.push(`${r.method()} ${r.url().slice(0, 100)} — ${r.failure()?.errorText}`)
  );
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 100)}`);
  });

  const L = {
    browser, ctx, page, origin, username,
    consoleErrors, failedRequests, hydrationErrors,
    close: () => browser.close(),
    /**
     * RULE 2: prove which build answered before believing anything.
     *
     * ★ THERE IS NO CLIENT-VISIBLE BUILD ID ON THIS APP, AND PRETENDING OTHERWISE
     * IS WORSE THAN NOT CHECKING. `window.__NEXT_DATA__` is Pages Router only.
     * App Router does not emit `_buildManifest.js` into the HTML either —
     * measured on this build, the only `/_next/static/` paths served are
     * `chunks`, `css` and `media`. So `buildId` will normally be null here and
     * that is NOT a failure.
     *
     * What actually answers the question "am I on a build containing tonight's
     * work?" is CONTENT: `saysMeritum > 0` and `saysCreatorToken === 0`. The
     * Aug-14 bundle had those reversed. `assetHash` additionally gives a stable
     * per-build value — the same build always produces the same hash, so two
     * runs can be compared even though the number itself means nothing alone.
     *
     * ASSERT ON `saysMeritum`, not on `buildId`.
     */
    async fingerprint() {
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      const fp = await page.evaluate(() => {
        let buildId = (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId) || null;
        if (!buildId) {
          const urls = [
            ...[...document.querySelectorAll('script[src]')].map((s) => s.src),
            ...[...document.querySelectorAll('link[href]')].map((l) => l.href)
          ];
          for (const u of urls) {
            const m = u.match(/\/_next\/static\/([^/]+)\/(_buildManifest|_ssgManifest)/);
            if (m) { buildId = m[1]; break; }
          }
          if (!buildId) {
            for (const u of urls) {
              const m = u.match(/\/_next\/static\/(?!chunks|css|media|development)([A-Za-z0-9_-]{8,})\//);
              if (m) { buildId = m[1]; break; }
            }
          }
        }
        // Stable per-build value: the sorted set of chunk filenames, hashed.
        // Same build -> same hash. Lets two runs prove they saw the same code
        // even with no build id to read.
        const chunks = [...document.querySelectorAll('script[src]')]
          .map((s) => (s.src.match(/\/_next\/static\/chunks\/(.+)$/) || [])[1])
          .filter(Boolean)
          .sort();
        let h = 0;
        for (const c of chunks) for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) | 0;
        return {
          buildId, // normally null on App Router — do not assert on it
          assetHash: (h >>> 0).toString(16),
          chunkCount: chunks.length,
          dev: [...document.querySelectorAll('script[src]')].some((s) => /\/_next\/static\/(development|chunks\/webpack\.js\?v=)/.test(s.src)),
          title: document.title,
          saysMeritum: (document.body.innerText.match(/Meritum/g) || []).length,
          saysCreatorToken: (document.body.innerText.match(/creator token/gi) || []).length
        };
      });
      fp.origin = origin;
      fp.signedInAs = username;
      L.build = fp;
      return fp;
    }
  };
  return L;
}

// ─── TIMING ─────────────────────────────────────────────────────────────────

/**
 * Navigate and measure. Returns real browser timings, not wall clock guesses.
 * `repeat > 1` gives p50/p95 so one slow sample cannot masquerade as a trend.
 */
export async function timed(L, path, { repeat = 1, timeout = 120000, settleMs = 1200 } = {}) {
  const samples = [];
  let last = null;
  for (let i = 0; i < repeat; i++) {
    // ★ LCP MUST BE OBSERVED, NOT QUERIED AFTER THE FACT. Chrome only surfaces
    // `largest-contentful-paint` entries to a PerformanceObserver; a later
    // `getEntriesByType(...)` returns [] and you silently record lcp = 0, which
    // reads as "instant" when it actually means "not measured". Arm a buffered
    // observer BEFORE navigating and stash the value on window.
    await L.page.addInitScript(() => {
      window.__lcp = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__lcp = Math.round(e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
    });
    const res = await L.page.goto(L.origin + path, { waitUntil: 'domcontentloaded', timeout });
    await L.page.waitForTimeout(settleMs);
    const m = await L.page.evaluate(
      () =>
        new Promise((resolve) => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          // Set by the buffered observer armed in addInitScript. 0 means genuinely
          // no LCP candidate (e.g. an empty 404), not "we forgot to measure".
          const lcp = typeof window.__lcp === 'number' ? window.__lcp : 0;
          resolve({
            ttfb: Math.round(nav.responseStart || 0),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
            total: Math.round(nav.loadEventEnd || nav.duration || 0),
            lcp,
            transferKB: Math.round(
              performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), 0) / 1024
            ),
            requests: performance.getEntriesByType('resource').length
          });
        })
    );
    const dom = await L.page.evaluate(() => ({
      articles: document.querySelectorAll('article').length,
      postLinks: document.querySelectorAll('a[href*="/@"]').length,
      h1: [...document.querySelectorAll('h1')].map((e) => e.innerText.trim().slice(0, 60)),
      textLen: (document.body.innerText || '').length
    }));
    last = { path, status: res && res.status(), url: L.page.url(), ...m, ...dom };
    samples.push(m);
  }
  const pick = (k) => samples.map((s) => s[k]).sort((a, b) => a - b);
  const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
  last.p50 = { ttfb: p(pick('ttfb'), 0.5), lcp: p(pick('lcp'), 0.5), total: p(pick('total'), 0.5) };
  last.p95 = { ttfb: p(pick('ttfb'), 0.95), lcp: p(pick('lcp'), 0.95), total: p(pick('total'), 0.95) };
  last.repeat = repeat;
  return last;
}

/** Budget check that records the MARGIN, not just pass/fail (RULE 5). */
export function budget(name, actualMs, budgetMs, control) {
  const margin = budgetMs - actualMs;
  return check(
    `${name} within ${budgetMs}ms`,
    actualMs > 0 && actualMs <= budgetMs,
    { control, detail: `${actualMs}ms, margin ${margin}ms (${Math.round((margin / budgetMs) * 100)}%)` }
  );
}

// ─── PILLS ──────────────────────────────────────────────────────────────────

/**
 * Enumerate every pill/badge/chip on the page with the computed values that
 * decide whether it is right: text, colours, radius, size, contrast.
 * A "pill" here is any small rounded element carrying short text.
 */
export async function pills(L) {
  return L.page.evaluate(() => {
    const lum = (rgb) => {
      const m = (rgb || '').match(/\d+(\.\d+)?/g);
      if (!m) return null;
      const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (fg, bg) => {
      const a = lum(fg), b = lum(bg);
      if (a == null || b == null) return null;
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const bgOf = (el) => {
      let n = el;
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        n = n.parentElement;
      }
      return 'rgb(255, 255, 255)';
    };
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const radius = parseFloat(cs.borderRadius) || 0;
      const text = (el.innerText || '').trim();
      const rounded = radius >= 9 || cs.borderRadius.includes('%') || radius / Math.max(1, r.height) >= 0.35;
      const pillish = rounded && r.height > 0 && r.height <= 48 && r.width <= 420 && text.length > 0 && text.length <= 40;
      if (!pillish || el.children.length > 3) continue;
      out.push({
        text: text.slice(0, 40),
        tag: el.tagName.toLowerCase(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        radius: cs.borderRadius,
        color: cs.color,
        bg: bgOf(el),
        contrast: contrast(cs.color, bgOf(el)),
        fontSize: cs.fontSize,
        clipped: el.scrollWidth > el.clientWidth + 1,
        offscreen: r.left < 0 || r.right > document.documentElement.clientWidth + 1
      });
    }
    // de-dupe identical pills
    const seen = new Set();
    return out.filter((p) => {
      const k = `${p.text}|${p.w}x${p.h}|${p.bg}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

// ─── CHECKS ─────────────────────────────────────────────────────────────────

/**
 * RULE 4. `control` is mandatory: state how you know this probe can report
 * failure. Omit it and the check is recorded VACUOUS, which fails the run.
 */
export function check(name, passed, { control, detail } = {}) {
  if (!control) {
    vacuousCount++;
    results.push({ name, state: 'VACUOUS', detail: detail || '', control: '(none given)' });
    return false;
  }
  results.push({ name, state: passed ? 'PASS' : 'FAIL', detail: detail || '', control });
  return passed;
}

/** Record something observed without asserting on it. Never counts as a pass. */
export function note(name, detail) {
  results.push({ name, state: 'NOTE', detail: String(detail).slice(0, 300), control: '—' });
}

export function report(title) {
  const pass = results.filter((r) => r.state === 'PASS').length;
  const fail = results.filter((r) => r.state === 'FAIL').length;
  const vac = results.filter((r) => r.state === 'VACUOUS').length;
  const notes = results.filter((r) => r.state === 'NOTE').length;
  const lines = [
    '',
    `═══ ${title} ═══`,
    `PASS ${pass}   FAIL ${fail}   VACUOUS ${vac}   NOTE ${notes}`,
    ''
  ];
  for (const r of results) {
    lines.push(`[${r.state}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
    if (r.state === 'FAIL' || r.state === 'VACUOUS') lines.push(`         control: ${r.control}`);
  }
  if (vac) lines.push('', `★ ${vac} VACUOUS check(s): a check with no control is not a pass. Treated as failure.`);
  console.log(lines.join('\n'));
  return { pass, fail, vacuous: vac, notes, ok: fail === 0 && vac === 0 };
}

export function resultsRaw() {
  return results;
}
