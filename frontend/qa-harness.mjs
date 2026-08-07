/**
 * Shared Playwright harness for USER-JOURNEY QA on Lumen.
 *
 * WHY THIS EXISTS: a round of five code-reading agents found almost none of the
 * defects the owner hit in five minutes of clicking. They grepped, typechecked
 * and curled. `curl` returns 200 for a page whose every button is dead, and a
 * clean `tsc` says nothing about whether a number is formatted or a modal ever
 * mounts. This harness exists so QA agents DRIVE THE PRODUCT instead of reading
 * it.
 *
 * Usage from an agent script:
 *   import { openApp, loginLite, report } from './qa-harness.mjs';
 *   const { page, browser } = await openApp({ loggedIn: true });
 *
 * Every helper returns real evidence (text, counts, timings, console errors),
 * never a boolean you have to trust.
 */
import { createRequire } from 'module';
const require_ = createRequire('/home/clauderfly/hive-blog-rebuild/apps/blog/package.json');
const { chromium } = require_('playwright');
const { privateKeyToAccount } = require_('viem/accounts');

// ★ HTTPS by default. In production `NODE_ENV=production` marks the session
// cookie `Secure`, so a browser on plain http:// never sends it back and every
// auth-gated flow is untestable — which reads exactly like a broken login.
// `/tmp/tlsfront.mjs` terminates TLS in front of the Next server.
//
// Playwright is told `ignoreHTTPSErrors` below, but node's own `fetch` — used
// here to establish the session — is not, and rejects our self-signed cert with
// DEPTH_ZERO_SELF_SIGNED_CERT. Run these scripts as:
//
//   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem node qa-*.mjs
//
// deliberately NOT `NODE_TLS_REJECT_UNAUTHORIZED=0`: that switches verification
// off for the whole process, so a QA run could no longer tell a working TLS
// path from a broken one. This trusts exactly one cert and nothing else.
export const BASE = process.env.QA_BASE || 'https://localhost:3443';

const H = { 'content-type': 'application/json', 'x-csrf-token': '1' };

/** Establish a REAL lite session over the API and return its cookies. */
export async function liteSession(privateKey, label = 'qa') {
  const jar = new Map();
  const absorb = (cs) => {
    for (const c of cs) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
  };
  const call = async (path, body) => {
    const headers = { ...H };
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    absorb(res.headers.getSetCookie?.() ?? []);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const acct = privateKeyToAccount(privateKey);
  const msg = (n) =>
    [
      'Lumen sign-in',
      '',
      'Sign this to prove you control this wallet.',
      'It authorizes no transaction and moves no funds.',
      '',
      `Nonce: ${n}`
    ].join('\n');
  const ch = await call('/api/lite/auth/evm/challenge', { address: acct.address });
  const signature = await acct.signMessage({ message: msg(ch.nonce) });
  const vf = await call('/api/lite/auth/evm/verify', {
    address: acct.address,
    signature,
    nonce: ch.nonce
  });
  let username = vf?.user?.username;
  if (vf?.status === 'needs_name') {
    const nm = await call('/api/lite/auth/name', {
      displayName: label + Date.now().toString(36).slice(-5),
      // ★ In production the server REQUIRES a captcha token — an absent one is a
      // hard 403, not a pass-through. Any non-empty string satisfies Cloudflare's
      // always-pass test secret, which is what a local/staging box runs.
      captchaToken: process.env.QA_CAPTCHA_TOKEN || 'qa-dummy-token'
    });
    username = nm?.user?.username;
    if (!username) console.log(`  [harness] signup did not complete: ${JSON.stringify(nm).slice(0, 200)}`);
  }
  return { cookies: [...jar].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/', secure: true })), username };
}

/**
 * Open a browser. `loggedIn: true` establishes a real lite session first.
 * Captures console errors and failed requests for the whole page life — most of
 * what breaks a UI never reaches the server log.
 */
export async function openApp({ loggedIn = false, privateKey, label } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  let username = null;
  if (loggedIn) {
    const s = await liteSession(
      privateKey || '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      label || 'qa'
    );
    await ctx.addCookies(s.cookies);
    username = s.username;
  }
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('requestfailed', (r) =>
    failedRequests.push(`${r.method()} ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`)
  );
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`);
  });
  return { browser, ctx, page, username, consoleErrors, failedRequests };
}

/** Navigate and TIME it. Returns ms plus whether it actually rendered. */
export async function visit(page, path, { timeout = 90000 } = {}) {
  const t = Date.now();
  let status = 'ok';
  try {
    const res = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout });
    if (res && res.status() >= 400) status = `HTTP ${res.status()}`;
  } catch (e) {
    status = `NAV FAILED: ${String(e).slice(0, 90)}`;
  }
  const ms = Date.now() - t;
  let bodyText = '';
  try {
    bodyText = (await page.locator('body').innerText({ timeout: 8000 })).replace(/\s+/g, ' ');
  } catch {
    bodyText = '(body unreadable)';
  }
  return { ms, status, bodyText, empty: bodyText.trim().length < 40 };
}

/**
 * Every number RENDERED to a reader, so a missing thousands separator shows up.
 *
 * ★ Must skip <script>/<style>: Next.js streams its RSC payload as text nodes
 * inside body <script> tags, and a naive TreeWalker reported forty "unformatted
 * numbers" that no human can see — timestamps and ids out of the flight data.
 * A QA harness that cries wolf is worse than none.
 */
export async function numbersOnPage(page) {
  return page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.parentElement?.tagName ?? '')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    let n;
    while ((n = walk.nextNode())) {
      const t = n.textContent.trim();
      if (/^[\d.,]+$/.test(t) && /\d/.test(t)) out.push(t);
      else {
        const m = t.match(/\b\d{4,}(\.\d+)?\b/g);
        if (m) out.push(...m);
      }
    }
    return [...new Set(out)].slice(0, 40);
  });
}

/** Click something by accessible name and report what actually happened. */
export async function clickAndWatch(page, name, { role = 'button', timeout = 15000 } = {}) {
  const before = page.url();
  const target = page.getByRole(role, { name }).first();
  const count = await target.count();
  if (count === 0) return { found: false, note: `no ${role} named ${name}` };
  const disabled = await target.isDisabled().catch(() => null);
  try {
    await target.click({ timeout });
  } catch (e) {
    return { found: true, disabled, clicked: false, note: String(e).slice(0, 120) };
  }
  await page.waitForTimeout(2500);
  return { found: true, disabled, clicked: true, urlChanged: page.url() !== before, url: page.url() };
}

export function report(title, rows) {
  console.log(`\n=== ${title} ===`);
  for (const [k, v] of Object.entries(rows)) console.log(`  ${String(k).padEnd(26)} ${v}`);
}
