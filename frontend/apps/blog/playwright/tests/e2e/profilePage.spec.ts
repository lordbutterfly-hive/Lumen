import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { ProfilePage } from '../support/pages/profilePage';
import { PostPage } from '../support/pages/postPage';
import { LoginForm } from '../support/pages/loginForm';

test.describe('Profile page of @gtg', () => {
  let homePage: HomePage;
  let postPage: PostPage;
  let profilePage: ProfilePage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    postPage = new PostPage(page);
    profilePage = new ProfilePage(page);
  });

  test('url of the profile page @gtg is correct', async ({ page }) => {
    await profilePage.gotoProfilePage('@gtg');
    // Validate URL of page is "http://.../@gtg"
    await expect(profilePage.page).toHaveURL(/ *.\/@gtg$/);
  });

  test('profile info of @gtg is loaded', async ({ page, request }) => {
    await profilePage.gotoProfilePage('@gtg');
    // Note: In the new design, profile name and reputation are separate elements
    await profilePage.profileInfoIsVisible(
      '@gtg',
      'Gandalf the Grey',
      'IT Wizard, Hive Witness',
      'Joined June 2016'
    );

    const url = process.env.REACT_APP_API_ENDPOINT;

    // Compare profile api nickname with nickname displayed on the website
    // and number of posts
    // Use database_api.find_accounts instead of deprecated condenser_api.get_accounts
    const responseGetAccounts = await request.post(`${url}/`, {
      data: {
        id: 0,
        jsonrpc: '2.0',
        method: 'database_api.find_accounts',
        params: { accounts: ['gtg'], delayed_votes_active: false }
      },
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    });

    const accountsData = await responseGetAccounts.json();
    const profileNameApi = accountsData.result.accounts[0].name;

    await page.waitForSelector(profilePage.profileName['_selector']);
    expect(await profilePage.profileName).toBeVisible();
    // profilePostsLink was removed 2026-08-10 — Posts is the default view at
    // this URL already, no separate tab to click into.
    // ★ `post-author`/`medium-card-author` DEAD → `identity-pill-profile`
    // (identity-pill.tsx:134). Renders `@handle`; `toContainText` is a substring
    // match so the leading `@` needs no extra handling here.
    await expect(profilePage.page.locator('[data-testid="identity-pill-profile"]').first()).toContainText(
      profileNameApi
    );

    const profilePostCountApi = accountsData.result.accounts[0].post_count;
    // ★ profile-identity.tsx's `StatNumber` formats the count with
    // `.toLocaleString('en-US')` (thousands commas) — the raw API integer is a
    // substring of "5,000 posts" only below 1000; comparing the same format
    // fixes the `.toContain()` mismatch measured on @gtg (post_count >= 1000).
    expect(await profilePage.profileNumberOfPosts.textContent()).toContain(
      profilePostCountApi.toLocaleString('en-US')
    );

    // Compare follower and following number from api to the respondent on the website
    const responseGetProfile = await request.post(`${url}/`, {
      data: {
        id: 0,
        jsonrpc: '2.0',
        method: 'bridge.get_profile',
        params: { account: 'gtg' }
      },
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    });

    const profileResult = (await responseGetProfile.json()).result;
    const followerCount = profileResult?.stats?.followers ?? 0;
    const followingCount = profileResult?.stats?.following ?? 0;

    await expect(profilePage.profileFollowers).toContainText(String(followerCount));
    await expect(profilePage.profileFollowing).toContainText(String(followingCount));
  });

  // DELETED 2026-08-10: 'profile navigation of @gtg is loaded', 'profile
  // Blog tab of @gtg is loaded', 'move to Posts Tab', 'move to Replies Tab'
  // and 'move to Social Tab' all asserted on `[data-testid="profile-navigation"]`
  // (via profileNavigationIsVisible/profileBlogTabIsSelected/moveToPostsTab/
  // moveToRepliesTab/moveToSocialTab), the legacy tab bar that shipped with
  // `ProfileLayout`. It's gone — confirmed by grep (zero occurrences of
  // "profile-navigation" under features/app/components) and live
  // (`/@gtg/replies` 302s to `/404`). See profilePage.ts's class doc comment.
  //
  // DELETED 2026-08-10: 'move to Wallet Page' (was already test.skip) drove
  // the same removed nav to reach Wallet. `/wallet` is a real, live,
  // auth-gated top-level route now (app/wallet/page.tsx, see the
  // auth-gate change in this same pass) — reach it with `page.goto('/wallet')`
  // directly, not via a profile nav click.

  test('move to Peakd by link in Social Tab', async ({ page }) => {
    // ★ FIX (2026-08-21): was `gotoSocialProfilePage('gtg')` (no `@`). The
    // helper builds `/${nickName}/communities` verbatim (profilePage.ts) — it
    // does not prepend `@` itself, so the bare handle produced `/gtg/communities`,
    // an unrouted 2-segment path with no `profile-subpage-main` to wait for
    // (confirmed: `profileSocialPage.spec.ts` calls the same helper with
    // `'@gtg'` and reaches `/@gtg/communities` correctly). Passing `'@gtg'`
    // here matches that convention.
    await profilePage.gotoSocialProfilePage('@gtg');
    await profilePage.moveToPeakdByLinkInSocialTab();
  });

  test('validate Hivebuzz link in Social Tab', async ({ page }) => {
    await profilePage.gotoSocialProfilePage('@gtg');
    // URL varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag
    await expect(await profilePage.thirdPartyAppHivebuzzLink.getAttribute('href')).toContain('hivebuzz.me');
    // await profilePage.moveToHivebuzzByLinkInSocialTab();
  });

  /*
   * ★ UNSKIPPED + RENAMED 2026-08-11. The reason ("Settings Tab is unavailable")
   * is true of the TAB and irrelevant to this test: the body no longer touches a
   * tab at all — it deep-links to `/@gtg/settings`, which is a live route
   * (app/[param]/(user-profile)/settings/page.tsx). The tab is genuinely gone
   * (features/account-profile/redesign/profile-tabs.tsx:11-12 is `posts |
   * comments`); settings is now reached from the left rail
   * (left-rail.tsx:274-287) or the account menu (user-menu.tsx:170-174). Renamed
   * so the title stops describing navigation it does not perform.
   */
  test('settings route is reachable', async ({ page }) => {
    await page.goto('/@gtg/settings');
    await page.waitForLoadState('domcontentloaded');
  });

  /*
   * ★ STILL SKIPPED 2026-08-11, but for the REAL reason — this needs an
   * authenticated session as the profile's OWNER.
   *
   * Not "Settings Tab is unavailable": the form itself is alive and every field
   * this test names still exists (features/account-settings/form.tsx — #profileImage:263,
   * #coverImage:296, #name:329, #about:349, #location:365, #website:381,
   * #blacklistDescription:404, #mutedListDescription:422, pps-update-button:441).
   * What blocks it is the ownership gate at
   * app/[param]/(user-profile)/settings/content.tsx:61 — `SettingsForm` mounts only
   * when `identity.isLoggedIn && identity.username === username`. An anonymous
   * visitor gets the "These aren't your settings" card instead (content.tsx:82-96),
   * so `publicProfileSettingsHeader` resolves to the wrong copy.
   *
   * TO ENABLE: seed an owner session with support/fixture-auth/seeder.ts and target
   * that seeded account's own /settings, instead of the hard-coded /@gtg. This
   * spec file is otherwise entirely anonymous, so that move belongs in an
   * authenticated spec, not here.
   */
  test.skip('move to Settings Tab and validate public profile settings form is visible', async ({ page }) => {
    // profileSettingsTabIsNotSelected()/moveToSettingsTab() were removed
    // 2026-08-10 (drove the deleted profile-navigation chrome); navigate to
    // the still-live `/settings` route directly. Already test.skip'd above
    // for an unrelated, pre-existing reason ("Settings Tab is unavailable").
    await page.goto('/@gtg/settings');
    await page.waitForLoadState('domcontentloaded');

    await expect(profilePage.publicProfileSettingsHeader).toHaveText('Public Profile Settings');
    await expect(profilePage.ppsProfilePictureUrlLabel).toHaveText('Profile picture url');
    await expect(profilePage.ppsProfilePictureUrlInput).toBeVisible();
    await expect(profilePage.ppsCoverImageUrlLabel).toHaveText('Cover image url (Optimal: 2048 x 512 px)');
    await expect(profilePage.ppsCoverImageUrlInput).toBeVisible();
    await expect(profilePage.ppsDisplayNameLabel).toHaveText('Display Name');
    await expect(profilePage.ppsDisplayNameInput).toBeVisible();
    await expect(profilePage.ppsAboutLabel).toHaveText('About');
    await expect(profilePage.ppsAboutInput).toBeVisible();
    await expect(profilePage.ppsLocationLabel).toHaveText('Location');
    await expect(profilePage.ppsLocationInput).toBeVisible();
    await expect(profilePage.ppsWebsiteLabel).toHaveText('Website');
    await expect(profilePage.ppsWebsiteInput).toBeVisible();
    await expect(profilePage.ppsBlacklistDescriptionLabel).toHaveText('Blacklist Description');
    await expect(profilePage.ppsBlacklistDescriptionInput).toBeVisible();
    await expect(profilePage.ppsMuteListDescriptionLabel).toHaveText('Mute List Description');
    await expect(profilePage.ppsMuteListDescriptionInput).toBeVisible();
    await expect(profilePage.ppsButtonUpdate).toHaveText('Update');
    await expect(profilePage.ppsButtonUpdate).toBeVisible();
  });

  /*
   * ★ STILL SKIPPED 2026-08-11 — same real reason as the test above: needs an
   * authenticated OWNER session (settings/content.tsx:61). The Preferences section
   * itself is alive with all four controls intact —
   * `settings-preferences` (features/account-settings/form.tsx:469),
   * `not-safe-for-work-content`:473, `blog-post-rewards`:508,
   * `comment-post-rewards`:536, `referral-system`:564.
   * TO ENABLE: seed an owner session via support/fixture-auth/seeder.ts.
   */
  test.skip('move to Settings Tab and validate preferences settings form is visible', async ({ page }) => {
    // profileSettingsTabIsNotSelected()/moveToSettingsTab() were removed
    // 2026-08-10 (drove the deleted profile-navigation chrome); navigate to
    // the still-live `/settings` route directly. Already test.skip'd above
    // for an unrelated, pre-existing reason ("Settings Tab is unavailable").
    await page.goto('/@gtg/settings');
    await page.waitForLoadState('domcontentloaded');

    await expect(profilePage.preferencesSettings).toBeVisible();
    await expect(profilePage.preferencesSettingsChooseLanguage).toBeVisible();
    await expect(profilePage.preferencesSettingsNoSafeForWorkContent).toBeVisible();
    await expect(profilePage.preferencesSettingsBlogPostRewards).toBeVisible();
    await expect(profilePage.preferencesSettingsCommentsPostRewards).toBeVisible();
    await expect(profilePage.preferencesSettingsReferralSystem).toBeVisible();
  });

  /*
   * ★ 'move to Settings Tab and validate advanced settings form is visible'
   * DELETED 2026-08-11 — FEATURE GONE.
   *
   * It asserted an "Advanced Settings" section on /settings holding a 4-item API
   * endpoint radio group (api.hive.blog / rpc.ausbit.dev / anyx.io /
   * api.deathwing.me), an "Add API Endpoint" input and a reset button. The
   * settings form now has exactly two sections — `settings-public-profile` and
   * `settings-preferences` (features/account-settings/form.tsx) — and there is no
   * third. `api-endpoint-radiogroup`, `add-api-endpoint` and
   * `advanced-profile-settings` all have 0 hits in product source.
   *
   * Endpoint switching moved out to the standalone /healthchecker page
   * (app/healthchecker/page.tsx, components/healthcheckers-wrapper.tsx) and is
   * covered by e2e/healthchecker.spec.ts. See the KNOWN COVERAGE GAP note at the
   * top of e2e/healthchecker.spec.ts for what that spec does and does not reach.
   */

  // DELETED 2026-08-10: 'Move to the login modal after clicking the Follow
  // button in the notifications tab' and '...in the replies tab' both
  // navigated via moveToNotificationsTab()/moveToRepliesTab() to
  // `/notifications` and `/replies`, which are deleted routes (confirmed:
  // both 302 to `/404` on the live dev server). The Follow-button-opens-
  // login-modal behavior itself is still covered by the test above.

  test('The Follow button changes color when you hover over it (Light theme)', async ({ page }) => {
    await profilePage.gotoProfilePage('@gtg');

    expect(await profilePage.getElementCssPropertyValue(profilePage.followButton, 'color')).toBe(
      'rgb(248, 250, 252)'
    );
    expect(await profilePage.getElementCssPropertyValue(profilePage.followButton, 'background-color')).toBe(
      'rgb(24, 30, 42)'
    );

    await profilePage.followButton.hover();
    // Wait for hover color to change
    await expect.poll(async () => {
      return await profilePage.getElementCssPropertyValue(profilePage.followButton, 'color');
    }).toBe('rgb(218, 43, 43)');
    expect(
      await profilePage.getElementCssPropertyValue(await profilePage.followButton, 'background-color')
    ).toBe('rgb(24, 30, 42)');
  });

  test("User Banner Row - Description",async ({page}) =>{
    await profilePage.gotoProfilePage('@gtg');
    await expect(profilePage.profileInfo).toBeVisible()
    await expect(profilePage.profileAbout).toBeVisible()

    const profileAboutText = await profilePage.profileAbout.innerText()

    await expect(profileAboutText).toEqual('IT Wizard, Hive Witness')
  })

  test("User Banner Row - User Stats - Blacklisted Users", async ({page, request}) =>{
    await profilePage.gotoProfilePage('@gtg');
    await expect(profilePage.followedBlacklists).toBeVisible()
    await profilePage.followedBlacklists.click()
    await page.waitForURL('@gtg/lists/followed_blacklists')
    await expect(page).toHaveURL('@gtg/lists/followed_blacklists')
    await expect(profilePage.followedBlacklistsHeader).toBeVisible()
    await expect(profilePage.followedBlacklistsHeader).toHaveText("Followed Blacklists")
  })

  test("User Banner Row - User Stats - Muted Users", async ({page, request}) =>{
    await profilePage.gotoProfilePage('@gtg');
    await expect(profilePage.followedMutedLists).toBeVisible()
    await profilePage.followedMutedLists.click()
    await page.waitForURL('@gtg/lists/followed_muted_lists')
    await expect(page).toHaveURL('@gtg/lists/followed_muted_lists')
    await expect(profilePage.followedMutedListsHeader).toBeVisible()
    await expect(profilePage.followedMutedListsHeader).toContainText("Followed Muted")
  })

  test("User Banner Row - User level badge - @gtg user",async ({page}) =>{
    // User level is now calculated locally from VESTS, not from HiveBuzz API
    // gtg is a Whale (>= 1B VESTS)
    const titleAttribute: string = "gtg is a Whale (based on staked VESTS). Click for more stats on HiveBuzz.";
    const imgSrc: string = "/whale.png";

    await profilePage.gotoProfilePage('@gtg');
    await expect(profilePage.profileInfo).toBeVisible()
    await expect(profilePage.profileAbout).toBeVisible()

    // validate the tooltip as title attribute
    await expect(profilePage.userBannerLevelImg).toHaveAttribute('title', titleAttribute);
    // validate src attribute of the level image
    await expect(profilePage.userBannerLevelImg).toHaveAttribute('src', imgSrc);
  })

  test("User Banner Row - User level badge and twitter - @arcange user",async ({page}) =>{
    // User level is now calculated locally from VESTS, not from HiveBuzz API
    // arcange is an Orca (100M - 1B VESTS)
    const titleAttribute: string = "arcange is a Orca (based on staked VESTS). Click for more stats on HiveBuzz.";
    const imgSrc: string = "/orca.png";

    await profilePage.gotoProfilePage('@arcange');
    await expect(profilePage.profileInfo).toBeVisible()
    await expect(profilePage.profileAbout).toBeVisible()

    // validate the tooltip as title attribute
    await expect(profilePage.userBannerLevelImg).toHaveAttribute('title', titleAttribute);
    // validate src attribute of the level image
    await expect(profilePage.userBannerLevelImg).toHaveAttribute('src', imgSrc);
    // Twitter badge is only shown when REACT_APP_ENABLE_THIRD_PARTY_API=true
    // When disabled (default), hiveposh.com API is not called so no Twitter data is available
    const twitterBadgeVisible = await profilePage.userBannerTwitterBadgeLink.isVisible();
    if (twitterBadgeVisible) {
      const twitterTitleAttribute: string = "To get the Twitter badge, link your account at HivePosh.com";
      const twitterHrefAttribute: string = "https://twitter.com/thearcange";
      await expect(profilePage.userBannerTwitterBadgeLink).toHaveAttribute('title', twitterTitleAttribute);
      await expect(profilePage.userBannerTwitterBadgeLink).toHaveAttribute('href', twitterHrefAttribute);
    }
  })
});
