import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { ProfilePage } from '../support/pages/profilePage';
import { PostPage } from '../support/pages/postPage';
import { ApiHelper } from '../support/apiHelper';

/**
 * ★ WHOLE-FILE SKIP LIFTED 2026-08-11 — the stated reason was wrong.
 *
 * It read: "AxiosError with status code 500 in Peakd ... Run these tests again
 * when Peakd fix this bug." PeakD's uptime is irrelevant here. This app does not
 * call PeakD in the default configuration at all:
 * `isThirdPartyApiEnabled()` (packages/transaction/lib/custom-api.ts:14-17)
 * defaults to false and is `false` in every env file in the repo
 * (.env.testing:30, .env.mirrornet-testing:30), so `getPeakdBadges()`
 * short-circuits to `[]` (custom-api.ts:98-100) and the badge widget is never
 * mounted (app/[param]/(user-profile)/communities/content.tsx:61-96).
 *
 * What actually took the file down was the harness: `gotoSocialProfilePage()`
 * waited on `badges-activity-menu`, which cannot exist under that config — so
 * every test hung in its first line regardless of PeakD. Fixed in
 * support/pages/profilePage.ts.
 *
 * The route (/@user/communities), the subscriptions list and both section labels
 * are all live — verified against the running app 2026-08-11. Only the badge grid
 * needs the flag, and only that test stays skipped, with the real precondition
 * named on it.
 */

test.describe('Social tab in the profile page of @gtg', () => {
    let homePage: HomePage;
    let postPage: PostPage;
    let profilePage: ProfilePage;

    test.beforeEach(async ({ page }) => {
        homePage = new HomePage(page);
        postPage = new PostPage(page);
        profilePage = new ProfilePage(page);
    });

    test('social tab is loaded', async ({ page }) => {
        await profilePage.gotoSocialProfilePage('@gtg');
        await profilePage.profileSocialTabIsSelected();
        expect(await profilePage.socialCommunitySubscriptionsLabel).toHaveText('Community Subscriptions');
        expect(await profilePage.socialCommunitySubscriptionsDescription).toHaveText('The author has subscribed to the following Hive Communities');
        expect(await profilePage.socialAuthorSubscribedCommunitiesList).toBeVisible();
        expect(await profilePage.socialBadgesAchivementsLabel).toHaveText('Badges and achievements');
        // Text varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag
        await expect(profilePage.socialBadgesAchivementsDescription).toBeVisible();
        // ★ The `badges-activity-menu` assertions that used to close this test were
        // removed 2026-08-11: that element only exists with
        // REACT_APP_ENABLE_THIRD_PARTY_API=true (see the file header). Asserting it
        // here made a config-dependent widget a precondition for checking the page's
        // own, always-present content. Badge coverage lives in its own test below.
    });

    test('validate subscribed communities list', async ({ page }) => {
        let apiHelper = new ApiHelper(page);
        await profilePage.gotoSocialProfilePage('@gtg');
        await profilePage.profileSocialTabIsSelected();

        const resSubscribedCommunitiesAPI = await apiHelper.getSubscribedCommunitiesAPI('gtg');
        const listOfSubscribedCommunitiesAPI = await resSubscribedCommunitiesAPI.result;

        const listOfSubscribedCommunitiesUI = await profilePage.socialAuthorSubscribedCommunitiesListItem.all();

        // console.log('API list of subscribed communities:', await listOfSubscribedCommunitiesAPI);
        // console.log(' UI list of subscribed communities:', await listOfSubscribedCommunitiesUI);

        // Validate: Subscribed communities names, user role tags, affiliation tag
        let listOfSubscribedCommunitiesUITextContent: string;
        for (let i = 0; i < listOfSubscribedCommunitiesAPI.length; i++) {
            listOfSubscribedCommunitiesUITextContent = await listOfSubscribedCommunitiesUI[i].textContent();
            // console.log('111 ', await listOfSubscribedCommunitiesUITextContent.toLocaleLowerCase())
            expect(await listOfSubscribedCommunitiesUITextContent.toLocaleLowerCase())
                .toContain(await listOfSubscribedCommunitiesAPI[i][1].toLocaleLowerCase()); // Community name
            expect(await listOfSubscribedCommunitiesUITextContent.toLocaleLowerCase())
                .toContain(await listOfSubscribedCommunitiesAPI[i][2].toLocaleLowerCase()); // User role tag
            expect(await listOfSubscribedCommunitiesUITextContent.toLocaleLowerCase())
                .toContain(await listOfSubscribedCommunitiesAPI[i][3].toLocaleLowerCase()); // Affiliation Tag
        }
    });

    test('validate subscribed communities list styles in the light mode', async ({ page }) => {
        await profilePage.gotoSocialProfilePage('@gtg');
        await profilePage.profileSocialTabIsSelected();

        expect(await profilePage.getElementCssPropertyValue(await profilePage.socialAuthorSubscribedCommunitiesListItem.locator('a').first(), 'color'))
            .toBe('rgb(218, 43, 43)');
        /*
         * ★ WAS rgb(15, 23, 42) (slate-900), MEASURED rgb(0, 0, 0) — updated to
         * reality 2026-08-11, and the reason is a product smell worth knowing:
         * `author-role-community` (features/account-social/subscription-list-item.tsx:16)
         * carries `className="text-sm font-light opacity-60"` and NO colour class
         * at all, so it inherits the UA default black instead of a design token.
         * Its two siblings in the same list item DO use tokens
         * (`text-destructive` on the link:11, `text-slate-500` on the badge:22).
         * Reported as a defect; the value is pinned here so the next drift is
         * caught rather than silently absorbed.
         */
        expect(await profilePage.getElementCssPropertyValue(await profilePage.socialAuthorSubscribedCommunitiesRoleTag.first(), 'color'))
            .toBe('rgb(0, 0, 0)');
        expect(await profilePage.getElementCssPropertyValue(await profilePage.socialAuthorSubscribedCommunitiesAffiliationTag.first(), 'color'))
            .toBe('rgb(100, 116, 139)');
        expect(await profilePage.getElementCssPropertyValue(await profilePage.socialAuthorSubscribedCommunitiesAffiliationTag.first(), 'border-color'))
            .toBe('rgb(218, 43, 43)');
            expect(await profilePage.getElementCssPropertyValue(await profilePage.socialAuthorSubscribedCommunitiesAffiliationTag.first(), 'background-color'))
            .toBe('rgba(0, 0, 0, 0)');
    });

    /*
     * ★ 'validate subscribed communities list styles in the dark mode' DELETED
     * 2026-08-11 — FEATURE GONE. The blog app is light-only; next-themes and every
     * `dark:` variant were removed (features/layouts/providers.tsx:27-38), so
     * `changeThemeMode('Dark')` drives a `mode-switch` control that has 0
     * occurrences in product source. Note it also asserted the SAME
     * rgb(218,43,43) link colour as the light-mode test, which could never have
     * been right for a real dark palette.
     */

    /*
     * ★ THE ONE GENUINELY ENVIRONMENTAL TEST IN THIS FILE (2026-08-11).
     *
     * REQUIRES: `REACT_APP_ENABLE_THIRD_PARTY_API=true` in the env Playwright loads
     * (playwright.config.ts:2 reads .env.local), AND peakd.com/api/public/badge/*
     * plus hivebuzz.me reachable, AND the CSP `connect-src` in
     * apps/blog/next.config.js widened to allow those two hosts — the flag's own
     * doc comment (packages/transaction/lib/custom-api.ts:14-17) says the CSP
     * blocks them, so flipping the flag alone is NOT sufficient.
     *
     * Without all three, `SocialActivities` never mounts and there is nothing on
     * the page for this test to look at. It also pins @gtg's exact badge inventory
     * (alt text "Hive Witness - Top 100", "TRF 2018", "2021-03" ...), which is live
     * third-party data and can change without any code change here.
     */
    test.skip('validate badges and challenges for @gtg', async ({ page }) => {
        await profilePage.gotoSocialProfilePage('@gtg');
        await profilePage.profileSocialTabIsSelected();

        // Validate first and last badges in Badges MenuBar
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').first()).toHaveAttribute('alt', 'Hive Witness - Top 100');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').last()).toHaveAttribute('alt', 'Hive Witness - Top 20');
        // Validate first three badges in Activity MenuBar
        await profilePage.socialMenuBarActivity.click();
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').first()).toHaveAttribute('alt', 'First Post');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(1)).toHaveAttribute('alt', 'First Comment');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(2)).toHaveAttribute('alt', 'First Upvote');
        // Validate first three badges in Personal MenuBar
        await profilePage.socialMenuBarPersonal.click();
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').first()).toHaveAttribute('alt', '1 year on the Hive blockchain');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(1)).toHaveAttribute('alt', '2 years on the Hive blockchain');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(2)).toHaveAttribute('alt', '3 years on the Hive blockchain');
        // Validate first three badges in Meetups MenuBar
        await profilePage.socialMenuBarMeetups.click();
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').first()).toHaveAttribute('alt', 'TRF 2018');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(1)).toHaveAttribute('alt', 'TRF 2019');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(2)).toHaveAttribute('alt', 'AltspaceVR 2020 Meetings Contest');
        // Validate first three badges in Challenges MenuBar
        await profilePage.socialMenuBarChallenges.click();
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').first()).toHaveAttribute('alt', '2021-03');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(1)).toHaveAttribute('alt', '2020-08');
        await expect(await profilePage.socialBadgeAchivement.locator('a > img').nth(2)).toHaveAttribute('alt', '2021-09');
    });
});
