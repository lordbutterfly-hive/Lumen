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