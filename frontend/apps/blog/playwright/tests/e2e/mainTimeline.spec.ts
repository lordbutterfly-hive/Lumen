import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { LoginForm } from '../support/pages/loginForm';
import { ReblogThisPostDialog } from '../support/pages/reblogThisPostDialog';
import { ProfilePage } from '../support/pages/profilePage';
import { PostPage } from '../support/pages/postPage';
import { ApiHelper } from '../support/apiHelper';

test.describe('Home page tests', () => {
  let homePage: HomePage;
  let loginDialog: LoginForm;
  let reblogDialog: ReblogThisPostDialog;
  let postPage: PostPage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    loginDialog = new LoginForm(page);
    reblogDialog = new ReblogThisPostDialog(page);
    postPage = new PostPage(page);
  });

  test('has the main timeline of posts (20 posts are displayed by default)', async ({ page }) => {
    await homePage.goto();
    await homePage.mainPostsTimelineVisible(20);
  });

  test('load next the main timeline of posts (at least 40 posts after scrolling)', async ({
    page,
    browserName
  }) => {
    test.skip(browserName === 'webkit', 'Automatic test works well on chromium');

    await homePage.goto();
    await homePage.mainPostsTimelineVisible(20);
    await homePage.page.keyboard.down('End');

    // Wait for new posts to load with dynamic timeout
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length >= 40,
      { timeout: 10000 }
    );

    const postsCount = await page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]').count();
    expect(postsCount).toBeGreaterThanOrEqual(40);
    expect(postsCount).toBeLessThanOrEqual(60);
  });


  test('validate the first post footer payouts styles (for Trending filter) in the light theme', async ({
    page
  }) => {
    await homePage.goto();
    await homePage.validateFirstPostPayoutWithTooltip();
  });


  test('validate the first post footer responses styles (for Trending filter) in the light theme', async ({
    page
  }) => {
    await homePage.goto();
    await homePage.validateFirstPostResponsesWithTooltip();
  });

  test('validate the first post header styles (for Trending filter) in the light theme', async ({ page }) => {
    await homePage.goto();
    await homePage.validateFirstPostHeaderElements();
  });


  test('move to the first post author profile page', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToFirstPostAuthorProfilePage();
  });

  test('move to the first post author profile page by avatar clicking', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToFirstPostAuthorProfilePageByAvatar();
  });


  test('move to the first post content by clicking the timestamp', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToFirstPostContentByClickingTimestamp();
  });

  test('move to the first post content by clicking the title of the post card', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToFirstPostContentByClickingTitilePostCard();
  });

  // ★ UNSKIPPED 2026-08-11 (was skipped with no reason at all). The feature is
  // live; only the locator was stale — the home timeline renders Lumen's card,
  // whose dek is `medium-card-dek`, not the classic card's `post-description`.
  // Fixed in support/pages/homePage.ts (`postDescription` now matches either).
  test('move to the first post content by clicking the description of the post card', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToFirstPostContentByClickingDescriptionPostCard();
  });

  test('validate styles of the description of the post card in the light mode', async ({ page }) => {
    await homePage.goto();
    await expect(homePage.postDescription.first()).toBeVisible();
  });

  test('move to the first post content by clicking the responses', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToTheFirstPostCommentContantPageByClickingResponses();
  });



  test('move to the Proposals page', async ({ page }) => {
    await homePage.goto();
    await page.click('[data-testid="left-rail-vote-proposals"]');
    await expect(page).toHaveURL(/\/proposals/);
  });

  test('move to the Witnesses page', async ({ page }) => {
    await homePage.goto();
    await page.click('[data-testid="left-rail-vote-witness"]');
    await expect(page).toHaveURL(/\/witnesses/);
  });

  /*
   * ★ UNSKIPPED 2026-08-11. The stated reason ("Navbar search input was deleted
   * now is icone to open search page") is factually wrong against current source:
   * the header renders a real `<input type="search">` inline at every viewport
   * (features/search/search-input.tsx:63-72, `data-testid="header-search-input"`;
   * mounted at app-header.tsx:215-217 and :502-504). There is no search icon
   * standing in for it. Only the placeholder copy changed: 'Search...' ->
   * 'Search posts' (search-input.tsx:58,65).
   */
  test('navigation search input is visible', async ({ page }) => {
    await homePage.goto();

    await expect(homePage.getNavSearchInput).toBeVisible();
    await expect(homePage.getNavSearchInput).toHaveAttribute('placeholder', 'Search posts and people');
  });

  test('navigation search link is visible', async ({ page }) => {
    await homePage.goto();

    await expect(homePage.getNavSearchClassicInput).toBeVisible();
  });

  // DELETED 2026-08-10: 'move to the test trending page for searching by
  // tags' drove the scope dropdown (`getByRole('combobox')` in the header)
  // to reach tag mode, then typed into a "Search tags..." box. Both the
  // dropdown and every mode but plain post search were removed by owner
  // ruling — see packages/ui/hooks/use-search.ts. A tag is now reached by
  // clicking any topic link in the product, not by searching for one.

  test('navigation Login link is visible', async ({ page }) => {
    await homePage.goto();

    await expect(homePage.loginBtn).toBeVisible();
  });

  test('validate styles of navigation Login link in the light mode', async ({ page }) => {
    await homePage.goto();
    await expect(homePage.loginBtn).toBeVisible();
    const cursor = await homePage.getElementCssPropertyValue(homePage.loginBtn, 'cursor');
    expect(cursor).toBe('pointer');
  });

  /*
   * ★ 'navigation user avatar and its dropdown list is visible' DELETED
   * 2026-08-11 — unfixable as written, in this file.
   *
   * It asserted that an ANONYMOUS visitor sees @gtg's avatar hard-coded into the
   * header. That was an artifact of an old always-logged-in dev build and is now
   * architecturally impossible: the avatar trigger renders only under
   * `user?.isLoggedIn` (features/layouts/app-header.tsx:370-386), and signed-out
   * visitors get `data-testid="login-link"` instead (app-header.tsx:481). Every
   * locator it used is also dead — `profile-menu` / `profile-menu-content` have 0
   * hits (current: `profile-avatar-button` / `user-profile-menu-content`,
   * features/layouts/site-header/user-menu.tsx:205), and the "My Account" copy
   * does not exist anywhere in that menu.
   *
   * COVERAGE GAP, deliberately left open rather than faked: the logged-in avatar
   * dropdown has no test. It belongs in an authenticated spec using the
   * fixture-auth seeder (support/fixture-auth/seeder.ts), not in this anonymous
   * home-timeline file.
   */

  test('navigation create post button is visible', async ({ page }) => {
    await homePage.goto();

    await expect(homePage.getNavCreatePost).toBeVisible();
  });

  test('navigation hamburger menu is visible', async ({ page }) => {
    await homePage.goto();

    await expect(homePage.getNavSidebarMenu).toBeVisible();
    await homePage.getNavSidebarMenu.click();
    await page.waitForSelector(homePage.getNavSidebarMenu['_selector']);
    await expect(homePage.getNavSidebarMenuContent).toBeVisible();
    await expect(homePage.getNavSidebarMenuContent.getByText('Welcome')).toBeVisible();
    await homePage.getNavSidebarMenuContentCloseButton.click();
    await expect(homePage.getNavSidebarMenuContent).not.toBeVisible();
  });





  test('validate reblog count display styles in the light theme', async ({ page }) => {
    await homePage.goto();
    await homePage.validateFirstPostReblogCountWithTooltip();
  });

  test('move to the reblog this post dialog ', async ({ page }) => {
    await homePage.goto();

    // Navigate to first post page (reblog is now interactive only on post pages)
    await homePage.getFirstPostTitle.click();
    await page.waitForSelector('[data-testid="article-title"]');

    // Click reblog icon on post page
    await postPage.footerReblogIcon.click();
    await reblogDialog.validateReblogThisPostHeaderIsVisible();
    await reblogDialog.validateReblogThisPostDescriptionIsVisible();
    // TODO: Check it only if user logged in
    // await expect(reblogDialog.getDialogOkButton).toBeVisible();
    await expect(reblogDialog.getDialogCancelButton).toBeVisible();
    await reblogDialog.closeReblogDialog();
  });


  test('validate styles of the affiliation tag (badge) in the post card in the light mode', async ({
    page
    // browserName
  }) => {
    // test.skip(browserName === 'webkit', 'Automatic test works well on chromium');

    // Load 40 posts - more likely to occur a badge
    await homePage.goto();
    await homePage.mainPostsTimelineVisible(20);
    await homePage.page.keyboard.down('End');

    // Wait for new posts to load with dynamic timeout
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length >= 40,
      { timeout: 10000 }
    );

    const postsCount = await page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]').count();
    expect(postsCount).toBeGreaterThanOrEqual(40);
    expect(postsCount).toBeLessThanOrEqual(60);

    if (await homePage.postCardAffiliationTag.first().isVisible()) {
      await expect(homePage.postCardAffiliationTag.first()).toBeVisible();
    } else console.log('No affiliation tags on the 40 post cards');
  });

  test('validate the text of the affiliation tag (badge) in the post card in the light mode', async ({
    page
    // browserName
  }) => {
    // test.skip(browserName === 'webkit', 'Automatic test works well on chromium');

    // Load 60 posts - more likely to occur a badge
    await homePage.goto();
    await homePage.mainPostsTimelineVisible(20);
    await homePage.page.keyboard.down('End');
    // Wait for new posts to load with dynamic timeout
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length >= 40,
      { timeout: 10000 }
    );

    const postsCount = await page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]').count();
    expect(postsCount).toBeGreaterThanOrEqual(40);
    expect(postsCount).toBeLessThanOrEqual(60);

    const apiHelper = await new ApiHelper(page);
    const rankedPostResponse = await apiHelper.getRankedPostsAPI('trending', '', '', 20, '', '');
    const rankedPostResultLength = await rankedPostResponse.result.length;
    const elementsWithAffiliationTag: string[] = [];

    for (let i = 0; i < rankedPostResultLength; i++) {
      if (await rankedPostResponse.result[i].author_title)
        await elementsWithAffiliationTag.push(await rankedPostResponse.result[i].author_title);
    }
    // console.log('Elements with affiliation tag: ', await elementsWithAffiliationTag);


    if (await homePage.postCardAffiliationTag.first().isVisible()) {
      // console.log('Text of the first affiliation tag: ', await homePage.postCardAffiliationTag.first().textContent());

      // Compare text the first affiliation tag from UI with the first affiliation tag from API
      if (await elementsWithAffiliationTag.length !== 0) {
        await expect(await homePage.postCardAffiliationTag.first().textContent()).toBe(
          elementsWithAffiliationTag[0]
        );
      }
      else console.log('No affiliation tags on the post cards');
    } else console.log('No affiliation tags on the 40 post cards');
  });

  test('validate styles of Powered Up 100% in the post card in the light mode', async ({
    page
    // browserName
  }) => {
    // test.skip(browserName === 'webkit', 'Automatic test works well on chromium');

    await homePage.goto();

    // Load 40 posts - more likely to occur a badge
    await homePage.mainPostsTimelineVisible(20);
    await homePage.page.keyboard.down('End');
    // Wait for new posts to load with dynamic timeout
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length >= 40,
      { timeout: 10000 }
    );

    const postsCount = await page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]').count();
    expect(postsCount).toBeGreaterThanOrEqual(40);
    expect(postsCount).toBeLessThanOrEqual(60);

    if (await homePage.postCardPoweredUp100Trigger.first().isVisible()) {
      await homePage.postCardPoweredUp100Trigger.first().hover();
      await expect(homePage.postCardPoweredUp100Tooltip).toHaveText('100% Hive Power100% Hive Power');
    } else console.log('No Powered Up 100% tags on the 40 post cards');
  });

  test('move to the post page by clicking Powered Up 100% in the post card ', async ({
    page
    // browserName
  }) => {
    // test.skip(browserName === 'webkit', 'Automatic test works well on chromium');

    await homePage.goto();

    // Load 40 posts - more likely to occur a badge
    await homePage.mainPostsTimelineVisible(20);
    await homePage.page.keyboard.down('End');
    // Wait for new posts to load with dynamic timeout
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="post-list-item"], [data-testid="medium-card"]').length >= 40,
      { timeout: 10000 }
    );

    const postsCount = await page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]').count();
    expect(postsCount).toBeGreaterThanOrEqual(40);
    expect(postsCount).toBeLessThanOrEqual(60);

    if (await homePage.postCardPoweredUp100Trigger.first().isVisible()) {
      const firstPoweredUp100Link = await homePage.postCardPoweredUp100TriggerLink.first();
      const urlOfFirstPoweredUp10Link = await firstPoweredUp100Link.getAttribute('href');
      // console.log('url of the first post ', await firstPoweredUp100Link.getAttribute("href"));
      await homePage.postCardPoweredUp100Trigger.first().click();
      await homePage.page.waitForSelector('#articleBody');
      await expect(homePage.page).toHaveURL(urlOfFirstPoweredUp10Link);
    } else console.log('No Powered Up 100% tags on the 40 post cards');
  });
});
