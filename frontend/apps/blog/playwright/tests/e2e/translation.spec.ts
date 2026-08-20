import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { PostPage } from '../support/pages/postPage';
import { ProfilePage } from '../support/pages/profilePage';
import { CommentViewPage } from '../support/pages/commentViewPage';
import { CommunitiesPage } from '../support/pages/communitiesPage';
import { CommunitiesExplorePage } from '../support/pages/communitiesExplorerPage';
import { WitnessPage } from '../support/pages/witnessesPage';
/* ★★★ THE `WalletPage` IMPORT IS GONE, AND IT WAS ZEROING THE ENTIRE SUITE
   (2026-08-19). It pointed at `apps/wallet/playwright/.../walletPage`, and
   `apps/wallet` DOES NOT EXIST in this fork — `apps/` contains only `blog`, and
   Lumen's wallet is a feature inside it. Playwright resolves every spec file at
   collection time, so this one unresolvable require made the whole run report
   "Total: 0 tests in 0 files" — not a failure, an empty run. That is why the
   ledger recorded 35 specs as "never run": the suite could not be collected at
   all, and a green-looking `0 passed` never said so.

   The object was never used: `walletPage.` appears zero times in this file. The
   declaration and the `new WalletPage(page)` line below are removed with it. */
import { LoginToVoteDialog } from '../support/pages/loginToVoteDialog';

/**
 * ★ STILL SKIPPED 2026-08-11 — but the old reason was FALSE and is replaced.
 *
 * Old reason: "Skipped due to move out translation from Denser". Translation did
 * not move out. i18n is fully live: i18next + next-i18next are dependencies
 * (package.json:95-100), `i18n/settings.ts:2` ships NINE locales
 * (ar, en, es, fr, it, ja, pl, ru, zh) with populated
 * `locales/<code>/common_blog.json`, and the switcher component
 * (`features/layouts/lang-toggle.tsx:49,60`) still renders exactly the
 * `toggle-language` and per-locale `pl` testids this file drives.
 *
 * THE REAL BLOCKER — REQUIRES AN AUTHENTICATED SESSION:
 * `LangToggle` is mounted in exactly ONE place, and it is behind login:
 * `features/layouts/site-header/user-menu.tsx:158` (`<LangToggle logged={true} />`),
 * inside the account dropdown that only renders when `user?.isLoggedIn`
 * (app-header.tsx:370-386). An anonymous visitor gets `login-link` instead
 * (app-header.tsx:481). Confirmed live 2026-08-11: `toggle-language` has ZERO
 * occurrences in the HTML of `/`. Every one of the 13 tests below opens with
 * `homePage.toggleLanguage.click()`, so all 13 are blocked by that one fact —
 * nothing to do with Denser, or with the specs' own subjects.
 *
 * TO ENABLE: seed a session with support/fixture-auth/seeder.ts, open the account
 * menu (`profile-avatar-button` -> `user-profile-menu-content`), then click
 * `toggle-language` from inside it. Each test's own remaining staleness is noted
 * on it individually below.
 *
 * ★ SEPARATE i18n DEFECT FOUND WHILE TRIAGING THIS (reported, not fixed here):
 * the primary navigation is HARD-CODED ENGLISH and never translated —
 * `features/layouts/left-rail.tsx:14-27` is a plain `LABELS` object carrying its
 * own `// TODO: move to i18n (t('...'))`. So switching to Polish leaves Home /
 * Profile / Wallet / Creator Tokens / Witnesses / Proposals / Settings in English.
 * That is precisely the regression the first test below was written to catch.
 */
test.describe.skip('Translation tests', () => {
  let homePage: HomePage;
  let postPage: PostPage;
  let profilePage: ProfilePage;
  let commentViewPage: CommentViewPage;
  let communitiesPage: CommunitiesPage;
  let witnessPage: WitnessPage;
  let loginDialogEnglish: LoginToVoteDialog;

  test.beforeEach(async ({ page, browserName }) => {
    homePage = new HomePage(page);
    postPage = new PostPage(page);
    profilePage = new ProfilePage(page);
    commentViewPage = new CommentViewPage(page);
    communitiesPage = new CommunitiesPage(page);
    witnessPage = new WitnessPage(page);
    test.skip(browserName === 'webkit', 'Automatic test works well on chromium');
  });

  /*
   * ★ ALSO STALE INDEPENDENTLY (bucket B). It reads the four old top-nav tabs —
   * `nav-posts-link` / `nav-proposals-link` / `nav-witnesses-link` /
   * `nav-our-dapps-link` — and expects 'Posty' / 'Propozycje' / 'Delegaci' /
   * 'Nasze dApps'. All four testids have 0 hits in product source; that tab bar was
   * replaced by `LeftRail`. And per the file header, LeftRail's labels are not
   * translated at all, so the Polish assertions could not pass even against the new
   * testids. Rewriting this needs a genuinely translated surface to assert on.
   */
  test('Check if user can change language', async ({ page }) => {
    await homePage.goto();
    await expect(homePage.toggleLanguage).toBeVisible();
    await homePage.toggleLanguage.click();
    await homePage.page.waitForSelector(homePage.languageMenu['_selector']);
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();

    const postsTabText = await homePage.getNavPostsLink.textContent();
    const proposalsTabText = await homePage.getNavProposalsLink.textContent();
    const witnessesTabText = await homePage.getNavWitnessesLink.textContent();

    await expect(homePage.getMainTimeLineOfPosts.first()).toBeVisible();
    await expect(postsTabText).toBe('Posty');
    await expect(proposalsTabText).toBe('Propozycje');
    await expect(witnessesTabText).toBe('Delegaci');
  });

  // DELETED 2026-08-10: 'Profile page - user info' asserted on
  // `[data-testid="profile-navigation"]` (the legacy Blog/Posts/Replies/
  // Social/Notifications tab bar) and its Followers/Following/Blacklist/
  // Muted-list links, none of which the redesigned profile renders any more
  // (features/account-profile/redesign/*; profile-navigation is confirmed
  // absent from current source). This whole describe block is already
  // `test.describe.skip`d ("Skipped due to move out translation from
  // Denser"), so nothing here runs today regardless.

  // DELETED 2026-08-10: 'Profile page - posts tab', 'Profile page - social
  // tab' (already test.skip) and 'Profile page - notifications tab' all
  // drove `profilePostsLink`/`profileSocialLink`/`profileNotificationsLink`
  // — the same removed `[data-testid="profile-navigation"]` chrome as the
  // deleted 'Profile page - user info' above. `/notifications` also 404s
  // today (route deleted along with the chrome that linked to it).

  // test('Wallet page', async({page}) =>{
  //   await page.goto('http://localhost:4000/@gtg/transfers')
  //   await expect(page.locator('.container.p-0').last()).toBeVisible()
  //   await homePage.toggleLanguage.click()
  //   await expect(homePage.languageMenu).toBeVisible()
  //   await page.getByRole('menuitem', { name: 'pl' }).click()
  //   await expect(page.locator('.container.p-0').last()).toBeVisible()
  //   await expect(page.getByTestId('wallet-balances-link')).toHaveText('Salda')
  //   await expect(page.getByRole('link', { name: 'Delegacje' })).toBeVisible()
  //   await expect(page.getByTestId('wallet-hive-description')).toHaveText('Zbywalne tokeny, które mogą być przesłane gdziekolwiek w dowolnym momencie. HIVE mogą zostać również przekonwertowane na HIVE POWER w procesie nazywanym zwiększenie mocy.')
  //   await expect(page.getByTestId('wallet-hive-power-description')).toContainText('Tokeny wpływu, które zwiększają Twój wpływ na podział wypłat za publikowanie treści, oraz pozwalają Ci zarabiać na głosowaniu na treści. Część z Twoich jednostek wpływu HIVE POWER jest Ci oddelegowana. Delegowanie jednostek to czasowe użyczenie dla zwiększenia wpływu lub by pomóc nowym użytkownikom platformy w korzystaniu ze Hive. Kwota oddelegowanych jednostek może się zmieniać w czasie. ')
  //   await expect(page.getByTestId('wallet-account-history-description')).toContainText('Uważaj na spam i linki phishingowe w notatkach transakcji. Nie otwieraj linków od użytkowników, którym nie ufasz. Nie udostępniaj swoich kluczy prywatnych żadnym stronom internetowym osób trzecich. Transakcje nie zostaną wyświetlone, dopóki nie zostaną potwierdzone w blockchain, co może zająć kilka minut.')
  // })

  // ★ SUBJECT IS SOUND (bucket B). Verified 2026-08-11: `community-name`,
  // `community-name-unmoderated`, `community-subscribe-button` and
  // `community-new-post-button` all still exist, and the PL strings it asserts are
  // still correct in locales/pl/common_blog.json ('Społeczność', 'Subskrybuj',
  // 'Nowy post'). Blocked only by the file-level login precondition above.
  test.skip('Community page', async ({ page }) => {
    await homePage.goto();
    await homePage.getLeoFinanceCommunitiesLink.click();
    await expect(homePage.getHeaderLeoCommunities).toBeVisible();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    await homePage.page.waitForSelector(homePage.getHeaderLeoCommunities['_selector']);
    await expect(homePage.getHeaderLeoCommunities).toBeVisible();
    await expect(await page.locator('[data-testid="community-name-unmoderated"]').textContent()).toBe(
      'Społeczność'
    );
    if(!await communitiesPage.communitySubscribeButton.first().isVisible())
      await expect(await communitiesPage.communitySubscribeButton.last().textContent()).toBe('Subskrybuj');
    else
      await expect(await communitiesPage.communitySubscribeButton.first().textContent()).toBe('Subskrybuj');
    await expect(await communitiesPage.communityNewPostButton.textContent()).toBe('Nowy post');
  });

  test('Explore communities page', async ({ page }) => {
    const communitiesExplorerPage = new CommunitiesExplorePage(page);
    await homePage.goto();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();

    await expect(await page.getByTestId('community-name').textContent()).toBe('Wszystkie posty');
    await expect(await homePage.getExploreCommunities).toHaveText('Pokaż więcej społeczności...');
    await homePage.getExploreCommunities.click();
    // Wait for communities page to load
    await expect(communitiesExplorerPage.communitiesHeaderPage).toBeVisible();
    // Click PL language again
    // Without this on CI this tests found english page instead polish
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Wait for Polish translation to appear
    await expect(communitiesExplorerPage.communitiesHeaderPage).toHaveText('Społeczności');
    await expect(communitiesExplorerPage.searchInput).toHaveAttribute('placeholder', 'Szukaj...');
    await expect(communitiesExplorerPage.communityListItemFooter.first()).toContainText('subskrybentów');
    await expect(communitiesExplorerPage.communityListItemFooter.first()).toContainText('autorów');
    await expect(communitiesExplorerPage.communityListItemFooter.first()).toContainText('postów');
    await expect(communitiesExplorerPage.communityListItemFooter.first()).toContainText('administrator');
    await expect(communitiesExplorerPage.communityListItemSubscribeButton.first()).toContainText(
      'Subskrybuj'
    );
  });

  // test('Witnesses page', async ({page}) =>{
  //   await page.goto('http://localhost:4000/~witnesses')
  //   await expect(witnessPage.witnessHeaderTitle).toBeVisible()
  //   await homePage.toggleLanguage.click()
  //   await expect(homePage.languageMenu).toBeVisible()
  //   await page.getByRole('menuitem', { name: 'pl' }).click()
  //   await expect(witnessPage.witnessHeaderTitle).toBeVisible()
  //   await expect(await witnessPage.witnessHeaderTitle.textContent()).toBe('Głosowanie na delegatów')
  //   await expect(await witnessPage.witnessHeaderDescription.textContent()).toBe(
  //   'Na poniższej liście znajduje sie 100 pierwszych delegatów, aktywnych jak również nieaktywnych. Każdy delegat powyżej 100 pozycji jest filtrowany i nie wyświetlany jeśli nie wyprodukował bloku w ostatnich 30 dniach.')
  //   await expect(page.getByRole('button', { name: 'Zagłosuj' })).toBeVisible()
  //   await expect(page.getByRole('button', { name: 'Ustaw pełnomocnika' })).toBeVisible()
  // })

  // Skipped due to new login form
  // ★ MOSTLY SOUND, ONE COPY DELTA (bucket B). `comment-reply`, `comment-respons`,
  // `reply-editor` and `article-title` all still exist and the PL strings hold, BUT
  // it does getByText('Wstaw obrazy, przeciągając i upuszczając, wklejając ze
  // schowka lub za pomocą wyb') and the `insert_images` key was shortened — it now
  // ends '...lub za pomocą' (locales/pl/common_blog.json:466), so that substring no
  // longer matches. Fix that line when lifting the login precondition above.
  test.skip('Post page', async ({ page }) => {
    await homePage.goto();
    await homePage.getFirstPostTitle.click();
    await expect(postPage.articleTitle).toBeVisible();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    await expect(postPage.articleTitle).toBeVisible();
    await expect(await postPage.articleAuthorData.textContent()).toContain('temu');
    await expect(await postPage.commentReplay.textContent()).toBe('Odpowiedz');

    await postPage.commentCardsFooterReply.first().click();
    await expect(postPage.commentCardsFooterReplyEditor).toBeVisible();
    await expect(page.getByPlaceholder('Odpowiedz')).toBeVisible();
    await expect(
      page.getByText('Wstaw obrazy, przeciągając i upuszczając, wklejając ze schowka lub za pomocą wyb')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anuluj' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wyślij' })).toBeVisible();

    await postPage.getCommentFilter.click();
    await expect(await postPage.getCommentFilterList.getByText('Popularność')).toBeVisible();
    await expect(await postPage.getCommentFilterList.getByText('Liczba głosów')).toBeVisible();
    await expect(await postPage.getCommentFilterList.getByText('Wiek')).toBeVisible();
  });

  test('Post page - validate tooltips in the footer', async ({ page }) => {
    await homePage.goto();
    await homePage.getFirstPostTitle.click();
    await expect(postPage.articleTitle).toBeVisible();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Wait for Polish translation to load on post page
    await expect(postPage.articleTitle).toBeVisible();
    // Validate post footer upvote and downvote buttons tooltips
    const expectedUpvoteTooltipText: string = 'Głos zaGłos za';
    const expectedDownvoteTooltipText: string = 'Głos przeciwGłos przeciw';
    await postPage.upvoteButton.locator('svg').hover();
    await expect(postPage.postFooterUpvoteTooltip).toContainText(expectedUpvoteTooltipText);
    await postPage.downvoteButton.locator('svg').hover();
    await expect(postPage.postFooterDownvoteTooltip).toContainText(expectedDownvoteTooltipText);
    // Validate post footer payout tooltip
    const expectedPayoutsTooltipText1: string = 'Wypłacana kwota';
    const expectedPayoutsTooltipText2: string = 'Wypłata za';
    await postPage.footerPayouts.hover();
    await expect(postPage.footerPayoutsTooltip).toContainText(expectedPayoutsTooltipText1);
    await expect(postPage.footerPayoutsTooltip).toContainText(expectedPayoutsTooltipText2);
    // Validate post footer list of votes
    await postPage.postFooterVotes.hover();
    await expect(postPage.postVoterList).toBeVisible();
    // Validate post reblog button tooltip
    const expectedReblogTooltipText: string = 'Rebloguj';
    await postPage.footerReblogIcon.hover();
    await expect(postPage.footerReblogTooltip).toContainText(expectedReblogTooltipText);
    // Validate post response button tooltip
    const expectedResponseTooltipText: RegExp = /odpowied[zź]i?/;
    await postPage.commentResponse.hover();
    await expect(postPage.postResponseTooltip).toContainText(expectedResponseTooltipText);
    // Validate title of social elements
    const expectedSocialTooltipText: string = 'Udostępnij na';
    await expect(postPage.facebookIcon).toHaveAttribute('title', `${expectedSocialTooltipText} Facebook`);
    await expect(postPage.twitterIcon).toHaveAttribute('title', `${expectedSocialTooltipText} Twitter`);
    await expect(postPage.linkedinIcon).toHaveAttribute('title', `${expectedSocialTooltipText} LinkedIn`);
    await expect(postPage.redditIcon).toHaveAttribute('title', `${expectedSocialTooltipText} Reddit`);
    await expect(postPage.sharePostBtn.locator('..')).toHaveAttribute('title', 'Udostępnij post');
  });

  // Skipped due to failing only on CI
  // ★ SUBJECT IS SOUND (bucket B). PL strings all still present — 'Obserwuj'
  // (locales/pl:269/414), 'Obserwujący' (:415), 'Obserwowani' (:416). The old
  // per-test reason was "failing only on CI"; the real blocker is the file-level
  // login precondition above.
  test.skip('User hover card', async ({ page }) => {
    await homePage.goto();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    await page.waitForTimeout(10000);
    await homePage.getFirstPostTitle.click();
    await expect(postPage.articleTitle).toBeVisible();
    await postPage.articleAuthorName.hover();
    await page.waitForTimeout(4000);
    await expect(await postPage.userHoverCardFollowButton.textContent()).toBe('Obserwuj');
    await expect(await postPage.userFollowingHoverCard.textContent()).toContain('Obserwowani');
    await expect(await postPage.userFollowersHoverCard.textContent()).toContain('Obserwujący');
  });

  // Skipped due to new login form
  // ★ DOUBLY STALE (bucket B, largest of the set). The community-sidebar PL strings
  // it asserts are intact, but it also drives (a) `theme-mode` light/dark/system
  // strings — the app is light-only now and has no theme control at all
  // (features/layouts/providers.tsx:27-38) — and (b) `login-btn` / `signup-btn`,
  // neither of which exists in the current header (app-header.tsx:481 renders
  // `login-link`). Both of those sections must be dropped, not just re-selectored.
  test.skip('Home page', async ({ page }) => {
    await page.waitForTimeout(3000);
    loginDialogEnglish = new LoginToVoteDialog(page);

    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    await expect(page.getByText('Popularne Społeczności')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pokaż więcej społeczności...' })).toBeVisible();
    await expect(await page.getByTestId('community-name').textContent()).toBe('Wszystkie posty');

    await expect(await homePage.loginBtn.textContent()).toBe('Zaloguj się');
    await expect(await homePage.signupBtn.textContent()).toBe('Zapisz się');

    await homePage.loginBtn.click();

    await loginDialogEnglish.validateLoginDialogInPolishIsVisible();
    await loginDialogEnglish.closeLoginDialog();

    await homePage.themeMode.click();
    await expect(page.getByRole('menuitem', { name: 'Tryb jasny' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Tryb ciemny' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Domyślny z systemu' })).toBeVisible();
    await homePage.themeMode.click({ force: true });

    await homePage.getFilterPosts.click();
    await expect(
      page.locator('div').filter({ hasText: 'PopularneNa czasieNoweWynagrodzeniaWyciszone' }).nth(2)
    ).toBeVisible();
  });

  test('Home page - validate tooltips of the first post card upvote and downvote buttons', async ({
    page
  }) => {
    // Load home page
    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    // Open language menu and choose pl
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Load and validate the polish version of the home page is ready
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    // Validate upvote button tooltip
    const expectedUpvoteTooltipText: string = 'Głos zaGłos za';
    await homePage.getFirstPostUpvoteButton.hover();
    await expect(homePage.getFirstPostUpvoteButtonTooltip).toHaveText(expectedUpvoteTooltipText);
    // Validate downvote button tooltip
    const expectedDownvoteTooltipText: string = 'Głos przeciwGłos przeciw';
    await homePage.getFirstPostDownvoteButton.hover();
    await expect(homePage.getFirstPostDownvoteButtonTooltip).toHaveText(expectedDownvoteTooltipText);
  });

  test('Home page - validate tooltips of the first post card payouts', async ({ page }) => {
    // Load home page
    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    // Open language menu and choose pl
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Load and validate the polish version of the home page is ready
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    // Validate post payouts button tooltip
    const expectedPayoutsTooltipText1: string = 'Wypłacana kwota';
    const expectedPayoutsTooltipText2: string = 'Wypłata za';
    await homePage.getFirstPostPayout.hover();
    await expect(homePage.getFirstPostPayoutTooltip).toContainText(expectedPayoutsTooltipText1);
    await expect(homePage.getFirstPostPayoutTooltip).toContainText(expectedPayoutsTooltipText2);
  });

  test('Home page - validate tooltips of the first post card votes', async ({ page }) => {
    // Load home page
    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    // Open language menu and choose pl
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Load and validate the polish version of the home page is ready
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    // Validate post votes button tooltip
    const expectedVotesTooltipText: string = 'Liczba głosów';
    await homePage.getFirstPostVotes.hover();
    await expect(homePage.getFirstPostVotesTooltip).toContainText(expectedVotesTooltipText);
  });

  test('Home page - validate tooltips of the first post card responses', async ({ page }) => {
    // Load home page
    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    // Open language menu and choose pl
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Load and validate the polish version of the home page is ready
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    // Validate post votes button tooltip
    const expectedResponsesTooltipText: string = 'Kliknij by odpowiedzieć';
    await homePage.getFirstPostResponseButton.hover();
    await expect(homePage.getFirstPostResponseButtonTooltip).toContainText(expectedResponsesTooltipText);
  });

  test('Post page - validate tooltips of the reblog button', async ({ page }) => {
    // Load home page
    await homePage.goto();
    await expect(homePage.getFirstPostTitle).toBeVisible();
    // Open language menu and choose pl
    await homePage.toggleLanguage.click();
    await expect(homePage.languageMenu.first()).toBeVisible();
    await homePage.languageMenuPl.click();
    // Load and validate the polish version of the home page is ready
    await homePage.page.waitForSelector(homePage.getTrendingCommunitiesSideBar['_selector']);
    await expect(homePage.getTrendingCommunitiesSideBar).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wszystkie posty' })).toBeVisible();
    // Navigate to first post page (reblog tooltip with "Reblog" text is only on post pages)
    await homePage.getFirstPostTitle.click();
    await page.waitForSelector('[data-testid="article-title"]');
    // Validate post reblog button tooltip
    const expectedReblogTooltipText: string = 'Rebloguj';
    await postPage.footerReblogIcon.hover();
    await expect(postPage.footerReblogTooltip).toContainText(expectedReblogTooltipText);
  });

  // Skipped due to new login form
  /*
   * ★ 'Navigation - right side' DELETED 2026-08-11 — FEATURE GONE (bucket A).
   *
   * It opened `nav-sidebar-menu-button`, waited for `nav-sidebar-menu-content` and
   * asserted a fixed ordered list of `li.text-foreground` entries including
   * 'HBauth', 'FAQ', 'Block Explorer', 'Odzyskiwanie skradzionego konta' and
   * 'Zmiana hasła konta'. Both testids have 0 hits in product source, and the
   * static link list they belonged to no longer exists: the hamburger is now
   * `mobile-nav-trigger` -> `mobile-nav-content` rendering the SAME `LeftRail` as
   * desktop, deliberately (features/layouts/mobile-nav.tsx:14-28 documents the
   * decision). There is no list of those links anywhere to re-point this at.
   */
});
