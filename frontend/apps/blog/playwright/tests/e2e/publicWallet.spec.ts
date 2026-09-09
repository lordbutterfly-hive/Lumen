import { expect, test, type Page } from '@playwright/test';

/**
 * Public, read only wallet page (BUILDMAP-PUBLIC-WALLET-2026-09-09, section
 * 4.10, invariants S1/S2/S5/S6). `playwright.local3000.config.ts` hardcodes
 * its own `baseURL` with no environment override, and the build map's own
 * test run targets a different port on the local testnet server
 * (`127.0.0.1:3010`, section 6), so every navigation below builds a full URL
 * from PW_BASE_URL instead of a relative path.
 *
 * Every `test()` here gets a fresh, cookie less browser context from the
 * `page` fixture (this config sets no `storageState`), so each one already
 * runs signed out with no extra setup, the same way profilePage.spec.ts's
 * tests do.
 */

const BASE_URL = process.env.PW_BASE_URL ?? 'http://127.0.0.1:3000';
const ACCOUNT = process.env.PW_WALLET_ACCOUNT ?? 'lumen.beat';

function fullUrl(pathname: string): string {
  return `${BASE_URL}${pathname}`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// S1: zero signing surface anywhere on the public page, on any tab.
const SIGNING_TESTID = /\b(send|deposit|withdraw|stake|unstake|claim|delegate|convert|power-down|swap|reclaim|rate|sdk)\b/i;

async function collectTestIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-testid') ?? ''));
}

test.describe('Public wallet page', () => {
  test('the profile pill links to the wallet page (signed out)', async ({ page }) => {
    await page.goto(fullUrl(`/@${ACCOUNT}`));

    const walletLink = page.locator('[data-testid="profile-wallet-link"]');
    await expect(walletLink).toBeVisible();
    await expect(walletLink).toHaveAttribute('href', `/@${ACCOUNT}/wallet`);
  });

  test('the three tabs switch panels and the URL mirrors the active tab', async ({ page }) => {
    await page.goto(fullUrl(`/@${ACCOUNT}/wallet`));
    await expect(page.locator('[data-testid="public-wallet-shell"]')).toBeVisible();

    await page.locator('[data-testid="public-wallet-tab-magi"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-magi"]')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${escapeForRegExp(`/@${ACCOUNT}/wallet`)}\\?tab=magi(?:&|$)`));

    await page.locator('[data-testid="public-wallet-tab-meritum"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-meritum"]')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${escapeForRegExp(`/@${ACCOUNT}/wallet`)}\\?tab=meritum(?:&|$)`));

    // goBack steps back exactly one tab: the shell's own pushState history,
    // one entry per tab switch (public-wallet-shell.tsx, a copy of the
    // private shell's own tab URL sync).
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${escapeForRegExp(`/@${ACCOUNT}/wallet`)}\\?tab=magi(?:&|$)`));
    await expect(page.locator('[data-testid="public-wallet-panel-magi"]')).toBeVisible();
  });

  test('no element on any tab carries a signing shaped data-testid', async ({ page }) => {
    await page.goto(fullUrl(`/@${ACCOUNT}/wallet`));
    await expect(page.locator('[data-testid="public-wallet-shell"]')).toBeVisible();

    let testIds = await collectTestIds(page);
    let signingLike = testIds.filter((id) => SIGNING_TESTID.test(id));
    expect(signingLike, `hive tab carried: ${signingLike.join(', ')}`).toHaveLength(0);

    await page.locator('[data-testid="public-wallet-tab-magi"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-magi"]')).toBeVisible();
    testIds = await collectTestIds(page);
    signingLike = testIds.filter((id) => SIGNING_TESTID.test(id));
    expect(signingLike, `magi tab carried: ${signingLike.join(', ')}`).toHaveLength(0);

    await page.locator('[data-testid="public-wallet-tab-meritum"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-meritum"]')).toBeVisible();
    testIds = await collectTestIds(page);
    signingLike = testIds.filter((id) => SIGNING_TESTID.test(id));
    expect(signingLike, `meritum tab carried: ${signingLike.join(', ')}`).toHaveLength(0);
  });

  test('the whole visit makes no request to /api/lite/ or a BTC deposit address', async ({ page }) => {
    const flagged: string[] = [];
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (requestUrl.includes('/api/lite/') || requestUrl.includes('btc-deposit-address')) flagged.push(requestUrl);
    });

    // Straight to the wallet page: the profile page in front of it legitimately
    // reads lite posts and the viewer's block list from /api/lite/, and those
    // are not this page's surface. Test 1 already covers the pill.
    await page.goto(fullUrl(`/@${ACCOUNT}/wallet`));
    await expect(page.locator('[data-testid="public-wallet-shell"]')).toBeVisible();

    await page.locator('[data-testid="public-wallet-tab-magi"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-magi"]')).toBeVisible();

    await page.locator('[data-testid="public-wallet-tab-meritum"]').click();
    await expect(page.locator('[data-testid="public-wallet-panel-meritum"]')).toBeVisible();

    expect(flagged, flagged.join(', ')).toHaveLength(0);
  });

  test('a nonexistent account wallet page answers 404', async ({ page }) => {
    const response = await page.goto(fullUrl('/@zz-no-such-account-9/wallet'));
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(404);
  });
});
