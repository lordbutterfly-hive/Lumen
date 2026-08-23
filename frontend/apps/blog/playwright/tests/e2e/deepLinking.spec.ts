import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { PostPage } from '../support/pages/postPage';
import { SearchPage } from '../support/pages/searchPage';
import { TIMEOUTS } from '../support/constants';

test.describe('Deep Linking tests', () => {
  let homePage: HomePage;
  let postPage: PostPage;
  let searchPage: SearchPage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    postPage = new PostPage(page);
    searchPage = new SearchPage(page);
  });

  /**
   * DIRECT POST LINKS
   */

  test('direct link to post loads correctly', async ({ page }) => {
    await homePage.goto();

    // ★ FIX (2026-08-21): `homePage.getFirstPostTitle` was itself repointed
    // (2026-08-21 REPAIR, homePage.ts) to
    // `[data-testid="medium-card-title"] h2 > span:nth-child(1)` — the
    // title-only span, not the anchor — precisely so its textContent is clean
    // title text with no inlined date. The old `.locator('h2 > span').first()`
    // chained here re-scoped INTO that span looking for a nested `h2 > span`
    // that cannot exist (a span has no `<h2>` descendant), which timed out.
    // The href also no longer lives on this locator (a `<span>` has none) —
    // `homePage.postTitle` (`a[data-testid="medium-card-title"]`) is the real
    // anchor and is what carries it.
    const postTitle = (await homePage.getFirstPostTitle.textContent())?.trim();
    const postHref = await homePage.postTitle.first().getAttribute('href');

    if (!postHref) {
      throw new Error('Post href is null - cannot proceed with deep link test');
    }

    await page.goto(postHref);

    await expect(postPage.articleTitle).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const articleTitle = await postPage.articleTitle.textContent();
    expect(articleTitle).toBe(postTitle);
  });

  test('post URL format is correct', async () => {
    await homePage.goto();

    // ★ FIX (2026-08-21): `homePage.getFirstPostTitle` resolves to the
    // title-only <span> (2026-08-21 REPAIR, homePage.ts), which carries no
    // `href` — this always read `null` here. `homePage.postTitle`
    // (`a[data-testid="medium-card-title"]`) is the real anchor.
    const postHref = await homePage.postTitle.first().getAttribute('href');

    expect(postHref).not.toBeNull();
    // URL format: /@author/permlink OR /community/@author/permlink
    expect(postHref).toMatch(/(\/@[\w.-]+\/[^\s/]+|\/[\w-]+\/@[\w.-]+\/[^\s/]+)$/);
  });

  /**
   * DIRECT PROFILE LINKS
   */

  test('direct link to user profile loads correctly', async ({ page }) => {
    const response = await page.goto('/@gtg');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/@gtg/);
  });

  test('profile URL with @ prefix works', async ({ page }) => {
    const response = await page.goto('/@arcange');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/@arcange/);
  });



  test('direct link to communities page loads correctly', async ({ page }) => {
    const response = await page.goto('/communities');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL('/communities');
  });

  test('direct link to specific community loads correctly', async ({ page }) => {
    // Use 'domcontentloaded' instead of the default 'load' — community pages
    // contain many external images that may never finish loading and would
    // otherwise time out the navigation.
    await page.goto('/trending/hive-167922', { waitUntil: 'domcontentloaded' });

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });

    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  /**
   * SEARCH DEEP LINKS
   */

  test('search URL with query parameter loads correctly', async ({ page }) => {
    await searchPage.gotoWithClassicQuery('hive', 'relevance');

    await expect(page).toHaveURL(/\/search\?q=hive/);
    await expect(searchPage.searchButton).toBeVisible({ timeout: TIMEOUTS.ELEMENT_VISIBLE });
  });

  test('search URL with sort parameter is respected', async ({ page }) => {
    await page.goto('/search?q=blockchain&s=created');

    await expect(page).toHaveURL(/s=created/);
  });

  /**
   * STATIC PAGES DIRECT LINKS
   */

  test('direct link to privacy policy page loads correctly', async ({ page }) => {
    await page.goto('/privacy.html');

    await expect(page).toHaveURL('/privacy.html');
    await expect(page.locator('h1').getByText('Privacy Policy')).toBeVisible({
      timeout: TIMEOUTS.ELEMENT_VISIBLE
    });
  });

  test('direct link to terms of service page loads correctly', async ({ page }) => {
    await page.goto('/tos.html');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL('/tos.html');
  });

  /**
   * FEED DEEP LINKS
   */

  test('@flaky direct link to hot feed loads correctly', async ({ page }) => {
    // Bare sort feeds (`/hot`, `/created`, `/payout`, ...) 307-redirect to `/`
    // now (verified live) — there is no standalone /hot feed any more.
    await page.goto('/hot');

    await expect(page).toHaveURL('/');

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  test('@flaky direct link to created/new feed loads correctly', async ({ page }) => {
    // Bare sort feeds 307-redirect to `/` now (verified live).
    await page.goto('/created');

    await expect(page).toHaveURL('/');

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  test('direct link to payout feed loads correctly', async ({ page }) => {
    // Bare sort feeds 307-redirect to `/` now (verified live).
    await page.goto('/payout');

    await expect(page).toHaveURL('/');

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });
});
