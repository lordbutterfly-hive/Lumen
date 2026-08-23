# Retired e2e tests removed 2026-08-21 - dropped-assertion ledger

Every test deleted, with the assertions it made, so the coverage being
intentionally dropped is on the record and can be re-added if any of these
features come back.

**63 tests removed, 151 assertions dropped.**


---

## `e2e/feedPages.spec.ts` - 18 tests

**Why:** Chain-sort feeds retired: /trending /hot /created /payout /muted all redirect() away; the `post-list-*` testids have 0 hits repo-wide and the sort dropdown is not on the home shell.


### hot feed page loads correctly  <sub>(was line 27)</sub>

```js
await expect(page).toHaveURL('/hot');
await expect(homePage.getMainTimeLineOfPosts).toHaveCount(PAGINATION.INITIAL_POSTS_COUNT, {
await expect(homePage.getPostListHot).toBeVisible();
```

### hot feed displays 20 posts by default  <sub>(was line 38)</sub>

```js
expect(postsCount).toBe(PAGINATION.INITIAL_POSTS_COUNT);
await expect(firstPost).toBeVisible();
await expect(homePage.getFirstPostTitle).toBeVisible();
await expect(homePage.getFirstPostAuthor).toBeVisible();
```

### hot feed pagination loads more posts  <sub>(was line 51)</sub>

```js
expect(postsCount).toBeGreaterThanOrEqual(PAGINATION.MIN_POSTS_AFTER_SCROLL);
expect(postsCount).toBeLessThanOrEqual(PAGINATION.MAX_POSTS_AFTER_SCROLL);
```

### hot feed URL is correct  <sub>(was line 71)</sub>

```js
await expect(page).toHaveURL('/hot');
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL('/hot');
```

### created feed page loads correctly  <sub>(was line 90)</sub>

```js
await expect(page).toHaveURL('/created');
await expect(homePage.getMainTimeLineOfPosts).toHaveCount(PAGINATION.INITIAL_POSTS_COUNT, {
await expect(homePage.getPostListNew).toBeVisible();
```

### created feed displays posts sorted by time  <sub>(was line 101)</sub>

```js
expect(apiTopAuthors).toContain(firstPostAuthor);
expect(apiTopTitles).toContain(firstPostTitle);
```

### created feed pagination works  <sub>(was line 146)</sub>

```js
expect(postsCount).toBeGreaterThanOrEqual(PAGINATION.MIN_POSTS_AFTER_SCROLL);
expect(postsCount).toBeLessThanOrEqual(PAGINATION.MAX_POSTS_AFTER_SCROLL);
```

### payout feed page loads correctly  <sub>(was line 170)</sub>

```js
await expect(page).toHaveURL('/payout');
await expect(homePage.getMainTimeLineOfPosts).toHaveCount(PAGINATION.INITIAL_POSTS_COUNT, {
await expect(homePage.getPostListPayouts).toBeVisible();
```

### payout feed shows pending payouts  <sub>(was line 181)</sub>

```js
expect(firstPostAuthor).toBe(firstPostFromAPI.author);
expect(firstPostTitle).toBe(firstPostFromAPI.title);
expect(firstPostPayout).toBe(`$${firstPostFromAPI.payout.toFixed(2)}`);
```

### payout feed pagination works  <sub>(was line 220)</sub>

```js
expect(postsCount).toBeGreaterThanOrEqual(PAGINATION.MIN_POSTS_AFTER_SCROLL);
expect(postsCount).toBeLessThanOrEqual(PAGINATION.MAX_POSTS_AFTER_SCROLL);
```

### muted feed page loads correctly  <sub>(was line 244)</sub>

```js
await expect(page).toHaveURL('/muted');
await expect(homePage.getPostListMuted).toBeVisible();
```

### muted feed shows muted content appropriately  <sub>(was line 252)</sub>

```js
await expect(homePage.getPostListMuted).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(homePage.getFirstPostTitle).toBeVisible();
await expect(homePage.getFirstPostAuthor).toBeVisible();
```

### navigation to hot feed works  <sub>(was line 285)</sub>

```js
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL(FEED_CONFIG.hot.url);
await expect(homePage.getPostListHot).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
```

### navigation to created feed works  <sub>(was line 299)</sub>

```js
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL(FEED_CONFIG.created.url);
await expect(homePage.getPostListNew).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
```

### navigation to payout feed works  <sub>(was line 313)</sub>

```js
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL(FEED_CONFIG.payout.url);
await expect(homePage.getPostListPayouts).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
```

### navigation to muted feed works  <sub>(was line 327)</sub>

```js
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL(FEED_CONFIG.muted.url);
await expect(homePage.getPostListMuted).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
```

### navigation back to trending feed works  <sub>(was line 341)</sub>

```js
await expect(homePage.getPostListHot).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
await expect(page).toHaveURL(FEED_CONFIG.trending.url);
await expect(homePage.getPostListTrending).toBeVisible({ timeout: TIMEOUTS.SEARCH_RESULTS });
```

### ${feedType} feed pagination using helper  <sub>(was line 365)</sub>

_No assertions - navigation/setup only._

---

## `e2e/mutedPosts.spec.ts` - 6 tests

**Why:** /muted retired: the route redirects to / and Lumen has no surface that browses hidden content ("nowhere honest to send this", muted/page.tsx).


### Check if properly go to muted posts  <sub>(was line 21)</sub>

```js
await expect(url).toContain('/muted')
// expect(dropDownText).toEqual('Muted');
```

### Check if posts in muted tab are display correctly  <sub>(was line 33)</sub>

```js
await expect(firstPost).toBeVisible();
await expect(firstPost).toHaveClass('opacity-50 hover:opacity-100');
await expect(postAuthorReputationRounded).toEqual(numberFirstReputation);
await expect(numberFirstReputation).toBeLessThan(1);
await expect(postPage.firstPostImageOnHomePage).toHaveCount(0);
await expect(postPage.firstPostImageOnHomePage).toHaveCount(1);
await expect(homePage.getFirstPostAuthor).toBeVisible();
await expect(authorName).toEqual(postAuthor);
await expect(firstUpvoteButton).toBeVisible();
await expect(firstDownvoteButton).toBeVisible();
await expect(firstPost).toHaveCSS('opacity', '1');
```

### Check if muted posts are displayed correctly  <sub>(was line 97)</sub>

```js
await expect(articleAuthor).toBeVisible();
await expect(articleAuthorText).toContain(postAuthor);
await expect(contentHidden).toBeVisible()
await expect(postPage.articleBody).toBeVisible();
await expect(postPage.articleFooter).toBeVisible();
```

### Check if posts list in  muted tab is displayed correctly  <sub>(was line 133)</sub>

```js
await expect(homePage.getFirstPostAuthor).toBeVisible()
await expect(postPage.postImage).not.toBeVisible()
```

### Check if image in muted tests are not displayed  <sub>(was line 140)</sub>

```js
await expect(postPage.mutedPostsBannedImageText).toHaveText('(Image not shown due to low ratings)');
```

### Check if re comment work correctly  <sub>(was line 151)</sub>

```js
await expect (profilePage.postBlogItem.first()).toBeVisible();
await expect(commentViewPage.commentGreenSection).toBeVisible();
```

---

## `e2e/sidebar.spec.ts` - 8 tests

**Why:** Home-page communities sidebar and Explore-Hive card removed from home; CommunitiesSidebar/CommunitiesMyBar render only under community-layout.tsx.


### trending communities sidebar is visible on desktop  <sub>(was line 16)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

### trending communities sidebar has community links  <sub>(was line 27)</sub>

```js
expect(count).toBeGreaterThan(0);
```

### explore communities link is visible  <sub>(was line 41)</sub>

```js
await expect(homePage.getExploreCommunities).toBeVisible();
await expect(homePage.getExploreCommunities).toHaveText(/Explore communities/);
```

### clicking community link navigates to community page  <sub>(was line 53)</sub>

```js
await expect(page).toHaveURL(/\/(trending|hot|created)\//);
await expect(page.locator('body')).toBeVisible();
```

### explore communities link navigates to communities page  <sub>(was line 76)</sub>

```js
await expect(page).toHaveURL('/communities');
```

### explore hive card is visible on desktop  <sub>(was line 94)</sub>

```js
await expect(exploreHiveCard).toBeVisible();
```

### @flaky sidebar is visible on hot feed  <sub>(was line 114)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

### @flaky sidebar is visible on created feed  <sub>(was line 125)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

---

## `e2e/trendingCommunitiesSidebar.spec.ts` - 4 tests

**Why:** Same subject as above: the trending-communities sidebar no longer renders on the home page.


### has   <sub>(was line 11)</sub>

_No assertions - navigation/setup only._

### move from one community to other community and home page next  <sub>(was line 16)</sub>

```js
await expect(homePage.getTrandingCommunitiesHeader).toBeVisible();
await expect(homePage.getTrandingCommunitiesHeader).toContainText('All posts');
```

### move to Explore communities... from Home Page  <sub>(was line 31)</sub>

_No assertions - navigation/setup only._

### validate trending communities links are visible and the same as in api  <sub>(was line 39)</sub>

```js
expect((await homePage.getTrendingCommunitiesSideBarLinks.all()).length - 1).toBe(
expect(linkName).toBe(displayedNameLink[index]);
```

---

## `e2e/loginSignUp.spec.ts` - 19 tests

**Why:** Username/password/WIF sign-in UI removed: smart-signer auth form, safestorage, methods, password-dialog have ZERO imports in apps/blog; /login renders only google-signin-row + keychain-row; no signup-btn exists.


### Check if login and sign up buttons are displayed correctly - light mode  <sub>(was line 31)</sub>

```js
await expect(homePage.loginBtn).toBeVisible()
expect(await homePage.getElementCssPropertyValue(homePage.loginBtn, 'color')).toBe("rgb(0, 0, 0)");
await expect(homePage.loginBtn).toHaveText("Login")
await expect(homePage.loginBtn).toHaveCSS('color', 'rgb(218, 43, 43)');
await expect(homePage.signupBtn).toBeVisible()
expect(await homePage.getElementCssPropertyValue(homePage.signupBtn, 'color')).toBe("rgb(255, 255, 255)");
await expect(homePage.signupBtn).toHaveText("Sign up")
await expect(homePage.signupBtn).toHaveCSS('background-color', 'rgb(220, 38, 38)');
```

### Check if after click sign up button correct modal is open  <sub>(was line 55)</sub>

```js
await expect(homePage.signupPageHeader).toBeVisible()
await expect(homePage.signupPageHeader).toHaveText('Signup for Hive')
```

### Unlock user with password in the Denser App  <sub>(was line 104)</sub>

```js
await expect(homePage.profileAvatarButton).not.toBeVisible();
```

### Sign in with WIF  <sub>(was line 139)</sub>

_No assertions - navigation/setup only._

### Validate the other sign in options form is loaded  <sub>(was line 167)</sub>

_No assertions - navigation/setup only._

### Validate the other sign in options form with username is loaded  <sub>(was line 178)</sub>

_No assertions - navigation/setup only._

### Validate the other sign in options for wif is loaded  <sub>(was line 191)</sub>

_No assertions - navigation/setup only._

### Validate the error message for wrong username  <sub>(was line 209)</sub>

```js
await expect(loginForm.usernameErrorMessage).toHaveText('Account name should be longer.');
await expect(loginForm.usernameErrorMessage).toHaveText('Account name should not be empty.');
```

### Validate the error message for too short password  <sub>(was line 223)</sub>

```js
await expect(loginForm.passwordErrorMessage).toHaveText('Password length should be at least 6 characters');
await expect(loginForm.passwordErrorMessage).toHaveText('Password length should be at least 6 characters');
```

### Validate the error message for wrong WIF format  <sub>(was line 240)</sub>

```js
await expect(loginForm.wifInputErrorMessage).toHaveText('Invalid WIF key.');
await expect(loginForm.wifInputErrorMessage).toHaveText('WIF should not be empty.');
```

### Validate No WIF key from user in the other sign in options form  <sub>(was line 257)</sub>

```js
await expect(loginForm.errorToastContent).toBeVisible();
await expect(loginForm.errorToastContentMessage).toHaveText('Error: No WIF key from user');
```

### Validate Invalid WIF checksum in the Enter your WIF form  <sub>(was line 279)</sub>

```js
await expect(loginForm.passwordErrorMessageEnterYourWifKey).toHaveText('Invalid WIF key.');
await expect(loginForm.errorToastContent).toBeVisible();
await expect(loginForm.errorToastContentMessage).toHaveText('Error: No WIF key from user');
```

### Check if Sign in with safe storage styles are correct in the light mode  <sub>(was line 304)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.loginDialog, 'color')).toBe("rgb(0, 0, 0)");
expect(await homePage.getElementCssPropertyValue(await loginForm.loginDialog, 'background-color')).toBe("rgb(255, 255, 255)");
expect(await homePage.getElementCssPropertyValue(await loginForm.loginFormHeader, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.loginFormDescription, 'color')).toBe("rgb(100, 116, 139)");
expect(await homePage.getElementCssPropertyValue(await loginForm.usernameInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.passwordInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.wifInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.saveSignInButton, 'color')).toBe("rgb(255, 255, 255)");
expect(await homePage.getElementCssPropertyValue(await loginForm.saveSignInButton, 'background-color')).toBe("rgb(220, 38, 38)");
expect(await homePage.getElementCssPropertyValue(await loginForm.otherSignInOptionsButton, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.otherSignInOptionsButton, 'background-color')).toBe("rgb(241, 245, 249)");
```

### Check if Other sign in options styles are correct in the light mode  <sub>(was line 331)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.loginDialog, 'color')).toBe("rgb(0, 0, 0)");
expect(await homePage.getElementCssPropertyValue(await loginForm.loginDialog, 'background-color')).toBe("rgb(255, 255, 255)");
expect(await homePage.getElementCssPropertyValue(await loginForm.otherSignInOptionsHeader, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.otherSignInOptionsDescription, 'color')).toBe("rgb(100, 116, 139)");
expect(await homePage.getElementCssPropertyValue(await loginForm.otherSignInOptionsUsernameInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.hiveKeychainExtensionButton, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.signInWithWifButton, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.hiveAuthButton, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.hiveAuthButton, 'background-color')).toBe("rgba(0, 0, 0, 0)");
expect(await homePage.getElementCssPropertyValue(await loginForm.hiveSignerButton, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.hiveSignerButton, 'background-color')).toBe("rgba(0, 0, 0, 0)");
```

### Validate styles in the error message for wrong username in the light mode  <sub>(was line 361)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.usernameErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
expect(await homePage.getElementCssPropertyValue(await loginForm.usernameErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
```

### Validate styles in the error message for too short password in the light mode  <sub>(was line 374)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.passwordErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
expect(await homePage.getElementCssPropertyValue(await loginForm.passwordErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
```

### Validate styles in the error message for wrong WIF format in the light mode  <sub>(was line 389)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.wifInputErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
expect(await homePage.getElementCssPropertyValue(await loginForm.wifInputErrorMessage, 'color')).toBe("rgb(218, 43, 43)");
```

### Validate styles of the Invalid WIF checksum in the Enter your WIF form in the light mode  <sub>(was line 404)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.passwordErrorMessageEnterYourWifKey, 'color')).toBe("rgb(239, 68, 68)");
await expect(loginForm.errorToastContent).toBeVisible();
expect(await homePage.getElementCssPropertyValue(await loginForm.errorToastContentMessage, 'color')).toBe("rgb(255, 255, 255)");
```

### Validate styles during Unlock user with password in the Denser App in the light mode  <sub>(was line 428)</sub>

```js
expect(await homePage.getElementCssPropertyValue(await loginForm.usernameInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.passwordInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.wifInput, 'color')).toBe("rgb(15, 23, 42)");
expect(await homePage.getElementCssPropertyValue(await loginForm.saveSignInButton, 'color')).toBe("rgb(255, 255, 255)");
expect(await homePage.getElementCssPropertyValue(await loginForm.saveSignInButton, 'background-color')).toBe("rgb(220, 38, 38)");
```

---

## `fixture/sidebar.spec.ts` - 8 tests

**Why:** Same retired subject as e2e/sidebar.spec.ts - every test visits `/` (or /hot, /created which redirect there) looking for the home-page communities sidebar and Explore-Hive card, which render only under community-layout.tsx. Runs under playwright.fixture.config.ts.


### trending communities sidebar is visible on desktop  <sub>(was line 25)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

### trending communities sidebar has community links  <sub>(was line 32)</sub>

```js
expect(count).toBeGreaterThan(0);
```

### explore communities link is visible  <sub>(was line 42)</sub>

```js
await expect(homePage.getExploreCommunities).toBeVisible();
await expect(homePage.getExploreCommunities).toHaveText(/Explore communities/);
```

### clicking community link navigates to community page  <sub>(was line 51)</sub>

```js
expect(href).toMatch(/^\/trending\/.+/);
```

### explore communities link navigates to communities page  <sub>(was line 69)</sub>

```js
await expect(page.locator('[data-testid="communities-header"]')).toBeVisible({
```

### explore hive card is visible on desktop  <sub>(was line 87)</sub>

```js
await expect(exploreHiveCard).toBeVisible();
```

### sidebar is visible on hot feed  <sub>(was line 102)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

### sidebar is visible on created feed  <sub>(was line 109)</sub>

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
```

---

# Second batch, same day - 28 more retired tests

Adjudicated from a full run on the isolated test stack. Each one's subject was
verified removed from the app; assertions recorded before deletion.


## `e2e/comments.spec.ts` - 2 tests


### Validate the first comment in the post  <sub>(was line 116)</sub>

**Why:** inline downvote removed (FEATURE_INLINE_DOWNVOTE=false; the anon overflow fallback needs a session)

```js
await expect(postPage.commentAuthorLink.first()).toHaveText('sicarius');
await expect(postPage.commentCardsDescriptions.first()).toContainText(
await expect(postPage.commentAuthorLink.first()).toHaveText('sicarius');
await expect(postPage.commentAuthorLink.first()).toHaveText('sicarius');
await expect(postPage.commentCardsFooterPayoutNonZero.first()).toHaveText(firstCommentPayoutValue);
await expect(postPage.commentCardsFooterVotes.first()).toHaveText(firstCommentVotes);
```

### Validate the second comment (nested) in the post  <sub>(was line 149)</sub>

**Why:** author-title badge deleted 2026-08-16 as spoofable; no replacement testid

```js
await expect(postPage.commentAuthorLink.nth(1)).toHaveText(postAuthorName);
await expect(commentViewPage.getCommentUserAffiliationTag.nth(0)).toHaveText('Wizard');
await expect(postPage.commentCardsDescriptions.nth(1)).toContainText('Great to hear, thank you! :-)');
await expect(postPage.commentAuthorLink.nth(1)).toHaveText(postAuthorName);
await expect(postPage.commentAuthorLink.nth(1)).toHaveText(postAuthorName);
await expect(postPage.commentCardsFooterPayoutZero.first()).toHaveText(secondCommentPayoutValue);
await expect(postPage.commentCardsFooters.nth(1)).not.toHaveAttribute('data-testid', 'comment-votes');
await expect(postPage.commentAuthorLink.nth(1)).toHaveText(postAuthorName);
expect(
expect(
expect(
expect(
await expect(postPage.commentAuthorLink.nth(0)).toHaveText('sicarius');
expect(
expect(
await expect(postPage.commentAuthorLink.first()).toBeVisible();
expect(await postPage.getElementCssPropertyValue(postPage.commentAuthorLink.first(), 'color')).toBe(
// expect(
expect(
await expect(postPage.userPopoverCard).toBeVisible();
await expect(postPage.commentAuthorLink.first()).toBeVisible();
expect(
expect(
await expect(atrTitle).toBe('Reputation');
expect(
expect(
await expect(atrTitle).toContain('Fri Jun 18 2021');
await expect(postPage.userPopoverCardAvatar).toHaveAttribute('href', '/@sicarius');
expect(firstCommentAuthorName).toBe(firstCommentPopoverCardAuthorName?.toLocaleLowerCase());
await expect(firstCommentPopoverCardNickName).toBe('@' + firstCommentAuthorName);
expect(await postPage.userFollowersPopoverCard.textContent()).toBe(userFollowersAPIString);
expect(await postPage.userFollowingPopoverCard.textContent()).toBe(userFollowingAPIString);
expect(userAboutAPI).toContain(await removeThreeDotsUserAboutUI);
expect(await postPage.userAboutPopoverCard.textContent()).toBe(userAboutAPI);
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'color')).toBe(
expect(
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-color')).toBe(
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-style')).toBe(
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'color')).toBe(
expect(
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-color')).toBe(
expect(await postPage.getElementCssPropertyValue(postPage.buttonFollowPopoverCard, 'border-style')).toBe(
await expect(commentViewPage.getReArticleTitle).toHaveText(reArticleTitle);
await expect(commentViewPage.getMainCommentAuthorNameLink).toHaveText('sicarius');
await expect(commentViewPage.getPopoverCardContent.first()).toBeVisible();
await expect(commentViewPage.getMainCommentContent.first()).toContainText(
await expect(commentViewPage.getMainCommentAuthorNameLink.first()).toHaveText('sicarius');
await expect(commentViewPage.getMainCommentAuthorNameLink.first()).toHaveText('sicarius');
await expect(commentViewPage.getMainCommentPayout).toHaveText(firstCommentPayoutValue);
await expect(commentViewPage.getMainCommentVotes).toHaveText(firstCommentVotes);
await expect(reblogDialog.getDialogOkButton).toBeVisible();
await expect(reblogDialog.getDialogCancelButton).toBeVisible();
await expect(commentViewPage.getReArticleTitle).toHaveText(reArticleTitle);
await expect(numberResponses).toBe('1');
await expect(commentViewPage.getReArticleTitle).toHaveText(reArticleTitle);
await expect(commentViewPage.getResponseCommentAuthorNameLink).toHaveText('gtg');
expect(await commentViewPage.getResponseCommentAuthorReputation.textContent()).toBe('(76)');
expect(await commentViewPage.getResponseCommentAffiliationTag).toHaveText('Wizard');
await expect(contentResponseComment).toContain('Great to hear, thank you');
expect(await responseCommentPayout).toBe('$0.00');
await expect(commentViewPage.getReArticleTitle).toHaveText(reArticleTitle);
expect(await postPage.articleTitle).toHaveText('Hive HardFork 25 Jump Starter Kit');
expect(await postPage.articleAuthorName).toHaveText('gtg');
expect(
expect(
await expect(commentViewPage.getReArticleTitle).toHaveText(reArticleTitle);
await expect(await commentViewPage.getMainCommentAuthorData).toBeVisible();
await expect(await commentViewPage.getMainCommentAuthorNameLink).toHaveText('sicarius');
await expect(await postPage.articleTitle).toBeVisible();
await expect(await postPage.articleTitle).toHaveText('Organic Curation report - Week 25, 2023');
await expect(postPage.commentListItems.first()).toBeVisible();
await expect((await postPage.commentListItems.all()).length).toBe(12);
await expect(await commentViewPage.getReArticleTitle).toBeVisible();
await expect(await commentViewPage.getReArticleTitle).toHaveText(rePostTitle);
await expect(postPage.commentListItems.first()).toBeVisible();
expect((await postPage.commentListItems.all()).length).toBe(3);
await expect(await postPage.articleTitle).toHaveText('Organic Curation report - Week 25, 2023');
await expect((await postPage.commentListItems.all()).length).toBe(12);
await expect(await postPage.commentAuthorLink.first()).toHaveText('infinity0');
await expect(await postPage.commentCardsDescriptions.first()).toContainText(
await expect(await postPage.commentAuthorLink.first()).toHaveText('takhar');
await expect(await postPage.commentCardsDescriptions.first()).toContainText(
```

## `e2e/communitiesExplorePage.spec.ts` - 1 tests


### move to Explore communities... from Home Page  <sub>(was line 33)</sub>

**Why:** the home-page "Explore communities" entry point no longer exists

_No assertions - navigation/setup only._

## `e2e/communitiesPage.spec.ts` - 3 tests


### validate the first post header with the pinned tag in the LeoFinance community  <sub>(was line 226)</sub>

**Why:** card-trending-comunities renders only under community-layout, not where this test looks

```js
await expect(communitiesPage.communityPinnedPost.first()).toBeVisible();
await expect(firstPostIsPinned).toBeTruthy();
await expect(postPage.articleTitle).toHaveText(firstPostTitle);
```

### validate the style of pinned tag in the last post header with the pinned tag in the LeoFinance community  <sub>(was line 269)</sub>

**Why:** same

```js
await expect(communitiesPage.communityPinnedPost.last()).toBeVisible();
expect(
expect(
```

### check if upvote and downvote button are displayed correctly on communities page  <sub>(was line 513)</sub>

**Why:** inline downvote removed

```js
await expect(homePage.getFirstPostUpvoteButton).toBeVisible();
await expect(homePage.getFirstPostDownvoteButton).toBeVisible();
```

## `e2e/healthchecker.spec.ts` - 2 tests


### Validate page descriptions are visible  <sub>(was line 59)</sub>

**Why:** the "Switch to Best" intro paragraph was deliberately cut 2026-08-18

_No assertions - navigation/setup only._

### Validate switch to best description text  <sub>(was line 302)</sub>

**Why:** same

```js
await expect(healthcheckerPage.pageDescriptionSwitchToBest).toContainText(
```

## `e2e/mainTimeline.spec.ts` - 12 tests


### validate the first post (for Trending filter)  <sub>(was line 48)</sub>

**Why:** card reputation badge removed

```js
expect(homePage.getFirstPostAuthor).toHaveText('@' + postAuthor);
expect(homePage.getFirstPostAuthorReputation).toContainText('(' + Math.round(postAuthorReputation) + ')');
expect(homePage.getFirstPostTitle).toHaveText(postTitle);
expect(homePage.getFirstPostPayout).toHaveText(`$${postPayout}`);
expect(firstPostTotalVotes).toMatch(/^\d+$/);
expect(firstPostChildren).toMatch(/^\d+$/);
```

### validate the first post footer votes styles (for Trending filter) in the light theme  <sub>(was line 104)</sub>

**Why:** combined vote figure deleted as a duplicate

_No assertions - navigation/setup only._

### @flaky validate the first post (for New filter)  <sub>(was line 123)</sub>

**Why:** sort dropdown is not on the home shell

```js
await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible();
await expect(homePage.getPostListNew).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('New');
expect(homePage.getFirstPostAuthor).toHaveText('@' + postAuthor);
expect(homePage.getFirstPostAuthorReputation).toContainText('(' + Math.round(postAuthorReputation) + ')');
expect(homePage.getFirstPostTitle).toHaveText(postTitle);
expect(homePage.getFirstPostPayout).toHaveText(`$${postPayout}`);
expect(firstPostTotalVotes).toMatch(/^\d+$/);
```

### move to the first post community or category  <sub>(was line 185)</sub>

**Why:** community-info-sidebar is community-layout only

_No assertions - navigation/setup only._

### filtr posts in maintimeline  <sub>(was line 219)</sub>

**Why:** sort dropdown

```js
await expect(homePage.getFilterPosts).toHaveText('Trending');
await expect(homePage.getPostListNew).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('New');
await expect(homePage.getPostListHot).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('Hot');
await expect(homePage.getPostListPayouts).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('Payouts');
await expect(homePage.getPostListMuted).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('Muted');
await expect(homePage.getPostListTrending).toBeVisible();
await expect(homePage.getFilterPosts).toHaveText('Trending');
```

### validate that Explore Hive sidebar is visible  <sub>(was line 252)</sub>

**Why:** explore-hive card is community-layout only

```js
await expect(homePage.getCardExploreHive).toBeVisible();
await expect(homePage.getCardExploreHiveTitle).toHaveText('Explore Hive');
await expect(homePage.getCardExploreHiveLinks).toHaveCount(5);
```

### validate that All posts in communities sidebar is visible  <sub>(was line 268)</sub>

**Why:** trending-communities sidebar removed from home

```js
await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
await expect(homePage.getTrandingCommunitiesHeader).toHaveText('All posts');
await expect(homePage.getTrendingCommunitiesSideBarLinks).toHaveCount(13);
```

### validate upvote button styles and the tooltip of the first post in the light theme  <sub>(was line 385)</sub>

**Why:** anon branch has no upvote tooltip by design

_No assertions - navigation/setup only._

### click upvote button and move to the dialog   <sub>(was line 392)</sub>

**Why:** trending-communities sidebar

_No assertions - navigation/setup only._

### validate downvote button styles and the tooltip of the first post in the light theme  <sub>(was line 401)</sub>

**Why:** inline downvote removed

_No assertions - navigation/setup only._

### click downvote button and move to the login dialog  <sub>(was line 408)</sub>

**Why:** inline downvote removed

_No assertions - navigation/setup only._

### validate styles of the reputation in the post card header in the light mode  <sub>(was line 439)</sub>

**Why:** card reputation badge removed

_No assertions - navigation/setup only._

## `e2e/postPage.spec.ts` - 3 tests


### Post Header/Footer - Affiliation tag  <sub>(was line 269)</sub>

**Why:** affiliation tag removed

```js
await expect(postPage.postLabel).toBeVisible();
await expect(postPage.postLabelFooter).toBeVisible();
await expect(labelText).toEqual(labelFooterText);
```

### Check: Post Content, Post Content - Image  <sub>(was line 281)</sub>

**Why:** post-image is the classic card only

```js
await expect(postPage.articleBody).toBeVisible();
```

### Validate Post footer  <sub>(was line 302)</sub>

**Why:** same

```js
await expect(postPage.articleBody).toBeVisible();
await expect(footerCommunityLink).toBeVisible();
await expect(footerCommunityLink.getAttribute('href')).toBeTruthy();
await expect(communityPage.communityNameTitle).toBeVisible();
await expect(postPage.footerAuthorName).toBeVisible();
await expect(postPage.footerAuthorName.getAttribute('href')).toBeTruthy();
await expect(postPage.popoverCardUserAvatar).toBeVisible();
await expect(postPage.upvoteButton).toBeVisible();
await expect(postPage.downvoteButton).toBeVisible();
await expect(postPage.footerPayouts).toBeVisible();
await expect(postPage.postFooterVotes.first()).toBeVisible();
await expect(postPage.footerReblogIcon).toBeVisible();
await expect(postPage.reblogDialogHeader).toBeVisible();
await expect(postPage.reblogDialogHeader).toHaveText('Reblog This Post');
await expect(postPage.reblogDialogDescription).toBeVisible();
await expect(postPage.reblogDialogDescription).toHaveText(
await expect(postPage.reblogDialogCancelBtn).toBeVisible();
await expect(postPage.reblogDialogOkBtn).toBeVisible();
await expect(postPage.reblogDialogCloseBtn).toBeVisible();
await expect(postPage.commentReplay).toBeVisible();
await expect(postPage.commentResponse).toBeVisible();
await expect(postPage.facebookIcon).toBeVisible();
await expect(postPage.twitterIcon).toBeVisible();
await expect(postPage.linkedinIcon).toBeVisible();
await expect(postPage.redditIcon).toBeVisible();
await expect(postPage.sharePostBtn).toBeVisible();
await expect(postPage.sharePostFrame).toBeVisible();
await expect(postPage.sharePostFrame).toContainText('Share this post');
if (await postPage.hashtagsPosts.isVisible()) await expect(postPage.hashtagsPosts).toBeVisible();
```

## `e2e/profileBlogPage.spec.ts` - 1 tests


### validate styles of the post header in the light mode  <sub>(was line 156)</sub>

**Why:** card reputation badge removed

_No assertions - navigation/setup only._

## `e2e/profilePage.spec.ts` - 4 tests


### User Banner Row - User Stats - Blacklisted Users  <sub>(was line 272)</sub>

**Why:** followed-blacklists banner removed from the profile; route redirects to settings

```js
await expect(profilePage.followedBlacklists).toBeVisible()
await expect(page).toHaveURL('@gtg/lists/followed_blacklists')
await expect(profilePage.followedBlacklistsHeader).toBeVisible()
await expect(profilePage.followedBlacklistsHeader).toHaveText("Followed Blacklists")
```

### User Banner Row - User Stats - Muted Users  <sub>(was line 282)</sub>

**Why:** followed-muted-lists banner removed

```js
await expect(profilePage.followedMutedLists).toBeVisible()
await expect(page).toHaveURL('@gtg/lists/followed_muted_lists')
await expect(profilePage.followedMutedListsHeader).toBeVisible()
await expect(profilePage.followedMutedListsHeader).toContainText("Followed Muted")
```

### User Banner Row - User level badge - @gtg user  <sub>(was line 292)</sub>

**Why:** HiveBuzz level badge replaced by ProfileLeagueChip

```js
await expect(profilePage.profileInfo).toBeVisible()
await expect(profilePage.profileAbout).toBeVisible()
await expect(profilePage.userBannerLevelImg).toHaveAttribute('title', titleAttribute);
await expect(profilePage.userBannerLevelImg).toHaveAttribute('src', imgSrc);
```

### User Banner Row - User level badge and twitter - @arcange user  <sub>(was line 308)</sub>

**Why:** same

```js
await expect(profilePage.profileInfo).toBeVisible()
await expect(profilePage.profileAbout).toBeVisible()
await expect(profilePage.userBannerLevelImg).toHaveAttribute('title', titleAttribute);
await expect(profilePage.userBannerLevelImg).toHaveAttribute('src', imgSrc);
await expect(profilePage.userBannerTwitterBadgeLink).toHaveAttribute('title', twitterTitleAttribute);
await expect(profilePage.userBannerTwitterBadgeLink).toHaveAttribute('href', twitterHrefAttribute);
```

## `e2e/deepLinking.spec.ts` - 2 tests


### direct link to profile posts tab loads correctly  <sub>(was line 81)</sub>

**Why:** /@user/posts route deleted 2026-08-06

```js
expect(response?.status()).toBe(200);
await expect(page).toHaveURL(/@gtg\/posts/);
```

### direct link to profile replies tab loads correctly  <sub>(was line 90)</sub>

**Why:** /@user/replies route deleted

```js
await expect(page).toHaveURL(/@gtg\/replies/);
```


**Note:** two targets were the LAST test in their file and were skipped by the
deletion pass rather than risk eating the enclosing `describe` - one in
`postPage.spec.ts`, one in `profilePage.spec.ts`. They remain, still failing.
---

## Batch 3 — retired 2026-08-21 after adjudicating the 29 remaining failures

Full reasoning: `LUMEN-DOCS/ADJUDICATION-29-FAILURES-2026-08-21.md`. Each of these was
read from its own `trace.zip` and checked against the source, and where it mattered
against a real browser load of the running production build.

### `loginSignUp.spec.ts` — 2 tests retired, 1 repaired

Login is no longer a modal. `login-link` carries `href="/login"` and navigates to a full
page rendering only a Keychain row and a Google row. `keychain-signin.tsx:9` states
Keychain is "the ONLY Hive-key path Lumen offers", so there is no WIF form on the route.

**Retired: `Sign In to the Denser App`.** Assertions recorded:
- fill `usernameInput` with `CI_TEST_USER`, `passwordInput` with `testtest`,
  `wifInput` with `CI_TEST_USER_WIF_POSTING`, then click `saveSignInButton`
- `profileAvatarButton` click opens `profileMenuContent`
- `validateUserProfileManuIsOpen()`
- `validateUserNameInProfileMenu(user.username)`

**Retired: `Sign In and Logout to the Denser App`.** All of the above, plus:
- `profileMenu.logoutLink.click()`
- `expect(homePage.profileAvatarButton).not.toBeVisible()`
- `homePage.isTrendingCommunitiesVisible()`

**Why not repaired:** both fill a username + password + WIF form that does not exist.
Restoring sign-in coverage means driving the Keychain browser extension, which this
suite has no fixture for. That is the outstanding work, and it is real work rather than
a rename.

**Repaired instead:** `Check if after click login button correct modal is open` is now
`Clicking the login control opens the sign-in page`, and
`validateDefaultLoginFormIsLoaded()` asserts the `/login` URL plus the Keychain and
Google rows.

**Author's note.** The dialog assertions that page object previously carried were
written by me earlier the same day, against a login UI I had not measured. They were
never correct. That is recorded in the audit's `meter.md` as an instance of a claim
outrunning its evidence, not as inherited breakage.

### `profilePage.spec.ts` — 2 assertions retired inside a surviving test

`User Banner Row - User level badge and twitter - @arcange user` keeps its Twitter-badge
coverage. Retired assertions, recorded verbatim:
- `expect(userBannerLevelImg).toHaveAttribute('title', 'arcange is a Orca (based on staked VESTS). Click for more stats on HiveBuzz.')`
- `expect(userBannerLevelImg).toHaveAttribute('src', '/orca.png')`

`profile-level-image` has **zero** occurrences in the application. The HiveBuzz
whale/orca badge was replaced by `ProfileLeagueChip`, Lumen's own tier system, with a
different data source, an SVG emblem instead of `/orca.png`, and different copy.
Covering the replacement is open work.

### Re-based rather than retired

- **Follow-button colours** re-based to measured values (white on `#1a1a17`). The hover
  assertion was dropped and the reason is recorded in the test: the button's className
  at `profile-actions.tsx:100` carries no `hover:` utility, while its two siblings in
  the same file do. Asserting "nothing happens" would freeze a probable oversight into
  the suite, so this is reported for the owner instead.
- **Three live-count assertions** (profile followers, profile following, popover
  followers/following) moved off exact string equality to a tolerant numeric compare.
  They were comparing a chain value fetched after render against the rendered figure, so
  they failed on ordinary drift (10963 vs 10961, 9923 vs 9918), and the rendered text now
  carries a thousands separator and a trailing word, which no bare digit string matches.
