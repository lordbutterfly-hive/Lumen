import { expect, test } from '@playwright/test';
import { PostPage } from '../support/pages/postPage';
import { HomePage } from '../support/pages/homePage';
import { ApiHelper } from '../support/apiHelper';
import { CommunitiesPage } from '../support/pages/communitiesPage';
import { LoginForm } from '../support/pages/loginForm';

test.describe('Post page tests', () => {
  let homePage: HomePage;
  let postPage: PostPage;
  let apiHelper: ApiHelper;
  let communityPage: CommunitiesPage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    postPage = new PostPage(page);
    apiHelper = new ApiHelper(page);
    communityPage = new CommunitiesPage(page);
  });

  test('move to the first post content on the home page by image', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByImage();
  });

  test('move to the first post content on the home page by title of this post', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByPostTitle();
  });

  test('validate that title of the post is the same as inside the post', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByPostTitle();
  });

  /*
   * ★ 'validate the post content pages styles in the dark theme' DELETED
   * 2026-08-11 — FEATURE GONE.
   *
   * There is no dark theme to validate. The blog app dropped next-themes and every
   * `dark:` variant and is light-only by owner ruling —
   * features/layouts/providers.tsx:27-38 ("Dark mode was never reachable — no
   * toggle existed anywhere in the product, and the `.dark` styles that did ship
   * were provably broken when forced"). The `mode-switch` testid this relied on
   * through `homePage.changeThemeMode('Dark')` has 0 occurrences in product source
   * and 0 nodes on a live page load (verified 2026-08-11).
   *
   * The old skip reason ("hardcoded RGB value tests are brittle") was also true and
   * still is, so this is not coverage worth resurrecting in another theme.
   *
   * NOTE for whoever greps next: `homePage.changeThemeMode()` /
   * `validateDarkModeByClass()` are still CALLED by several ACTIVE tests in
   * mainTimeline.spec.ts and elsewhere. Those tests are broken for this same
   * reason — reported separately; not silently disabled here.
   */

  test('validate the popover card with author info is displayed after click username in the post', async ({
    page
  }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByImage();
    await postPage.articleAuthorName.click();
    await expect(postPage.userPopoverCard).toBeVisible();
  });

  test('validate followers and following in the popover card', async ({ page }) => {
    await postPage.gotoHomePage();
    const firstPostAuthorName = (await homePage.getFirstPostAuthor.innerText()).trim().replace('@', '');
    // console.log("First post's author name without @: ", await firstPostAuthorName);

    await postPage.moveToTheFirstPostInHomePageByImage();
    await postPage.articleAuthorName.click();
    await postPage.page.waitForSelector(postPage.userPopoverCard['_selector']);

    const userFollowersAPI = (await apiHelper.getFollowCountAPI(firstPostAuthorName))['result']
      .follower_count;
    // ★ 2026-08-21: was an exact toBe on `${n}Followers`. These are live chain
    // counts read AFTER the page rendered, so the two disagree whenever the
    // account gains or loses a follower in between (observed 9923 vs 9918).
    // Assert the label and the number, the number tolerantly.
    const followersText = (await postPage.userFollowersPopoverCard.textContent()) ?? '';
    expect(followersText).toContain('Followers');
    expect(Math.abs(parseInt(followersText.replace(/[^\d]/g, ''), 10) - userFollowersAPI)).toBeLessThanOrEqual(25);

    const userFollowingAPI = (await apiHelper.getFollowCountAPI(firstPostAuthorName))['result']
      .following_count;
    const followingText = (await postPage.userFollowingPopoverCard.textContent()) ?? '';
    expect(followingText).toContain('Following');
    expect(Math.abs(parseInt(followingText.replace(/[^\d]/g, ''), 10) - userFollowingAPI)).toBeLessThanOrEqual(25);

    // console.log('API get_accounts: ', await apiHelper.getAccountInfoAPI(firstPostAuthorName));
    // console.log('API get_follow_count: ', await apiHelper.getFollowCountAPI(firstPostAuthorName));
    // console.log('API get_ranked_posts: ', await apiHelper.getRankedPostsAPI());
    // console.log('API get_list_communities: ', await apiHelper.getListCommunitiesAPI());
  });

  test('validate user about in the popover card', async ({ page }) => {
    await postPage.gotoHomePage();
    const firstPostAuthorName = (await homePage.getFirstPostAuthor.innerText()).trim().replace('@', '');

    await postPage.moveToTheFirstPostInHomePageByImage();
    await postPage.articleAuthorName.click();
    await postPage.page.waitForSelector(postPage.userPopoverCard['_selector']);

    try {
      const userPostingJsonMetadata = await JSON.parse(
        (await apiHelper.getAccountInfoAPI(firstPostAuthorName))['result'][0].posting_json_metadata
      );

      let userAboutAPI: any;

      if ((await userPostingJsonMetadata.profile) && userPostingJsonMetadata.profile.about) {
        userAboutAPI =
          userPostingJsonMetadata.profile.about.slice(0, 157) +
          (157 < userPostingJsonMetadata.profile.about.length ? '...' : '');
        // console.log('userAboutAPI: ', await userAboutAPI);
        expect(await postPage.userAboutPopoverCard.textContent()).toBe(userAboutAPI);
      } else {
        userAboutAPI = '';
        // console.log('userAboutAPI: ', await userAboutAPI);
        expect(await postPage.userAboutPopoverCard.textContent()).toBe(userAboutAPI);
      }
    } catch (error) {
      console.log('Json error: ', error);
    }
  });

  test('validate Follow button style in the popover card in light theme', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByImage();

    await postPage.articleAuthorName.click();
    await postPage.page.waitForSelector(postPage.userPopoverCard['_selector']);

    // button styles
    expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'color')).toBe(
      'rgb(248, 250, 252)'
    );
    expect(
      await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'background-color')
    ).toBe('rgb(24, 30, 42)');
    expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-color')).toBe(
      'rgb(237, 237, 237)'
    );
    expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-style')).toBe(
      'solid'
    );

    // button styles when hovered over it
    await postPage.buttonFollowPopoverCard.hover();
    // Wait for hover color to change
    await expect.poll(async () => {
      return await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'color');
    }).toBe('rgb(218, 43, 43)');
    expect(
      await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'background-color')
    ).toBe('rgb(24, 30, 42)');
    expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-color')).toBe(
      'rgb(237, 237, 237)'
    );
    expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-style')).toBe(
      'solid'
    );
  });

  /*
   * ★ STILL SKIPPED 2026-08-12, real precondition named, retargeted at Block.
   *
   * Was "validate Mute button style in the popover card in light theme",
   * already skipped since 2026-08-11 pending an authenticated session (a
   * signed-out visitor, which is all this spec file ever is, gets a single
   * "Follow" button wrapped in DialogLogin and no moderation control at
   * all). That precondition is UNCHANGED and still why this stays skipped.
   *
   * What DID change (2026-08-12, Block consolidation, owner ruling — "mute
   * and personal blacklist should be the same damn thing... just call it
   * block"): Mute itself is gone from this popover, for every viewer,
   * signed in or not. `features/mute-follow/mute-button.tsx` no longer
   * exists (deleted, unused) and `buttons-container.tsx` renders Follow +
   * BlockButton (`features/mute-follow/block-button.tsx`,
   * `data-testid="profile-block-button"`) only. Re-measuring "Mute button
   * style" is no longer a meaningful test — there is no Mute button to
   * measure — so this now targets Block instead.
   *
   * The four colour values below are CARRIED OVER, UNVERIFIED, from the old
   * Mute assertions, not re-measured against Block. `BlockButton` shares
   * the same shared `<Button>` primitive and the same `hover:text-destructive`
   * class Mute used, but keys its `text-destructive` state off `isBlocking`
   * rather than off `disabled` the way Mute did
   * (`clsx('hover:text-destructive', { 'text-destructive': isBlocking })` vs
   * Mute's old `{ 'text-destructive': disabled }`) — a real behavioural
   * difference this pass did not verify against a running browser. Treat
   * these numbers as a scaffold, not a fact, until someone re-measures with
   * a real authenticated session.
   */
  test.skip('validate Block button style in the popover card in light theme', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByImage();

    await postPage.articleAuthorName.click();

    // button styles
    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'color')).toBe(
      'rgb(239, 68, 68)'
    );
    expect(
      await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'background-color')
    ).toBe('rgba(0, 0, 0, 0)');
    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'border-color')).toBe(
      'rgb(239, 68, 68)'
    );
    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'border-style')).toBe(
      'solid'
    );

    // button styles when hovered over it
    await postPage.buttonBlockPopoverCard.hover();
    await postPage.page.waitForTimeout(1000);

    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'color')).toBe(
      'rgb(15, 23, 42)'
    );
    expect(
      await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'background-color')
    ).toBe('rgb(254, 226, 226)');
    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'border-color')).toBe(
      'rgb(239, 68, 68)'
    );
    expect(await postPage.getElementCssPropertyValue(postPage.buttonBlockPopoverCard, 'border-style')).toBe(
      'solid'
    );
  });

  test('validate the post footer is visible', async ({ page }) => {
    await postPage.gotoHomePage();
    await postPage.moveToTheFirstPostInHomePageByImage();
    await expect(postPage.articleFooter).toBeVisible();
  });

  // new tests

  test('Validate Post Header - Timestamp, Post Footer - Timestamp', async ({ page }) => {
    await postPage.gotoHomePage();
    await expect(homePage.getFirstPostCardTimestampLink).toBeVisible();

    const timestampText = await homePage.getFirstPostCardTimestampLink.innerText();
    await homePage.getFirstPostCardTimestampLink.click();
    await expect(page.locator('span[title]').nth(1)).toBeVisible();
    await expect(page.locator('span[title]').nth(1)).toHaveText(timestampText);

    await expect(page.locator('[data-testid="post-footer-timestamp"]')).toHaveText(timestampText);
  });

  test('Post Footer - Authored by', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Automatic test works well on chromium');
    await postPage.gotoHomePage();
    const firstPostAuthor = await homePage.getFirstPostAuthor.innerText();

    await postPage.moveToTheFirstPostInHomePageByImage();
    await expect(postPage.footerAuthorName).toBeVisible();

    const footerAuthorName = await page.locator('[data-testid="author-data-post-footer"] [data-testid="author-name-link"] span.font-semibold').innerText();
    /*
     * ★ THE CARD BYLINE NOW CARRIES A LEADING `@` (2026-08-21). `getFirstPostAuthor`
     * resolves to the identity pill's `identity-pill-profile`, which renders `@handle`,
     * where the retired `medium-card-author` rendered it bare. The footer side is
     * already scoped to `span.font-semibold`, so it yields the bare handle (measured
     * live: the footer link's full text is `gtg(76)`, the name span alone is `gtg`).
     * Stripping the `@` compares exactly what this test is named for — same account on
     * the card and in the post footer — without loosening it to a substring match.
     */
    expect(firstPostAuthor.trim().replace('@', '')).toEqual(footerAuthorName.trim());
  });



  test('Validate Post footer', async ({ page }) => {
    const loginDialog = new LoginForm(page);
    await postPage.gotoHomePage();
    await postPage.postImage.first().click();
    await expect(postPage.articleBody).toBeVisible();

    await test.step('Post Footer - Community Link', async () => {
      const footerCommunityLink = await postPage.footerCommunityLink;

      await expect(footerCommunityLink).toBeVisible();
      await expect(footerCommunityLink.getAttribute('href')).toBeTruthy();

      await footerCommunityLink.click();

      const communityNameText = await communityPage.communityNameTitle.textContent();
      await expect(communityPage.communityNameTitle).toBeVisible();

      await page.goBack();
    });

    await test.step('Post Footer - Author Link', async () => {
      await expect(postPage.footerAuthorName).toBeVisible();
      await expect(postPage.footerAuthorName.getAttribute('href')).toBeTruthy();
      await postPage.footerAuthorNameFirst.click();
      await postPage.page.waitForSelector(postPage.userPopoverCard['_selector']);
      await expect(postPage.popoverCardUserAvatar).toBeVisible();
    });

    await test.step('Post Footer - Upvote and Downvote', async () => {
      await expect(postPage.upvoteButton).toBeVisible();
      await expect(postPage.downvoteButton).toBeVisible();
    });

    //
    await test.step('Post Footer - Payout', async () => {
      await expect(postPage.footerPayouts).toBeVisible();
    });

    //
    await test.step('Post Footer - Votes', async () => {
      await expect(postPage.postFooterVotes.first()).toBeVisible();
    });

    await test.step('Post Footer - Reblog', async () => {
      await expect(postPage.footerReblogIcon).toBeVisible();
      await postPage.footerReblogIcon.click();
      await expect(postPage.reblogDialogHeader).toBeVisible();
      await expect(postPage.reblogDialogHeader).toHaveText('Reblog This Post');

      await expect(postPage.reblogDialogDescription).toBeVisible();
      await expect(postPage.reblogDialogDescription).toHaveText(
        'This post will be added to your blog and shared with your followers.'
      );

      await expect(postPage.reblogDialogCancelBtn).toBeVisible();
      await expect(postPage.reblogDialogOkBtn).toBeVisible();

      await expect(postPage.reblogDialogCloseBtn).toBeVisible();
      await postPage.reblogDialogCloseBtn.click();
    });

    await test.step('Post Footer - Reply', async () => {
      await expect(postPage.commentReplay).toBeVisible();
      await postPage.commentReplay.click();
      await loginDialog.validateDefaultLoginFormIsLoaded();
      await loginDialog.closeLoginForm();
    });

    await test.step('Post Footer - Responses', async () => {
      await expect(postPage.commentResponse).toBeVisible();
    });

    await test.step('Post Footer - Social Media links', async () => {
      await expect(postPage.facebookIcon).toBeVisible();
      await expect(postPage.twitterIcon).toBeVisible();
      await expect(postPage.linkedinIcon).toBeVisible();
      await expect(postPage.redditIcon).toBeVisible();
    });

    await test.step('Post Footer - Share this post link', async () => {
      await expect(postPage.sharePostBtn).toBeVisible();
      await postPage.sharePostBtn.click();
      await expect(postPage.sharePostFrame).toBeVisible();
      await expect(postPage.sharePostFrame).toContainText('Share this post');
      await postPage.sharePostCloseBtn.click();
    });

    await test.step('Post Footer - Hash tags', async () => {
      if (await postPage.hashtagsPosts.isVisible()) await expect(postPage.hashtagsPosts).toBeVisible();
    });
  });

});
