/**
 * One-off verification script (BUILDMAP-FUCKERY-V2 sweep, part 2): capture the REAL
 * accessibility tree for each candidate Radix trigger, via Playwright's
 * `locator.ariaSnapshot()`, rather than trusting a static grep for aria-label/
 * aria-labelledby/sr-only text. A trigger can already be named through Radix's
 * content-derived accessible name (e.g. a Select showing its current value, or
 * `asChild` composing onto a caller-supplied `aria-label`) — grep cannot see that.
 *
 * Usage: QA_BASE=http://localhost:3000 node qa/harness/a11y-radix-trigger-check.mjs <check> [--mode=before|after]
 * <check> one of: post-select-filter | notifications-menu | user-menu | lang-toggle |
 *                  communities-select-filter | posting-to-list-trigger | edit-reward-type |
 *                  communities-select | roles-select
 */
import { chromium } from 'playwright';
import { signedInStorageState } from './session.mjs';

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=check').split('=')[1];
const check = process.argv[2];

async function snap(page, locator, label) {
  try {
    await locator.waitFor({ state: 'attached', timeout: 30000 });
    const attr = await locator.evaluate((el) => el.getAttribute('aria-label'));
    const text = await locator.ariaSnapshot();
    console.log(`\n=== ${label} [mode=${mode}] ===`);
    console.log(`aria-label attr on node: ${JSON.stringify(attr)}`);
    console.log(text);
  } catch (e) {
    console.log(`\n=== ${label} [mode=${mode}] === ERROR: ${e.message}`);
  }
}

const browser = await chromium.launch();

try {
  if (check === 'post-select-filter') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/trending`, { waitUntil: 'load', timeout: 120000 });
    await snap(page, page.locator('[data-testid="posts-filter"]'), 'post-select-filter.tsx (/trending, data-testid=posts-filter)');
    await ctx.close();
  } else if (check === 'notifications-menu') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/trending`, { waitUntil: 'load', timeout: 120000 });
    await snap(page, page.locator('[data-testid="nav-notifications"]'), 'notifications-menu.tsx trigger button (data-testid=nav-notifications)');
    await ctx.close();
  } else if (check === 'user-menu') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/trending`, { waitUntil: 'load', timeout: 120000 });
    await snap(page, page.locator('[data-testid="profile-avatar-button"]'), 'user-menu.tsx trigger button (data-testid=profile-avatar-button)');
    await ctx.close();
  } else if (check === 'lang-toggle') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/trending`, { waitUntil: 'load', timeout: 120000 });
    await page.locator('[data-testid="profile-avatar-button"]').click();
    await page.waitForSelector('[data-testid="user-profile-menu-content"]', { timeout: 20000 });
    await snap(page, page.locator('[data-testid="toggle-language"]'), 'lang-toggle.tsx trigger button inside user menu (data-testid=toggle-language)');
    await ctx.close();
  } else if (check === 'communities-select-filter') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/communities`, { waitUntil: 'load', timeout: 120000 });
    await snap(page, page.locator('[data-testid="communities-filter"]'), 'communities-select-filter.tsx (/communities, data-testid=communities-filter)');
    await ctx.close();
  } else if (check === 'posting-to-list-trigger') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/submit.html`, { waitUntil: 'load', timeout: 120000 });
    await snap(page, page.locator('[data-testid="posting-to-list-trigger"]'), 'PostPublishingSection.tsx posting-to-list-trigger (/submit.html)');
    await ctx.close();
  } else if (check === 'communities-select') {
    const state = await signedInStorageState('hbd-temp');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/trending`, { waitUntil: 'load', timeout: 120000 });
    await snap(
      page,
      page.locator('[role="combobox"]:not([data-testid])').first(),
      'communities-select.tsx (/trending, mobile viewport, role=combobox no testid)'
    );
    await ctx.close();
  } else if (check === 'roles-select') {
    const state = await signedInStorageState('hive-124221');
    const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/roles/hive-124221`, { waitUntil: 'load', timeout: 120000 });
    await page.locator('[data-testid="community-add-role-trigger"]').click();
    await page.waitForSelector('[data-testid="community-add-role-select"]', { timeout: 20000 });
    await snap(
      page,
      page.locator('[data-testid="community-add-role-select"]'),
      'roles-select.tsx via AddRole (/roles/hive-124221, data-testid=community-add-role-select)'
    );
    await ctx.close();
  } else {
    console.error(`Unknown check: ${check}`);
    process.exitCode = 2;
  }
} finally {
  await browser.close();
}
