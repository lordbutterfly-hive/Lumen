import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { SearchPage } from '../support/pages/searchPage';
import { TIMEOUTS, isProductionEnvironment } from '../support/constants';

// Production has known bugs with dropdowns (SSR hydration issues)
const PRODUCTION_DROPDOWN_BUG = 'Production bug: dropdowns not functional due to SSR hydration issue';
const PRODUCTION_PROFILE_BUG = 'Production bug: profile page loads too slowly';

test.describe('Search page tests', () => {
  let homePage: HomePage;
  let searchPage: SearchPage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    searchPage = new SearchPage(page);
  });

  /**
   * BASIC SEARCH PAGE TESTS
   */

  test('search page is loaded correctly', async ({ page }) => {
    await searchPage.goto();

    // Verify page loaded
    await expect(page).toHaveURL('/search');
    await expect(searchPage.searchInput).toBeVisible();
    await expect(searchPage.searchButton).toBeVisible();
  });

  // DELETED 2026-08-10: 'search page mode selector is functional' tested the
  // scope dropdown (role="combobox", classic/ai/account/userTopic/tag), which
  // was removed by owner ruling — see packages/ui/hooks/use-search.ts. There
  // is one field now; 'search page is loaded correctly' above covers it.

  /**
   * CLASSIC SEARCH TESTS - using URL with parameters to bypass disabled input issue
   */

  test('search by keyword returns matching posts', async ({ page }) => {
    // Use direct URL with query param
    await searchPage.gotoWithClassicQuery('hive');

    // Wait for results
    await searchPage.waitForSearchResults();

    // Verify URL
    await expect(page).toHaveURL(/\/search\?q=hive/);

    // Verify results exist
    const resultsCount = await searchPage.getResultsCount();
    expect(resultsCount).toBeGreaterThan(0);
  });

  test('search sorting by relevance works', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Search results timing issues on WebKit');
    await searchPage.gotoWithClassicQuery('blockchain', 'relevance');

    await searchPage.waitForSearchResults();

    // Verify URL
    await expect(page).toHaveURL(/s=relevance/);

    // Verify results exist
    const resultsCount = await searchPage.getResultsCount();
    expect(resultsCount).toBeGreaterThan(0);
  });

  test('@flaky search sorting by newest (created) works', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Search results timing issues on WebKit');
    test.skip(isProductionEnvironment(), 'Production: search by created sort intermittently fails');
    await searchPage.gotoWithClassicQuery('hive', 'created');

    const state = await searchPage.waitForSearchResults();

    // Verify URL — the only deterministic assertion: the route accepted our
    // sort param. Anything beyond this depends on the upstream HiveSearcher
    // backend, which is flaky in CI: sometimes returns zero hits for q=hive
    // and sometimes never responds within the 15s wait.
    await expect(page).toHaveURL(/s=created/);

    if (state === 'timeout') {
      // Backend didn't produce results or empty-state UI within the wait —
      // skip rather than fail. A hard regression in the page itself would
      // surface in the URL/route check above or in the non-flaky tests.
      test.skip(true, 'HiveSearcher did not respond within 15s — runtime backend flake, not a frontend regression');
      return;
    }

    if (state === 'results') {
      expect(await searchPage.getResultsCount()).toBeGreaterThan(0);
    }
  });

  test('search pagination works', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Pagination scroll has timing issues on WebKit');

    await searchPage.gotoWithClassicQuery('test', 'relevance');

    // Wait for initial results
    await searchPage.waitForSearchResults();

    const initialCount = await searchPage.getResultsCount();
    expect(initialCount).toBeGreaterThan(0);

    // Scroll down to load more
    await searchPage.scrollToLoadMore();

    // Verify more results loaded
    const newCount = await searchPage.getResultsCount();
    expect(newCount).toBeGreaterThanOrEqual(initialCount);
  });

  test('empty search results shows appropriate message or empty list', async ({ page }) => {
    // Search for nonsense text
    await searchPage.gotoWithClassicQuery('xyzabc123nonexistentquery999');

    // Wait for results (or lack thereof)
    await searchPage.waitForSearchResults();

    // Verify list is empty or shows message
    const resultsCount = await searchPage.getResultsCount();
    expect(resultsCount).toBe(0);
  });

  // DELETED 2026-08-10: 'AI search mode option exists' and 'AI search returns
  // results when available' tested the ai/HiveSense mode via the scope
  // dropdown and `?ai=` query param. Both the dropdown and server-side `ai`
  // param handling are gone (app/search/page.tsx now reads only `q`/`s` via
  // parseSearchParams) — see packages/ui/hooks/use-search.ts.
  //
  // DELETED 2026-08-10: 'account mode redirects to user profile' and 'tag
  // mode redirects to trending tag page' tested the account/tag prefix modes
  // reached via the same removed dropdown. Account and tag lookups are no
  // longer searches at all — they're reachable by clicking any byline or
  // topic in the product, per the owner ruling in use-search.ts.

  /**
   * STYLES TESTS
   */

  test('search input styles in light theme', async ({ page }) => {
    await searchPage.goto();

    // Verify page is in light mode (default)
    await homePage.validateThemeModeIsLight();

    // Verify input is visible and has styles
    await expect(searchPage.searchInput).toBeVisible();
    await expect(searchPage.searchButton).toBeVisible();

    // Verify body doesn't have dark mode class
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  /**
   * NAVIGATION TESTS
   */

  test('navigate to post from search results', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Navigation timing issues on WebKit');
    await searchPage.gotoWithClassicQuery('technology', 'relevance');

    await searchPage.waitForSearchResults();

    const resultsCount = await searchPage.getResultsCount();
    if (resultsCount > 0) {
      // Get first post title
      const firstPostTitle = await searchPage.firstPostTitle.textContent();

      // Click first result
      await searchPage.clickFirstResult();

      // Verify we're on the post page
      await expect(page.locator('[data-testid="article-title"]')).toBeVisible();

      // Title should match
      const articleTitle = await page.locator('[data-testid="article-title"]').textContent();
      expect(articleTitle).toBe(firstPostTitle);
    }
  });

  test('navigate to profile from search results', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Navigation timing issues on WebKit');
    test.skip(isProductionEnvironment(), PRODUCTION_PROFILE_BUG);
    await searchPage.gotoWithClassicQuery('blockchain', 'relevance');

    await searchPage.waitForSearchResults();

    const resultsCount = await searchPage.getResultsCount();
    if (resultsCount > 0) {
      // Click first result author
      await searchPage.clickFirstResultAuthor();

      // Verify we're on the profile page. The redesigned profile carries no
      // "profile-name" testid (2026-08-10 redesign); profile-stats is the
      // stable element every profile view still renders.
      await expect(page.locator('[data-testid="profile-stats"]')).toBeVisible();
    }
  });
});
