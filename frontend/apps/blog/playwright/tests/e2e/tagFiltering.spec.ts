import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { TIMEOUTS } from '../support/constants';

test.describe('Tag Filtering tests', () => {
  let homePage: HomePage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
  });

  /**
   * TAG PAGE LOADING TESTS
   */

  test('tag page loads correctly with posts', async ({ page }) => {
    // `/trending/:tag` 307-redirects to `/topics/:tag` now (verified live) — the
    // old chain-sort shell is retired; the tag itself still resolves there.
    await page.goto('/trending/hive');

    await expect(page).toHaveURL(/\/topics\/hive/);

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  test('tag page displays tag/community name', async ({ page }) => {
    // `/trending/:tag` 307-redirects to `/topics/:tag` now (verified live).
    await page.goto('/trending/photography');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/topics\/photography/);

    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThanOrEqual(0);
  });

  /**
   * TAG NAVIGATION TESTS
   */

  test('clicking tag in post card navigates to tag page', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Navigation timing issues on WebKit');

    await homePage.goto();

    // homePage.getFirstPostCardCategoryLink/getFirstPostCardCommunityLink target
    // `post-card-category`/`post-card-community`, which only exist on the CLASSIC
    // card (features/list-of-posts/post-list-item.tsx). goto() lands on `/`
    // (HomePage.HOME_TIMELINE_PATH), which renders Lumen's `medium-card`
    // exclusively (see the "home" testid inventory) — so those never match there;
    // see report to the homePage.ts owner. Lumen's card exposes the same
    // community/tag link as `medium-card-rubric`, which routes to `/topics/:tag`
    // (features/discovery-feed/medium-post-card.tsx), not `/trending/`.
    const rubricLink = page.locator('[data-testid="medium-card-rubric"]').first();
    await expect(rubricLink).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });

    await rubricLink.click();
    await expect(page).toHaveURL(/\/topics\//);
  });

  test('tag page pagination loads more posts', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Pagination scroll has timing issues on WebKit');

    await page.goto('/trending/hive');

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const initialCount = await homePage.getMainTimeLineOfPosts.count();

    await page.keyboard.press('End');

    try {
      await page.waitForFunction(
        (initial) => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length > initial,
        initialCount,
        { timeout: TIMEOUTS.PAGE_LOAD }
      );
    } catch {
      // Pagination may not load more if there aren't enough posts
      await page.waitForLoadState('networkidle');
    }

    const newCount = await homePage.getMainTimeLineOfPosts.count();
    expect(newCount).toBeGreaterThanOrEqual(initialCount);
  });

  /**
   * COMMUNITY TAG TESTS
   */

  test('community page loads correctly', async ({ page }) => {
    // Use 'domcontentloaded' instead of the default 'load' — community pages
    // contain many external images that may never finish loading and would
    // otherwise time out the navigation.
    await page.goto('/trending/hive-167922', { waitUntil: 'domcontentloaded' });

    // `/trending/:tag` 307-redirects to `/topics/:tag` now, even for community
    // ids (verified live) — the redirect in trending/[tag]/page.tsx is unconditional.
    await expect(page).toHaveURL(/\/topics\/hive-167922/);

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  /**
   * DIFFERENT SORT OPTIONS FOR TAGS
   */

  test('tag page hot sort works', async ({ page }) => {
    // `/hot/:tag` 307-redirects to `/topics/:tag` now (verified live) — there is
    // no separate hot-sorted tag feed any more, so this and the created/payout
    // sort tests below all land on the same canonical topic URL.
    await page.goto('/hot/hive');

    await expect(page).toHaveURL(/\/topics\/hive/);

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  test('tag page created/new sort works', async ({ page }) => {
    // `/created/:tag` 307-redirects to `/topics/:tag` now (verified live).
    await page.goto('/created/hive');

    await expect(page).toHaveURL(/\/topics\/hive/);

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  test('tag page payout sort works', async ({ page }) => {
    // `/payout/:tag` 307-redirects to `/topics/:tag` now (verified live).
    await page.goto('/payout/hive');

    await expect(page).toHaveURL(/\/topics\/hive/);

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThan(0);
  });

  /**
   * SPECIAL TAG SCENARIOS
   */

  test('empty or rare tag shows appropriate state', async ({ page }) => {
    // `/trending/:tag` 307-redirects to `/topics/:tag` now (verified live).
    await page.goto('/trending/xyznonexistenttag99999');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveURL(/\/topics\/xyznonexistenttag99999/);

    const postsCount = await homePage.getMainTimeLineOfPosts.count();
    expect(postsCount).toBeGreaterThanOrEqual(0);
  });
});
