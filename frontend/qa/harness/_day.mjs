/**
 * Shared spine for the three "a normal user today" harnesses.
 *
 * ★★★ TWO ORIGINS, AND YOU MUST USE THE RIGHT ONE FOR THE RIGHT THING.
 *
 *   PROD  https://localhost:3443  — the real production build behind TLS.
 *         Everything except creator tokens is judged here, because this is
 *         what ships. Session cookies are `Secure`, which is why it is HTTPS.
 *
 *   DEV   http://localhost:3010   — a development build, used ONLY for creator
 *         tokens. The Magi testnet's GraphQL API is returning 502 today, so the
 *         deployed contract cannot be read; the demo data source is the
 *         fallback, and it is DELIBERATELY inert in a production build
 *         (`isCreatorTokensDemoEnabled()` refuses when NODE_ENV=production —
 *         a real safety control, not an oversight, so it was left alone).
 *
 * What that means for your report: on the DEV origin, judge FLOWS and COPY —
 * can you understand it, does the button do what it says, do the numbers agree
 * with each other. Do NOT judge performance there (dev compiles on first hit),
 * and never report a demo number as if it were real market data.
 */
import { openApp as baseOpen, liteSession } from '../../qa-harness.mjs';
import { createRequire } from 'module';
const require_ = createRequire('/home/clauderfly/hive-blog-rebuild/apps/blog/package.json');
const { chromium } = require_('playwright');

export const PROD = 'https://localhost:3443';
export const DEV = 'http://localhost:3010';

/** Signed-in on the PRODUCTION origin. Pass YOUR key so you own your identity. */
export async function openProd(privateKey, label) {
  return baseOpen({ loggedIn: true, privateKey, label });
}

/**
 * A browser on the DEV origin, signed in with the same wallet, so creator
 * tokens can be exercised. Cookies are copied from a session established
 * against DEV itself (its cookies are not `Secure`, and a prod cookie would not
 * be accepted by a different origin anyway).
 */
export async function openDev(privateKey, label = 'day') {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const s = await liteSessionOn(DEV, privateKey, label);
  if (s.cookies.length) await ctx.addCookies(s.cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`); });
  return { browser, ctx, page, username: s.username, consoleErrors, failedRequests };
}

/** liteSession, but against an arbitrary origin (the shared one is PROD-only). */
async function liteSessionOn(origin, privateKey, label) {
  const prev = process.env.QA_BASE;
  process.env.QA_BASE = origin;
  try {
    const mod = await import(`../../qa-harness.mjs?origin=${encodeURIComponent(origin)}`);
    const s = await mod.liteSession(privateKey, label);
    // DEV is http:// — a Secure cookie would never be sent back.
    return { ...s, cookies: s.cookies.map((c) => ({ ...c, secure: false })) };
  } finally {
    if (prev === undefined) delete process.env.QA_BASE; else process.env.QA_BASE = prev;
  }
}

/** Settle before judging: SSR renders logged-out chrome and swaps it after hydration. */
export async function land(page, origin, path, settleMs = 3000) {
  const t = Date.now();
  let status = 'ok';
  try {
    const r = await page.goto(origin + path, { waitUntil: 'networkidle', timeout: 120000 });
    if (r && r.status() >= 400) status = `HTTP ${r.status()}`;
  } catch (e) {
    status = `NAV FAILED: ${String(e).slice(0, 80)}`;
  }
  await page.waitForTimeout(settleMs);
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  return { ms: Date.now() - t, status, text };
}

/** Every toast currently on screen — Radix renders them as <ol><li>, NOT a data attribute. */
export async function toasts(page) {
  return (await page.locator('ol li').allInnerTexts().catch(() => [])).join(' | ').replace(/\s+/g, ' ');
}

/** Note something a normal person would notice, with its evidence, as you go. */
export function journal() {
  const entries = [];
  return {
    note: (what, evidence) => { entries.push({ what, evidence }); console.log(`  · ${what}\n      ${evidence}`); },
    all: () => entries
  };
}
export { liteSession };
