/**
 * ★★★ SHARED TEST HARNESS FOR THE FEED WAVE (2026-08-15).
 *
 * Written because five agents were about to verify three interacting features
 * and would otherwise each invent their own "did it render?" check. Every
 * defect this session produced came from a check that could not fail:
 *   - a wallet test that passed because the page had not finished loading;
 *   - a grep piped through `head` that "proved" a live API route was dead;
 *   - a cron health check that could only ever print HEALTHY;
 *   - an impression counter that counted polls and would have buried 45% of
 *     every feed on day one.
 * So the primitives here REFUSE to answer until the page has real content, and
 * every assertion carries the control that makes it non-vacuous.
 *
 * IT DOES NOT START SERVERS. A subagent that backgrounds a long-running command
 * stalls forever, so the parent boots the dev servers and passes their ports in.
 */
import { chromium } from '/home/clauderfly/hive-blog-rebuild/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';

export const CHROME = '/home/clauderfly/opt/chrome-root/opt/google/chrome/chrome';
export const PG_CONTAINER = 'lumen-b12-pg';

/** Chrome on this box needs --no-sandbox; headed only helps a human. */
export async function launch({ headless = true } = {}) {
  return chromium.launch({ executablePath: CHROME, headless, args: ['--no-sandbox'] });
}

/**
 * A signed-in context. Cookies bind to `localhost`, NOT `127.0.0.1` — a context
 * pointed at 127.0.0.1 renders signed-out and every auth-gated assertion then
 * passes vacuously. Always navigate to http://localhost:<port>.
 */
export async function signedInContext(browser, storageStatePath) {
  return browser.newContext({ storageState: storageStatePath });
}

/** Raw SQL against a database in the local Postgres container. */
export function sql(db, statement) {
  return execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', 'qa', '-d', db, '-tAc', statement],
    { encoding: 'utf8', timeout: 60000 }
  ).trim();
}
export const lite = (s) => sql('lite', s);
export const recsysdb = (s) => sql('recsys', s);

/** Impressions recorded for a viewer — the number the suppression rule keys on. */
export function impressionCount(viewer) {
  return Number(lite(`select count(*) from lumen_feed_served where viewer='${viewer}'`) || 0);
}
export function feedRowBuiltAt(viewer) {
  return lite(`select coalesce(max(built_at)::text,'') from lumen_feed_store where viewer='${viewer}'`);
}

/**
 * Navigate and WAIT FOR REAL CONTENT. Returns {ok,articles,bodyLen,url}.
 *
 * ★ `ok:false` is a hard stop for the caller: in dev the feed takes ~30s
 * (real chain calls) and the wallet ~30s, so a short wait reports an empty page
 * that is indistinguishable from a broken one. Never assert on a page whose
 * `ok` is false — report NOT-RENDERED instead, which is an honest failure.
 */
export async function render(page, url, { minArticles = 1, timeoutMs = 90000, settleMs = 1500 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let last = { articles: 0, bodyLen: 0 };
  while (Date.now() < deadline) {
    last = await page.evaluate(() => ({
      articles: document.querySelectorAll('article').length,
      bodyLen: document.body.innerText.length
    }));
    if (last.articles >= minArticles) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(settleMs);
  return { ok: last.articles >= minArticles, ...last, url: page.url() };
}

/**
 * Collect feed API traffic, split by whether it COUNTS as an impression.
 * `probe=1` is the non-counting poll introduced 2026-08-15; if this split ever
 * reads 0 probes over a poll interval, the poll is counting again.
 */
export function captureFeedTraffic(page) {
  const all = [];
  page.on('request', (r) => {
    const url = r.url();
    if (url.includes('/api/feed/')) all.push({ url, probe: url.includes('probe=1'), at: Date.now() });
  });
  return {
    all,
    probes: () => all.filter((r) => r.probe),
    counting: () => all.filter((r) => !r.probe),
    warm: () => all.filter((r) => r.url.includes('/api/feed/warm'))
  };
}

/** Page-level JS errors. A silent console error is how a "working" page lies. */
export function captureErrors(page) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 200));
  });
  return errs;
}

/** Computed colour of the first element matching `selector`. */
export async function colourOf(page, selector, prop = 'backgroundColor') {
  return page.evaluate(
    ([sel, p]) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[p] : null;
    },
    [selector, prop]
  );
}

/** Layout faults at the current viewport: overflow, clipping, overlap. */
export async function layoutFaults(page) {
  return page.evaluate(() => {
    const out = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, past: [], clipped: [] };
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1) out.past.push((el.textContent || '').trim().slice(0, 30));
      if (!el.children.length && el.textContent?.trim() && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
        out.clipped.push((el.textContent || '').trim().slice(0, 30));
    }
    out.past = out.past.slice(0, 8);
    out.clipped = out.clipped.slice(0, 8);
    return out;
  });
}

/**
 * A results collector that forces the shape of an honest report.
 *
 * `check(name, pass, detail)` records a claim. `control(name, pass, detail)`
 * records the PROOF THAT THE CHECK COULD HAVE FAILED. `report()` refuses to
 * print an overall PASS when a check has no control — an unfalsifiable green is
 * exactly what this session kept catching.
 */
export function results(title) {
  const checks = [];
  const controls = new Set();
  return {
    check(name, pass, detail = '') {
      checks.push({ name, pass: !!pass, detail });
      return !!pass;
    },
    control(name, pass, detail = '') {
      controls.add(name);
      checks.push({ name: `CONTROL: ${name}`, pass: !!pass, detail, isControl: true });
      return !!pass;
    },
    note(text) {
      checks.push({ name: 'NOTE', pass: true, detail: text, isNote: true });
    },
    report() {
      console.log(`\n===== ${title} =====`);
      for (const c of checks) {
        if (c.isNote) {
          console.log(`  note   ${c.detail}`);
          continue;
        }
        console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
      }
      const real = checks.filter((c) => !c.isControl && !c.isNote);
      const failed = checks.filter((c) => !c.pass);
      const uncontrolled = real.filter((c) => !controls.has(c.name)).map((c) => c.name);
      if (uncontrolled.length) {
        console.log(`  !! ${uncontrolled.length} check(s) have NO CONTROL proving they can fail: ${uncontrolled.join(', ')}`);
      }
      const verdict = failed.length === 0 && uncontrolled.length === 0 ? 'PASS' : failed.length ? 'FAIL' : 'INCONCLUSIVE (uncontrolled)';
      console.log(`  VERDICT: ${verdict}`);
      return verdict;
    }
  };
}
