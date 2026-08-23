/**
 * ════ THE SWEEP ════
 *
 * Visits every page the app has, in each requested auth state, and runs every blanket
 * detector against it. One browser, one pass, a JSON report.
 *
 * RUN IT (against a PRODUCTION build, never `next dev`):
 *   NEXT_DIST_DIR=.next-qa pnpm start          # in one shell
 *   node qa/harness/sweep.mjs --state=anon
 *   node qa/harness/sweep.mjs --state=auth --user=lordbutterfly
 *   node qa/harness/sweep.mjs --state=anon --viewport=390x844
 *
 * ★★★ PRODUCTION BUILD, NOT DEV. `next dev` compiles per route on first hit (measured
 * on this repo at 45.8s/route against 0.84s on prod), intercepts errors with its own
 * overlay before they reach the real `error.tsx`, and has different hydration timing.
 * A sweep against dev measures the dev server, not the app.
 *
 * ════ WHAT MAKES THIS HARNESS HARD TO FAKE ════
 *
 * Every one of these is a property an agent (me included) would otherwise be able to
 * satisfy by doing nothing:
 *
 *  1. The route list is derived from the filesystem and cross-checked against
 *     `EXPECTED_PAGE_COUNT`. Sweeping a subset and calling it "every page" fails loudly.
 *  2. A dynamic route with no sample is a hard error, not a skip.
 *  3. Every page must render something (`elementsInspected > 0`, body text over a floor)
 *     or it is a FAILURE — a blank page cannot be recorded as clean.
 *  4. The IACVT detector self-tests against a known-bad and a known-good fixture before
 *     the sweep runs. If it has stopped detecting, the run aborts rather than reporting
 *     zero findings.
 *  5. Counts of pages visited and checks executed are in the report. A run that
 *     inspected nothing cannot look like a run that found nothing.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSweepUrls, listPagePatterns, EXPECTED_PAGE_COUNT, isAuthRequired, expectsNotFound, isShadowed, SHADOWED_BY_REDIRECT } from './routes.mjs';
import {
  attachConsoleCapture,
  attachNetworkCapture,
  inspectPage,
  findHeadingJumps,
  findBrokenImages
} from './detectors/page-checks.mjs';
import {
  findBareVarColourUses,
  probeInPage,
  SELF_TEST_CSS,
  SELF_TEST_CANDIDATES,
  assertSelfTest
} from './detectors/css-iacvt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, 'reports');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.base || 'http://127.0.0.1:3000';
const STATE = args.state || 'anon';
const [VW, VH] = String(args.viewport || '1440x900').split('x').map(Number);
/**
 * How many clipped elements a page may have before it is reported.
 *
 * Not zero: `text-overflow: ellipsis` is a legitimate, common choice, and a
 * zero-tolerance rule would fire on every feed card. Above this, the page is clipping
 * enough that a copy or translation change has plausibly broken something.
 */
const TRUNCATION_FLOOR = 6;

const CHROME = process.env.HARNESS_CHROME || '/home/clauderfly/opt/chrome-root/opt/google/chrome/chrome';

/**
 * Mint a real session cookie for the running server.
 *
 * ★ TWO-SIDED, AND THE SECOND SIDE IS EASY TO MISS. The iron-session cookie satisfies
 * the server, but `useUserCore` hydrates from `localStorage['user']` with
 * `refetchOnMount: false` — so seeding only the cookie leaves the UI in anonymous state
 * while the server thinks you are signed in, and every signed-in surface silently does
 * not render. The repo's own fixture seeder documents this; the sweep reuses the lesson
 * rather than rediscovering it.
 */
async function seedSession(context, username) {
  const { sealData } = await import('iron-session');
  const envPath = join(HERE, '..', '..', '.env.local');
  const env = readFileSync(envPath, 'utf8');
  const password = env.match(/^DENSER_SERVER_SECRET_COOKIE_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!password) throw new Error('DENSER_SERVER_SECRET_COOKIE_PASSWORD not found in .env.local');

  const user = {
    isLoggedIn: true,
    username,
    avatarUrl: '',
    loginType: 'keychain',
    keyType: 'posting',
    authenticateOnBackend: false,
    strict: false
  };
  const sealed = await sealData({ user, hiveSessionIssuedAt: Date.now() }, { password, ttl: 0 });
  const host = new URL(BASE).hostname;
  await context.addCookies([
    { name: 'app_session', value: sealed, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }
  ]);
  await context.addInitScript((u) => {
    try {
      window.localStorage.setItem('user', JSON.stringify(u));
    } catch {
      /* storage unavailable — the cookie half still works */
    }
  }, user);
  return user;
}

async function main() {
  const patterns = listPagePatterns();
  if (patterns.length !== EXPECTED_PAGE_COUNT) {
    // ★★★ A HARD FAILURE, NOT A WARNING (fixed 2026-08-18, adversarial review).
    //
    // This used to `console.warn` and carry on. A reviewer proved the consequence: delete
    // one page, and the sweep silently narrows to the remaining routes, they all pass, and
    // it exits 0 with "pages inspected: 24/24" on the console. An agent reading the exit
    // code or that line sees a clean run over a route list that quietly shrank — which is
    // precisely the failure `routes.mjs`'s own header says this file exists to prevent.
    // Warning about the thing you exist to stop is not stopping it.
    throw new Error(
      `route count drift: found ${patterns.length} page patterns, EXPECTED_PAGE_COUNT is ${EXPECTED_PAGE_COUNT}.\n` +
        `Coverage has changed. Update EXPECTED_PAGE_COUNT in routes.mjs deliberately and say why in the commit — ` +
        `do not let a sweep over a different route list report as if nothing moved.`
    );
  }
  const targets = listSweepUrls();

  // The app's real top-level i18n namespaces, so "raw i18n key" means a key from THIS
  // catalogue rather than any dotted string (a community handle like `run.vince.run`
  // has the same shape and was flagged on the first run).
  const i18nNamespaces = Object.keys(
    JSON.parse(readFileSync(join(HERE, '..', '..', 'locales', 'en', 'common_blog.json'), 'utf8'))
  );
  if (i18nNamespaces.length === 0) throw new Error('i18n catalogue empty — the raw-key check would be vacuous');
  console.log(`sweep: ${targets.length} urls from ${patterns.length} page patterns | state=${STATE} | ${VW}x${VH}`);

  // ★ THE STATIC HALF OF THE IACVT DETECTOR, over the whole source tree, once.
  const { execSync } = await import('node:child_process');
  const srcFiles = execSync(
    `find ${join(HERE, '..', '..')} ${join(HERE, '..', '..', '..', '..', 'packages')} -type f ` +
      `\\( -name '*.tsx' -o -name '*.ts' -o -name '*.css' \\) -not -path '*/node_modules/*' -not -path '*/.next*'`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\n')
    .filter(Boolean);
  if (srcFiles.length < 100) throw new Error(`source scan found only ${srcFiles.length} files — the glob is broken`);
  const iacvtCandidates = [];
  for (const f of srcFiles) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const hit of findBareVarColourUses(src)) iacvtCandidates.push({ ...hit, file: f });
  }
  console.log(`iacvt: ${srcFiles.length} source files scanned, ${iacvtCandidates.length} bare var() colour candidates`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: VW, height: VH } });
  if (STATE === 'auth') await seedSession(context, args.user || 'lordbutterfly');

  // ★★ SELF-TEST BEFORE ANYTHING ELSE. A detector that has stopped detecting reports a
  // clean sweep forever, which is indistinguishable from success. Prove it still bites.
  {
    const probe = await context.newPage();
    await probe.setContent(`<style>${SELF_TEST_CSS}</style><div class="harness-known-bad">a</div><div class="harness-known-good">b</div>`);
    const selfResults = await probe.evaluate(probeInPage, SELF_TEST_CANDIDATES);
    assertSelfTest(selfResults); // throws and aborts the run if broken
    await probe.close();
    console.log('iacvt: self-test PASSED (known-bad caught, known-good clean)');
  }

  const findings = [];
  let pagesInspected = 0;
  let checksRun = 0;

  for (const { pattern, url } of targets) {
    const page = await context.newPage();
    const console_ = attachConsoleCapture(page);
    const net = attachNetworkCapture(page);
    const issues = [];
    let status = null;
    let ms = 0;

    try {
      const t0 = Date.now();
      const res = await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      ms = Date.now() - t0;
      status = res?.status() ?? null;
      // Client-fetched rail/feed content needs a beat; without it every signed-in
      // surface reads as missing and the sweep reports phantom failures.
      await page.waitForTimeout(3500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);

      const info = await page.evaluate(inspectPage, i18nNamespaces);
      const broken = await page.evaluate(findBrokenImages);
      const iacvt = iacvtCandidates.length
        ? await page.evaluate(probeInPage, iacvtCandidates.map(({ property, variable }) => ({ property, variable })))
        : [];
      checksRun += 12;

      // ★ AN EMPTY PAGE IS A FAILURE, NOT A CLEAN RESULT.
      const authGated = isAuthRequired(pattern) && STATE === 'anon';
      if (info.elementsInspected === 0) issues.push('FATAL: page rendered zero elements');
      else if (info.bodyTextLength < 40 && !authGated) issues.push(`FATAL: page rendered almost no text (${info.bodyTextLength} chars)`);

      // A deliberate not-found sample must not be punished for being not-found — that
      // would push whoever maintains this to delete the edge case, i.e. the coverage.
      const wantNotFound = expectsNotFound(url);
      if (status && status >= 400 && !(wantNotFound && status === 404)) issues.push(`http ${status}`);
      if (wantNotFound && status === 200) issues.push('expected 404 but got 200 — the not-found path is not being taken');
      if (console_.hydration.length) issues.push(`hydration mismatch: ${console_.hydration[0].slice(0, 120)}`);
      const realErrors = wantNotFound
        ? console_.errors.filter((e) => !/status of 404/.test(e))
        : console_.errors;
      if (realErrors.length) issues.push(`console errors: ${realErrors.slice(0, 3).join(' | ').slice(0, 240)}`);
      const realBad = wantNotFound ? net.badStatus.filter((b) => !b.startsWith('404 ')) : net.badStatus;
      if (realBad.length) issues.push(`bad requests: ${realBad.slice(0, 3).join(' | ')}`);
      if (net.failed.length) issues.push(`failed requests: ${net.failed.slice(0, 3).join(' | ')}`);
      if (info.overflow) issues.push(`horizontal overflow: ${info.overflowCulprits.slice(0, 3).join(', ')}`);
      if (info.zeroSizeInteractive.length) issues.push(`zero-size interactive: ${info.zeroSizeInteractive.slice(0, 3).join(', ')}`);
      // A genuinely covered control is a defect. One merely under a sticky bar at this
      // scroll position usually is not — reported, but not as an issue that fails a page.
      if (info.coveredInteractive.length) issues.push(`covered interactive: ${info.coveredInteractive.slice(0, 3).join(', ')}`);
      // D5 — a real, sized, clickable control rendering as nothing because a fade never
      // completed. Gated, not merely recorded: unlike a covered element (which a sticky
      // header explains) there is no benign reading of this one, and the exclusions in
      // page-checks.mjs already removed every state that could be mid-animation.
      if (info.phantomInteractive?.length)
        issues.push(`invisible (opacity:0) interactive: ${info.phantomInteractive.slice(0, 3).join(', ')}`);
      if (info.badText.length) issues.push(`bad text: ${info.badText.slice(0, 3).map((b) => `${b.why} "${b.text}"`).join(' | ')}`);
      if (broken.length) issues.push(`broken images: ${broken.slice(0, 3).join(', ')}`);
      if (iacvt.length) issues.push(`IACVT: ${iacvt.map((i) => `${i.property}:var(${i.variable})=${i.rawValue} -> ${i.computed}`).slice(0, 3).join(' | ')}`);

      // ★ TRUNCATION NOW GATES (fixed 2026-08-18). It was computed correctly and then
      // written to the JSON as a passive count that nothing read — so a real clipping bug
      // produced `truncatedCandidates: 7` alongside `issues: []`, i.e. clean by every
      // metric an agent is told to check. Gated above a floor because deliberate
      // `text-overflow: ellipsis` is common and a zero-tolerance rule would be noise.
      if (info.truncated.length > TRUNCATION_FLOOR) {
        issues.push(`text clipped (${info.truncated.length}): ${info.truncated.slice(0, 2).map((t) => `"${t}"`).join(', ')}`);
      }

      const jumps = findHeadingJumps(info.headings);
      if (jumps.length) issues.push(`heading jumps: ${jumps.slice(0, 3).join(', ')}`);
      if (!info.meta.title) issues.push('no <title>');
      if (!info.meta.lang) issues.push('no <html lang>');
      if (info.meta.h1Count === 0) issues.push('no <h1>');
      if (info.meta.h1Count > 1) issues.push(`${info.meta.h1Count} <h1> elements`);

      pagesInspected++;
      findings.push({
        pattern,
        url,
        status,
        ms,
        issues,
        elements: info.elementsInspected,
        truncatedCandidates: info.truncated.length,
        // Recorded, not gated — see the sticky note in page-checks.mjs.
        underStickyOverlay: info.underStickyOverlay
      });
    } catch (err) {
      findings.push({ pattern, url, status, ms, issues: [`FATAL: ${String(err).slice(0, 200)}`], elements: 0 });
    } finally {
      await page.close();
    }

    const bad = findings[findings.length - 1].issues.length;
    process.stdout.write(bad ? `✗ ${url} (${bad})\n` : `· ${url}\n`);
  }

  await browser.close();

  // ★ A RUN THAT INSPECTED NOTHING MUST NOT LOOK LIKE A RUN THAT FOUND NOTHING.
  if (pagesInspected === 0) throw new Error('sweep inspected ZERO pages — the run proves nothing. Failing.');

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORT_DIR, `sweep-${STATE}-${VW}x${VH}-${stamp}.json`);
  // ★ REACHABLE PAGES, NOT FILE COUNT. 15 page.tsx files are shadowed by config-level
  // redirects and can never render; counting them as coverage inflates the claim.
  const shadowedVisited = findings.filter((f) => isShadowed(f.pattern)).length;
  const summary = {
    base: BASE,
    reachablePagePatterns: patterns.length - SHADOWED_BY_REDIRECT.length,
    shadowedByRedirect: SHADOWED_BY_REDIRECT.length,
    shadowedUrlsVisited: shadowedVisited,
    state: STATE,
    viewport: `${VW}x${VH}`,
    patternsFound: patterns.length,
    expectedPatterns: EXPECTED_PAGE_COUNT,
    urlsVisited: targets.length,
    pagesInspected,
    checksRun,
    iacvtCandidates: iacvtCandidates.length,
    pagesWithIssues: findings.filter((f) => f.issues.length).length,
    findings
  };
  writeFileSync(reportPath, JSON.stringify(summary, null, 2));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`pages inspected : ${pagesInspected}/${targets.length}`);
  console.log(`  of which shadowed by a redirect (not real coverage): ${shadowedVisited}`);
  console.log(`reachable page patterns: ${patterns.length - SHADOWED_BY_REDIRECT.length} of ${patterns.length} files`);
  console.log(`checks run      : ${checksRun}`);
  console.log(`pages w/ issues : ${summary.pagesWithIssues}`);
  console.log(`report          : ${reportPath}`);
  process.exit(summary.pagesWithIssues > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('SWEEP ABORTED:', err.message);
  process.exit(2);
});
