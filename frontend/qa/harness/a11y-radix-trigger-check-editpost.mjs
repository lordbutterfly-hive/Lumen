/**
 * One-off: verify PostPublishingSection.tsx's `edit-reward-type-select` SelectTrigger
 * (only rendered in inline edit mode on a post whose max_accepted_payout != 0).
 * Uses hive-124221 (already a signed-in identity for the roles-select check, and the
 * author of a real post at hive-125125/@hive-124221/caso-lauramica-egoismo-o-despiste
 * with max_accepted_payout=1000000.000 HBD, so the reward-type Select — not the
 * "reward_options_final" text branch — actually renders).
 *
 * Usage: QA_BASE=http://localhost:3000 node qa/harness/a11y-radix-trigger-check-editpost.mjs [--mode=before|after]
 */
import { chromium } from 'playwright';
import { signedInStorageState } from './session.mjs';

const BASE = process.env.QA_BASE || 'http://localhost:3000';
const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=check').split('=')[1];

const browser = await chromium.launch();
try {
  const state = await signedInStorageState('hive-124221');
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/hive-125125/@hive-124221/caso-lauramica-egoismo-o-despiste`, {
    waitUntil: 'load',
    timeout: 120000
  });
  await page.waitForTimeout(2000);
  const editButton = page.locator('[data-testid="post-edit"]');
  await editButton.scrollIntoViewIfNeeded({ timeout: 30000 });
  await editButton.click({ timeout: 30000 });
  const locator = page.locator('[data-testid="edit-reward-type-select"]');
  await locator.waitFor({ state: 'attached', timeout: 30000 });
  const attr = await locator.evaluate((el) => el.getAttribute('aria-label'));
  const text = await locator.ariaSnapshot();
  console.log(`\n=== PostPublishingSection.tsx edit-reward-type-select [mode=${mode}] ===`);
  console.log(`aria-label attr on node: ${JSON.stringify(attr)}`);
  console.log(text);
  await ctx.close();
} catch (e) {
  console.log(`ERROR: ${e.message}`);
} finally {
  await browser.close();
}
