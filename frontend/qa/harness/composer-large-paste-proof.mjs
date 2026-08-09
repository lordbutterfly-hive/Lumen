/**
 * THE COMPOSER MUST SURVIVE A HUGE PASTE, AND MUST NEVER LOSE A DRAFT QUIETLY.
 *
 * ★ Two defects, one report (2026-08-09): "4–5MB paste hangs the composer tab,
 * total draft loss, no warning". They are separate faults that compound.
 *
 *   1. THE HANG. `handlePostAreaChange` called `setPreviewContent` on every
 *      keystroke and on paste, handing the whole document to the markdown
 *      renderer synchronously. Debouncing fixes repetition; it does nothing for
 *      a single multi-megabyte paste, which still renders once and never
 *      returns. Both a debounce AND a size limit were needed.
 *   2. THE SILENT LOSS. Auto-save writes the body to localStorage every 500 ms
 *      through `setStorageItem`, which caught `QuotaExceededError` and returned
 *      `void` — so a draft too large to store looked exactly like a stored one.
 *      The write reports back now, and the editor says so.
 *
 * What this measures, at the served output:
 *   a. the tab is still ALIVE after the paste (the main thread answers), which
 *      is the difference between "slow" and "your work is gone";
 *   b. the editor kept the text (nothing truncated it away);
 *   c. the preview refused to render it rather than freezing;
 *   d. either the draft really is in localStorage, or the warning is on screen —
 *      what must never happen is neither.
 *
 * (d) is the honest assertion. Whether a given payload fits in a browser's
 * storage budget is not ours to promise; never lying about it is.
 *
 * Usage: node qa/harness/composer-large-paste-proof.mjs
 */
import { chromium } from '@playwright/test';
import { signedInStorageState } from './session.mjs';

const BASE = process.env.QA_BASE ?? 'https://localhost:3443';
const USERNAME = process.env.QA_USERNAME ?? 'hbd-temp';
const PASTE_MB = Number(process.env.QA_PASTE_MB ?? 5);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(60)} — ${detail}`);
}

// A realistic body: paragraphs of prose, not one giant token, so the markdown
// renderer has genuine structure to walk rather than a degenerate single line.
const paragraph =
  'The quick brown fox jumps over the lazy dog, and then writes a very long post about it. ';
const target = PASTE_MB * 1024 * 1024;
let big = '';
while (big.length < target) big += paragraph.repeat(50) + '\n\n';
big = big.slice(0, target);

const storageState = await signedInStorageState(USERNAME);
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState });
const page = await context.newPage();

let fatal = null;
try {
  await page.goto(`${BASE}/submit.html`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const editor = page.locator('.cm-content');
  await editor.waitFor({ state: 'visible', timeout: 45_000 });
  check('composer rendered (fixture is not empty)', true, 'CodeMirror editor present');

  // A real paste event carrying real clipboard data — the path the reader takes.
  await page.evaluate((text) => {
    const cm = document.querySelector('.cm-content');
    cm.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    cm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, big);

  // ── (a) IS THE TAB STILL ALIVE? ────────────────────────────────────────────
  // A frozen main thread cannot answer this, so the timeout IS the assertion.
  const started = Date.now();
  let alive = false;
  try {
    await page.evaluate(() => document.title, { timeout: 20_000 });
    alive = true;
  } catch {
    alive = false;
  }
  check(
    `the tab is still responsive after a ${PASTE_MB}MB paste`,
    alive,
    alive ? `main thread answered in ${Date.now() - started}ms` : 'main thread never came back — frozen'
  );
  if (!alive) throw new Error('tab froze; the remaining checks cannot be measured');

  // Let the 300ms editor debounce and the 500ms auto-save both have their turn.
  await page.waitForTimeout(6000);

  // ── (b) DID THE EDITOR KEEP THE TEXT? ──────────────────────────────────────
  // ★ NOT via `.cm-content.textContent`. CodeMirror 6 virtualises its DOM and
  // only keeps the visible lines in it, so that reads about one screenful
  // (~4.5k chars) no matter how large the document is — it looks exactly like a
  // truncation bug and is not one. Measure through the app's OWN save path
  // instead, which is both the truth and the thing the writer depends on.
  const storedLength = await page.evaluate((name) => {
    const raw = window.localStorage.getItem(`postData-new-${name}`);
    if (!raw) return 0;
    try {
      return (JSON.parse(raw)?.value?.postArea ?? '').length;
    } catch {
      return 0;
    }
  }, USERNAME);

  // ── (c) DID THE PREVIEW REFUSE RATHER THAN FREEZE? ─────────────────────────
  const paused = await page.locator('[data-testid="preview-too-large"]').count();
  check(
    'live preview paused itself instead of rendering megabytes',
    paused > 0,
    paused > 0 ? 'the "preview is paused" panel is on screen' : 'no pause panel — the renderer took the whole body'
  );

  // ── (d) THE DRAFT IS EITHER SAVED, OR THE READER IS WARNED. NEVER NEITHER. ──
  const stored = storedLength;
  const warned = await page.locator('[data-testid="draft-save-failed"]').count();
  const savedProperly = stored >= big.length * 0.95;

  // The truncation question, answered only where it CAN be answered: if the
  // draft was stored at all, was it stored whole? A payload too large to store
  // leaves this unmeasurable by this instrument — which is stated, never
  // silently passed. Run with QA_PASTE_MB=1 for the measurable case.
  if (stored > 0) {
    check(
      'the whole paste survived into the saved draft (nothing truncated it)',
      savedProperly,
      `${stored.toLocaleString()} chars saved of ${big.length.toLocaleString()} pasted`
    );
  } else {
    console.log(
      `SKIP  truncation check not measurable at ${PASTE_MB}MB (nothing was stored) — run QA_PASTE_MB=1`
    );
  }
  check(
    'the draft is either really saved, or the writer is warned it is not',
    savedProperly || warned > 0,
    savedProperly
      ? `saved: ${stored.toLocaleString()} chars in localStorage`
      : warned > 0
        ? `not saved (${stored.toLocaleString()} chars stored) — and the warning banner is on screen`
        : `SILENT LOSS: only ${stored.toLocaleString()} chars stored and NO warning shown`
  );
} catch (err) {
  fatal = err;
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length}`);
if (fatal) console.error(`\nFATAL: ${fatal.message}`);
if (results.length === 0) {
  console.error('FATAL: zero checks ran — that is a failure, not a pass.');
  process.exit(1);
}
process.exit(fatal || passed !== results.length ? 1 : 0);
