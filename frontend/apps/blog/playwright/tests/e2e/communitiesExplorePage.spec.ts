import { test, expect, Locator } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { CommunitiesExplorePage } from '../support/pages/communitiesExplorerPage';
import { ApiHelper } from '../support/apiHelper';
import { LoginForm } from '../support/pages/loginForm';

test.describe('Explore communities page tests', () => {
  let homePage: HomePage;
  let communitiesPage: CommunitiesExplorePage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    communitiesPage = new CommunitiesExplorePage(page);
  });

  /*
   * ★★ THE ONE TEST LEFT POINTING AT THE DEAD LINK, ON PURPOSE (2026-08-21). This test's
   * subject IS the home-page entry point: `homePage.getExploreCommunities` clicks
   * `[data-testid="explore-communities-link"]`, which (per ground truth) exists only inside
   * features/layouts/community/communities-sidebar.tsx, rendered solely by
   * `CommunityLayout` (features/layouts/community/community-layout.tsx) — never on `/`. Grepped
   * the whole app: `explore-communities-link` appears in exactly that one source file. There is
   * no home-page link to click any more; the entry point itself is gone, not just moved.
   *
   * Every OTHER test below used this same click purely as a MEANS to reach `/communities` in
   * order to test that page's own search/filter/list behavior — for those, rerouting straight
   * to `/communities` via `homePage.gotoSpecificUrl(...)` preserves the test's real subject
   * (ground truth: "the feature exists, only the entry point moved"). This test's subject IS
   * the click, so rerouting it would test something else entirely and quietly hide a real
   * regression. Left calling the dead link so the failure documents it honestly. See the audit
   * report.
   */
  test('move to Explore communities... from Home Page', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);

    await homePage.goto();
    await homePage.getExploreCommunities.click();
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();
  });

  // ★ Rerouted straight to `/communities` (2026-08-21) — this test's subject is the explorer
  // page's Rank list, not the home-page click; see the comment on the test above for why that
  // one test is treated differently. `/communities` is confirmed live: 200, lists 100
  // communities (ground truth).
  test('validate amount of communities in the Rank list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const rankCommunitiesListAPI = await apiHelper.getListCommunitiesAPI();

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await expect(await communitiesPage.communityListItem.all()).toHaveLength(await rankCommunitiesListAPI.result.length);
  });

  test('validate amount of communities in the Subscribers list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const subscribersCommunitiesListAPI = await apiHelper.getListCommunitiesAPI('',100,null,'subs','');

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await communitiesPage.communitiesFilter.click();
    await communitiesPage.communitiesFilterItems.getByText("Subscribers").click();
    // Wait for community list to update after filter change
    await communitiesPage.communityListItem.first().waitFor({ state: 'visible' });
    await expect(await communitiesPage.communityListItem.all()).toHaveLength(await subscribersCommunitiesListAPI.result.length);
  });

  test('validate amount of communities in the New list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const newCommunitiesListAPI = await apiHelper.getListCommunitiesAPI('',100,null,'new','');

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await communitiesPage.communitiesFilter.click();
    await communitiesPage.communitiesFilterItems.getByText("New").click();
    // Wait for community list to update after filter change
    await communitiesPage.communityListItem.first().waitFor({ state: 'visible' });
    await expect(await communitiesPage.communityListItem.all()).toHaveLength(await newCommunitiesListAPI.result.length);
  });

  test('validate first community title in the Rank list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const rankCommunitiesListAPI = await apiHelper.getListCommunitiesAPI();
    const firstRankCommunitiesListAPI = await rankCommunitiesListAPI.result[0];
    const firstRankCommunitiesTitleAPI = await firstRankCommunitiesListAPI.title;

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await expect(communitiesPage.communityListItemTitle.first()).toHaveText(firstRankCommunitiesTitleAPI);
  });

  test('validate first community card description in the Rank list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const rankCommunitiesListAPI = await apiHelper.getListCommunitiesAPI();
    const firstRankCommunitiesListAPI = await rankCommunitiesListAPI.result[0];
    const firstRankCommunitiesAboutAPI = await firstRankCommunitiesListAPI.about;

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await expect(communitiesPage.communityListItemAbout.first()).toHaveText(firstRankCommunitiesAboutAPI);
  });

  test('validate first community card subscribers, authors, posts amount in the Rank list', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const apiHelper = new ApiHelper(page);
    const rankCommunitiesListAPI = await apiHelper.getListCommunitiesAPI();
    const firstRankCommunitiesListAPI = await rankCommunitiesListAPI.result[0];
    const firstAdminsAmountRankCommunitiesAPI = await firstRankCommunitiesListAPI.admins;

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    const footerText = await communitiesPage.communityListItemFooter.first().textContent();

    // Validate footer contains expected patterns (numbers can change between API call and UI render)
    // Check for "subscribers" text pattern
    expect(footerText).toMatch(/\d+ subscribers/);
    // Check for "authors" text pattern
    expect(footerText).toMatch(/\d+ authors/);
    // Check for "posts" text pattern
    expect(footerText).toMatch(/\d+ posts/);
    // Validate first admin is shown
    const firstAdminsAPI = firstAdminsAmountRankCommunitiesAPI[0];
    expect(footerText).toContain(firstAdminsAPI.toString());
  });

  test('move to the login page after clicking subscribe button of the first community', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const defaultLoginForm = new LoginForm(page);

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    const subscribeButton = await communitiesPage.communityListItemSubscribeButton.first();
    await subscribeButton.click();
    await defaultLoginForm.validateDefaultLoginFormIsLoaded();
    await defaultLoginForm.closeLoginForm();
  });

  test('validate first community card styles in the light mode', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await communitiesPage.validateFirstCommunityCardElements();
  });

  test('validate no results for your search message', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const nonExistentCommunity: string = 'abcdefgh';
    const noResultsMessage: string = 'No results for your search';

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    await communitiesPage.searchInput.fill(nonExistentCommunity);
    await communitiesPage.page.keyboard.press('Enter');
    await expect(communitiesPage.noResultsForYourSearch).toHaveText(noResultsMessage);
  });

  test('validate there is list of communities when you type nothing into the community search', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const nonExistentCommunity: string = 'abcdefgh';
    const noResultsMessage: string = 'No results for your search';
    const emptyString: string = '';

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    // write non-existing to the communities search
    await communitiesPage.searchInput.fill(nonExistentCommunity);
    await communitiesPage.page.keyboard.press('Enter');
    await expect(communitiesPage.noResultsForYourSearch).toHaveText(noResultsMessage);
    // write empty string to the communities search
    await communitiesPage.searchInput.fill(emptyString);
    await communitiesPage.page.keyboard.press('Enter');
    await expect(communitiesPage.noResultsForYourSearch).not.toBeVisible();
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();
  });

  test('validate results of searching community name', async ({ page }) => {
    const communitiesPage = new CommunitiesExplorePage(page);
    const communityName: string = 'LeoFinance';

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    // fill input search by comunity name
    await communitiesPage.searchInput.fill(communityName);
    await communitiesPage.page.keyboard.press('Enter');
    await communitiesPage.communityListItem.waitFor();
    await expect(await communitiesPage.communityListItem.count()).toBe(1);
    // clear input search by fill with emptystring
    await communitiesPage.searchInput.fill('');
    await communitiesPage.page.keyboard.press('Enter');
    await communitiesPage.communityListItem.first().waitFor();
    await expect(await communitiesPage.communityListItem.count()).toBe(100);
  });

  test('validate results of searching community name and esc key to clear input search', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox' || browserName === "webkit", 'Automatic test works well on chromium');
    const communitiesPage = new CommunitiesExplorePage(page);
    const communityName: string = 'LeoFinance';

    await homePage.gotoSpecificUrl('/communities');
    await communitiesPage.validataExplorerCommunitiesPageIsLoaded();

    // fill input search by comunity name
    await communitiesPage.searchInput.fill(communityName);
    await communitiesPage.page.keyboard.press('Enter');
    await communitiesPage.communityListItem.waitFor();
    await expect(await communitiesPage.communityListItem.count()).toBe(1);
    // clear input search by clicking Escape and Enter to search
    await communitiesPage.searchInput.click();
    await communitiesPage.page.keyboard.press('Escape');
    await communitiesPage.page.keyboard.press('Enter');
    // Wait for full community list to reload (100 items)
    await expect.poll(async () => {
      return await communitiesPage.communityListItem.count();
    }).toBe(100);
  });
});
