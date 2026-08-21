import { Locator, Page, expect } from '@playwright/test';
import { PostPage } from './postPage';
import { ProfilePage } from './profilePage';

/**
 * Common viewport sizes for responsive testing
 */
export const MOBILE_VIEWPORT = { width: 375, height: 667 }; // iPhone SE
export const TABLET_VIEWPORT = { width: 768, height: 1024 }; // iPad

export class HomePage {
  readonly page: Page;
  readonly postPage: PostPage;
  readonly getLifestyleCommunityInMySubscriptions: Locator;
  readonly getPostListTrending: Locator;
  readonly getPostListNew: Locator;
  readonly getPostListHot: Locator;
  readonly getPostListPayouts: Locator;
  readonly getPostListMuted: Locator;
  readonly getCommunityNameElement: Locator;
  readonly getTrendingCommunitiesSideBar: Locator;
  readonly getTrendingCommunitiesSideBarLinks: Locator;
  readonly getTrandingCommunitiesHeader: Locator;
  readonly getMyFriendsSidebarLink: Locator;
  readonly getMyCommunitiesSidebarLink: Locator;
  readonly getExploreCommunities: Locator;
  readonly getLeoFinanceCommunitiesLink: Locator;
  readonly getHeaderLeoCommunities: Locator;
  readonly getWorldmappinCommunitiesLink: Locator;
  readonly getHeaderWorldmappinCommunities: Locator;
  readonly getLifestyleCommunityLink: Locator;
  readonly getHomeNavLink: Locator;
  readonly getNavPostsLink: Locator;
  readonly getNavProposalsLink: Locator;
  readonly getNavWitnessesLink: Locator;
  readonly getNavHbauthLink: Locator;
  readonly getNavHbauthButton: Locator;
  readonly getNavSearchInput: Locator;
  readonly getNavSearchLink: Locator;
  readonly getNavSearchAIInput: Locator;
  readonly getNavSearchClassicInput: Locator;
  readonly getNavSearchTagsInput: Locator;
  readonly getNavUserAvatar: Locator;
  readonly getNavCreatePost: Locator;
  readonly getNavSidebarMenu: any;
  readonly getNavProfileMenuContent: any;
  readonly getNavSidebarMenuContent: Locator;
  readonly getNavSidebarMenuContentCloseButton: Locator;
  readonly getHeaderAllCommunities: Locator;
  readonly getMainTimeLineOfPosts: any;
  readonly getPostCardAvatar: Locator;
  readonly getPostCardFooter: Locator;
  readonly getUpvoteButton: Locator;
  readonly getFirstPostUpvoteButton: Locator;
  readonly getFirstPostUpvoteButtonIcon: Locator;
  readonly firstPostCardUpvoteButtonLocator: Locator;
  readonly firstPostCardDownvoteButtonLocator: Locator;
  readonly getSecondPostDownvoteButton: Locator;
  readonly getSecondPostDownvoteButtonIcon: Locator;
  readonly getUpvoteButtonTooltip: Locator;
  readonly getDownvoteButton: Locator;
  readonly getReblogCountDisplay: Locator;
  readonly getFirstPostDownvoteButton: Locator;
  readonly getDownvoteButtonTooltip: Locator;
  readonly getFirstPostDownvoteButtonTooltip: Locator;
  readonly getFirstPostUpvoteButtonTooltip: Locator;
  readonly getFirstPostResponseButton: Locator;
  readonly getFirstPostResponseButtonTooltip: Locator;
  readonly getFirstPostCardFooter: Locator;
  readonly getFirstPostListItem: Locator;
  readonly getFirstPostListItemReblogButton: Locator;
  readonly getFirstPostCardAvatar: Locator;
  readonly getFirstPostAuthor: Locator;
  readonly getFirstPostAuthorReputation: Locator;
  readonly getFirstPostCardCommunityLink: Locator;
  readonly getFirstPostCardCategoryLink: Locator;
  readonly getFirstPostCardTimestampLink: Locator;
  readonly getFirstPostTitle: any;
  readonly getFirstPostPayout: Locator;
  readonly getFirstPostPayoutTooltip: Locator;
  readonly getFirstPostVotes: Locator;
  readonly getFirstPostVotesTooltip: Locator;
  readonly getFirstPostChildren: Locator;
  readonly getFirstPostChildernIcon: Locator;
  readonly getFirstPostChildernCommentNumber: Locator;
  readonly getFirstPostChildernTooltip: Locator;
  readonly getFirstPostReblogCountDisplay: Locator;
  readonly getFirstPostReblogCountTooltip: Locator;
  readonly getSecondPostReblogCountDisplay: Locator;
  readonly getSecondPostReblogCountTooltip: Locator;
  readonly getPostChildren: Locator;
  readonly getBody: Locator;
  readonly getThemeModeButton: Locator;
  readonly getThemeModeItem: Locator;
  readonly getFilterPosts: Locator;
  readonly getFilterPostsList: Locator;
  readonly getCardExploreHive: Locator;
  readonly getCardExploreHiveTitle: Locator;
  readonly getCardExploreHiveLinks: Locator;
  readonly getCardUserShortcuts: Locator;
  readonly getCardUserShortcutsTitle: Locator;
  readonly getCardUserShortcutsLinks: Locator;
  readonly postTitle: Locator;
  readonly postDescription: Locator;
  readonly loginBtn: Locator;
  readonly signupBtn: Locator;
  readonly loginModal: Locator;
  readonly loginModalHeader: Locator;
  readonly loginModalUsernameInput: Locator;
  readonly loginModalPasswordInput: Locator;
  readonly loginModalHiveAuthText: Locator;
  readonly loginModalKeepLoggedInText: Locator;
  readonly hivsignerBtn: Locator;
  readonly signupPageHeader: Locator;
  readonly postReputationTooltip: Locator;
  readonly postCardAffiliationTag: Locator;
  readonly postCardPoweredUp100Trigger: Locator;
  readonly postCardPoweredUp100TriggerLink: Locator;
  readonly postCardPoweredUp100Tooltip: Locator;
  readonly toggleLanguage: Locator;
  readonly languageMenu: Locator;
  readonly languageMenuPl: Locator;
  readonly themeMode: Locator;
  readonly articleTitle: Locator;
  readonly articleBodyString: string;
  readonly articleAuthor: string;
  readonly userPopoverCardContent: string;
  readonly profileFollowBtn: string;
  readonly commentCard: string;
  readonly commentListItem: string;
  readonly postsImages: string;
  readonly postAuthor: string;
  readonly profileAvatar: string;

  // for logged in user
  readonly profileAvatarButton: Locator;

  /**
   * Where Lumen's signed-out post timeline lives. See `goto()`.
   *
   * `/` — NOT `/trending`. `/trending` is a retired route that only redirects here
   * (`app/(main-and-community)/trending/page.tsx:13-15`), so pointing the harness at
   * it bought nothing and cost a redirect. Verified 2026-08-11.
   */
  static readonly HOME_TIMELINE_PATH = '/';

  /**
   * ★ THE LUMEN CARD *OR* THE CLASSIC ONE, AND BOTH ARE LOAD-BEARING (2026-08-09).
   *
   * Lumen replaced the feed card: `/trending` and the discovery feed render
   * `features/discovery-feed/medium-post-card.tsx` (`medium-card*` testids). But the
   * CLASSIC `post-list-item` card is still live on profile post tabs, search results
   * and tag pages (`features/list-of-posts/post-list-item.tsx` via
   * `account-profile/posts-content`, `search/*`, `tags-pages/list-of-posts`).
   *
   * So this page object cannot simply be repointed — it has to match either card, or
   * it breaks whichever half it does not name. A comma selector is exactly that, and
   * it keeps one page object working across both, which is why the remapped locators
   * below are all built from these two constants rather than from a literal.
   */
  static readonly CARD_ANY = '[data-testid="medium-card"], li[data-testid="post-list-item"]';
  /** Lumen's card only, for assertions about markup the classic card does not have. */
  static readonly CARD_LUMEN = '[data-testid="medium-card"]';

  constructor(page: Page) {
    this.page = page;
    this.postPage = new PostPage(page);
    this.getLifestyleCommunityInMySubscriptions = page
        .locator('ul')
        .filter({ hasText: /^Lifestyle$/ })
        .getByRole('link');
    this.getPostListTrending = page.getByTestId('post-list-trending');
    this.getPostListNew = page.getByTestId('post-list-created');
    this.getPostListHot = page.getByTestId('post-list-hot');
    this.getPostListPayouts = page.getByTestId('post-list-payout');
    this.getPostListMuted = page.getByTestId('post-list-muted');
    this.getTrendingCommunitiesSideBar = page.locator('[data-testid="card-trending-comunities"]');
    this.getTrendingCommunitiesSideBarLinks = this.getTrendingCommunitiesSideBar.locator('div ul li a');
    this.getTrandingCommunitiesHeader = this.getTrendingCommunitiesSideBar
      .locator('a')
      .getByText('All posts');
    this.getMyFriendsSidebarLink = this.getTrendingCommunitiesSideBar
      .locator('a')
      .getByText('My friends');
    this.getMyCommunitiesSidebarLink = this.getTrendingCommunitiesSideBar
      .locator('a')
      .getByText('My communities');
    this.getExploreCommunities = page.locator('[data-testid="explore-communities-link"]'); // page.getByText('Explore communities...');
    this.getLeoFinanceCommunitiesLink = this.getTrendingCommunitiesSideBar
      .locator('a')
      .getByText('LeoFinance');
    this.getCommunityNameElement = page.getByTestId('community-name');
    this.getHeaderLeoCommunities = page.locator('[data-testid="community-name"]').getByText('LeoFinance');
    this.getWorldmappinCommunitiesLink = this.getTrendingCommunitiesSideBar.locator('a:text("Worldmappin")');
    this.getHeaderWorldmappinCommunities = page
      .locator('[data-testid="community-name"]')
      .getByText('Worldmappin');
    this.getLifestyleCommunityLink = page.getByTestId('card-trending-comunities').getByText('Lifestyle');
    this.getHomeNavLink = page.locator('header a span:text("Hive Blog")');
    this.getNavPostsLink = page.locator('[data-testid="left-rail-home"]');
    this.getNavProposalsLink = page.locator('[data-testid="left-rail-vote-proposals"]');
    this.getNavWitnessesLink = page.locator('[data-testid="left-rail-vote-witness"]');
    this.getHeaderAllCommunities = page.locator('[data-testid="card-trending-comunities"]');
    // Either card — Lumen's on the feed/trending, the classic one on profile tabs,
    // search and tag pages. See HomePage.CARD_ANY.
    this.getMainTimeLineOfPosts = page.locator(HomePage.CARD_ANY);
    // `.locator('div').first()` on the classic card reached its inner wrapper. The
    // Lumen card's own root IS the item, so scope to the card and let callers drill in.
    this.getFirstPostListItem = this.getMainTimeLineOfPosts.first();
    this.getFirstPostListItemReblogButton = this.getFirstPostListItem
      .locator('[data-testid="medium-card-reblog"], [data-testid="post-card-reblog"]')
      .first();
    this.getPostCardAvatar = page.locator('[data-testid="medium-card-avatar"], [data-testid="post-card-avatar"]');
    this.getFirstPostCardAvatar = this.getPostCardAvatar.first();
    this.getFirstPostAuthor = page
      .locator('[data-testid="medium-card-author"], [data-testid="post-author"]')
      .first();
    // ★ LUMEN'S FEED CARD SHOWS NO REPUTATION, AND THIS SELECTOR CANNOT FIX THAT.
    //
    // `post-author-reputation` exists in exactly one component —
    // `features/list-of-posts/post-list-item.tsx` — which is the CLASSIC card, still
    // live on profile post tabs, search results and tag pages. Lumen's
    // `medium-post-card.tsx` deliberately renders no reputation and no rank at all, so
    // on `/trending` (where `goto()` now lands) this locator resolves to nothing and
    // the two `mainTimeline` tests asserting "styles of the reputation in the post card
    // header" are asserting markup the fork removed. That is a product decision to
    // revisit, not a selector to repoint — pointing it at the hover popover would make
    // the tests pass while testing a different element.
    //
    // Where reputation IS rendered: the author hover popover
    // (`user-popover-card.tsx`, `author-reputation`), the redesigned profile
    // (`profile-reputation`), and the classic card above.
    this.getFirstPostAuthorReputation = page.locator('[data-testid="post-author-reputation"]').first();
    this.getFirstPostCardCommunityLink = page.locator('[data-testid="post-card-community"]').first();
    this.getFirstPostCardCategoryLink = page.locator('[data-testid="post-card-category"]').first();
    this.getFirstPostCardTimestampLink = page.locator('[data-testid="post-card-timestamp"]').first();
    // Lumen's card exposes the title as its own testid; the classic one only had an
    // `h3 a`, so keep both rather than depend on a heading level that already differs.
    this.getFirstPostTitle = page
      .locator('[data-testid="medium-card-title"], li[data-testid="post-list-item"] h3 a')
      .first();
    this.getFirstPostPayout = page
      .locator('[data-testid="medium-card-payout"], [data-testid="post-payout"]')
      .first();
    this.getFirstPostPayoutTooltip = page.locator('[data-testid="payout-post-card-tooltip"]').first();
    this.getFirstPostVotes = page.locator('[data-testid="post-total-votes"]').first();
    this.getFirstPostVotesTooltip = page.locator('[data-testid="post-card-votes-tooltip"]').first();
    this.getFirstPostResponseButton = page.locator('[data-testid="post-card-response-link"]').first();
    this.getFirstPostResponseButtonTooltip = page.locator('[data-testid="post-card-responses"]');
    this.getFirstPostChildren = page.locator('[data-testid="post-children"]').first();
    this.getFirstPostChildernIcon = this.getFirstPostChildren.locator('a:nth-of-type(1)');
    this.getFirstPostChildernCommentNumber = this.getFirstPostChildren.locator('a:nth-of-type(2)');
    this.getFirstPostChildernTooltip = page.locator('[data-testid="post-card-responses"]');
    this.getPostChildren = page.locator('[data-testid="post-children"]');
    this.getPostCardFooter = page.locator('[data-testid="medium-card-footer"], [data-testid="post-card-footer"]');
    this.getUpvoteButton = page.locator('[data-testid="upvote-button"]');
    this.getFirstPostUpvoteButton = this.getUpvoteButton.first();
    this.getFirstPostUpvoteButtonIcon = this.getFirstPostUpvoteButton.locator('svg');
    this.firstPostCardUpvoteButtonLocator = page
      .locator('[data-testid="post-card-footer"], [data-testid="medium-card-footer"]')
      .first()
      .locator('[data-testid="upvote-button"]')
      .locator('svg');
    this.firstPostCardDownvoteButtonLocator = page
      .locator('[data-testid="post-card-footer"], [data-testid="medium-card-footer"]')
      .first()
      .locator('[data-testid="downvote-button"]')
      .locator('svg');
    this.getSecondPostDownvoteButton = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .nth(1)
      .getByTestId('downvote-button');
    this.getSecondPostDownvoteButtonIcon = this.getSecondPostDownvoteButton.locator('svg');
    this.getFirstPostCardFooter = this.getPostCardFooter.first();
    this.getUpvoteButtonTooltip = page.locator('[data-testid="upvote-button-tooltip"]');
    this.getFirstPostUpvoteButtonTooltip = this.getUpvoteButtonTooltip.first();
    this.getDownvoteButton = page.locator('[data-testid="downvote-button"]');
    this.getFirstPostDownvoteButton = this.getDownvoteButton.first();
    this.getDownvoteButtonTooltip = page.locator('[data-testid="downvote-button-tooltip"]');
    this.getFirstPostDownvoteButtonTooltip = this.getDownvoteButtonTooltip.first();
    // Reblog button on list pages (interactive - opens confirmation dialog)
    this.getReblogCountDisplay = page.locator(
      '[data-testid="medium-card-reblog-count"], [data-testid="post-card-reblog-count"]'
    );
    this.getFirstPostReblogCountDisplay = this.getReblogCountDisplay.first();
    this.getFirstPostReblogCountTooltip = page.locator('[data-testid="post-card-reblog-count-tooltip"]').first();
    this.getSecondPostReblogCountDisplay = this.getReblogCountDisplay.nth(1);
    this.getSecondPostReblogCountTooltip = page.locator('[data-testid="post-card-reblog-count-tooltip"]').nth(1);
    this.getBody = page.locator('body');
    this.getThemeModeButton = page.locator('[data-testid="theme-mode"]');
    this.getThemeModeItem = page.locator('[data-testid="theme-mode-item"]');
    this.getFilterPosts = page.locator('[data-testid="posts-filter"]');
    this.getFilterPostsList = page.locator('[data-testid="posts-filter-list"]');
    this.getCardExploreHive = page.locator('[data-testid="card-explore-hive-desktop"]');
    this.getCardExploreHiveTitle = this.getCardExploreHive.locator('div h3');
    this.getCardExploreHiveLinks = this.getCardExploreHive.locator('div ul li');
    this.getCardUserShortcuts = page.locator('[data-testid="card-user-shortcuts"]');
    this.getCardUserShortcutsTitle = this.getCardUserShortcuts.locator('div h3');
    this.getCardUserShortcutsLinks = this.getCardUserShortcuts.locator('div ul li');
    this.getNavHbauthLink = page.locator('[data-testid="navbar-hbauth-link"]');
    this.getNavHbauthButton = this.getNavHbauthLink.locator('button');
    /*
      ★ THE VISIBLE ONE (2026-08-11). The header mounts SearchInput TWICE — a
      `hidden md:block` column at >=768px (app-header.tsx:215-217) and a
      `md:hidden` full-width row below it (app-header.tsx:502-504). Both are in the
      DOM at all times, so a bare `input[type="search"]` resolves to two elements
      and `expect(...).toBeVisible()` fails Playwright's strict mode regardless of
      which one is on screen. `:visible` picks whichever the current viewport shows.
    */
    this.getNavSearchInput = page.locator('[data-testid="header-search-input"]:visible');
    this.getNavSearchLink = page.locator('[data-testid="navbar-search-link"]');
    // ★ 2026-08-10: the mode dropdown, the AI/tag/account modes and their
    // placeholders ("AI Search", "Search tags...") are gone — one field now,
    // placeholder "Search posts", testid header-search-input (see
    // features/search/search-input.tsx and searchPage.ts's class doc
    // comment). getNavSearchAIInput/getNavSearchTagsInput are left defined
    // but unused: no live element matches them any more and nothing in this
    // suite calls them after the dropdown-dependent tests that did were
    // deleted.
    this.getNavSearchAIInput = page.getByPlaceholder('AI Search', { exact: true });
    this.getNavSearchClassicInput = page.getByTestId('header-search-input');
    this.getNavSearchTagsInput = page.getByPlaceholder('Search tags...');
    this.getNavUserAvatar = page.locator('[data-testid="profile-menu"]');
    this.getNavProfileMenuContent = page.locator('[data-testid="profile-menu-content"]');
    this.getNavCreatePost = page.locator('[data-testid="nav-pencil"]');
    /* ★ MOBILE-ONLY (2026-08-19). `nav-sidebar-menu-button` / `-content` are gone;
       their current equivalent is `mobile-nav-trigger` / `mobile-nav-content`,
       and it is exactly that — mobile. Measured: `display: none` at a 1280
       viewport, 40x40 at 390. On desktop the LeftRail is simply always open, so
       there is NO control to click and the old "open the sidebar, then click a
       link" flow has no desktop equivalent. Any test using this must set a mobile
       viewport first; at the default 1280 it will fail as not-visible, which is
       the honest failure rather than a missing-element one. */
    this.getNavSidebarMenu = page.locator('[data-testid="mobile-nav-trigger"]');
    this.getNavSidebarMenuContent = page.locator('[data-testid="mobile-nav-content"]');
    this.getNavSidebarMenuContentCloseButton = page.locator(
      '[data-testid="mobile-nav-content"] > button'
    );
    this.postTitle = page.locator('[data-testid="post-title"] a, a[data-testid="medium-card-title"]');
    /*
      ★ EITHER CARD'S DEK (2026-08-11), same reason as CARD_ANY above. Lumen's
      feed card names its description `medium-card-dek`
      (features/discovery-feed/medium-post-card.tsx:369); `post-description` only
      exists on the CLASSIC card (features/list-of-posts/post-list-item.tsx), which
      still ships on profile tabs, search and tag pages. The bare
      `post-description` locator matched nothing on the home timeline, which is
      what disabled 'move to the first post content by clicking the description of
      the post card'.
    */
    this.postDescription = page.locator(
      '[data-testid="medium-card-dek"], [data-testid="post-description"]'
    );
    this.loginBtn = page.locator('[data-testid="login-link"]');
    this.signupBtn = page.locator('[data-testid="signup-btn"]');
    this.loginModal = page.locator('[role="dialog"]');
    this.loginModalHeader = page.locator('h2');
    this.loginModalUsernameInput = page.locator('[name="username"]');
    this.loginModalPasswordInput = page.locator('[name="password"]');
    this.loginModalHiveAuthText = page.locator('[for="hiveAuth"]');
    this.loginModalKeepLoggedInText = page.locator('[for="remember"]');
    this.hivsignerBtn = page.locator('[data-testid="hivesigner-button"]');
    this.signupPageHeader = page.locator('h1.pb-3');
    this.postReputationTooltip = page.locator('[data-testid="post-reputation-tooltip"]');
    this.postCardAffiliationTag = page.locator('[data-testid="affiliation-tag-badge"]');
    this.postCardPoweredUp100Trigger = page.locator('[data-testid="powered-up-100-trigger"]');
    this.postCardPoweredUp100TriggerLink = this.postCardPoweredUp100Trigger.locator('a');
    this.postCardPoweredUp100Tooltip = page.locator('[data-testid="powered-up-100-tooltip"]');
    this.toggleLanguage = page.locator('[data-testid="toggle-language"]').first();
    this.languageMenu = page.locator('[role="menuitem"]');
    this.languageMenuPl = page.locator('[data-testid="pl"]').locator('..');
    this.themeMode = page.locator('[data-testid="theme-mode"]');
    this.articleTitle = page.locator('[data-testid="article-title"]');
    this.articleBodyString = '#articleBody';
    this.articleAuthor = '[data-testid="author-name-link"]';
    this.userPopoverCardContent = '[data-testid="user-popover-card-content"]';
    this.profileFollowBtn = '[data-testid="profile-follow-button"]';
    this.commentCard = '[data-testid="comment-card-description"]';
    this.commentListItem = '[data-testid="comment-list-item"]';
    this.postsImages = '[data-testid="post-image"]';
    this.postAuthor = '[data-testid="post-author"], [data-testid="medium-card-author"]';
    this.profileAvatar = '[data-testid="profile-avatar-button"]';

    // for logged in user
    this.profileAvatarButton = page.locator('[data-testid="profile-avatar-button"]');
  }

  /**
   * ★ GOES STRAIGHT TO `/` (2026-08-11). Supersedes the 2026-08-09 `/trending`
   * workaround, which had silently stopped working.
   *
   * The 2026-08-09 note said `/` rendered a signed-out landing page with zero post
   * cards, so `goto()` was repointed at `/trending`. Both halves of that are now
   * false, and the second half is worse than false — it is a tax on every test:
   *
   *  1. `/` DOES render the signed-out timeline. Measured 2026-08-11 against the warm
   *     dev server: `/` returns 200 and the discovery feed hydrates post cards.
   *  2. `/trending` is retired. `app/(main-and-community)/trending/page.tsx:13-15` is
   *     just `redirect('/')`, so the workaround pointed at a route whose only job is
   *     to send you back to the page it was trying to avoid.
   *  3. That redirect is NOT a cheap 30x. Because `redirect()` runs inside a streaming
   *     render, Next.js cannot set a Location header and falls back to a client-side
   *     bounce — `curl -D - http://localhost:3000/trending` returns
   *     `HTTP/1.1 200 OK` with `<meta http-equiv="refresh" content="1;url=/">` in the
   *     body. So the old `goto()` paid: render `/trending` (~6 s) + the meta-refresh's
   *     hard-coded 1 s + render `/` (~38 s cold) before a single assertion ran, against
   *     a 60 s per-test budget (`playwright.config.ts:19`).
   *  4. It was also a flake source. `waitForLoadState('domcontentloaded')` resolved on
   *     the *`/trending`* document; the meta-refresh then navigated the page out from
   *     under the very next line, which is exactly how you get intermittent
   *     "execution context was destroyed" on the card wait.
   *
   * Removing the hop gives ~7 s of the 60 s budget back to EVERY spec that enters
   * through here, and removes the destroyed-context race entirely.
   *
   * NOTE this is only the redirect hop. `/` itself is separately slow cold (~38-55 s
   * measured 2026-08-11); that is a product-side latency issue, not a harness one, and
   * is why the card wait below re-throws with an explicit diagnostic — so a run that
   * dies on home-feed latency is never mistaken for the spec's own subject failing.
   */
  async goto() {
    await this.page.goto(HomePage.HOME_TIMELINE_PATH);
    await this.page.waitForLoadState('domcontentloaded');
    // The cards are client-rendered from a React Query fetch, so the selector has to
    // be awaited rather than asserted — `domcontentloaded` fires long before it.
    try {
      await this.getMainTimeLineOfPosts.first().waitFor({ state: 'visible' });
    } catch (error) {
      throw new Error(
        `HomePage.goto(): no post card (${HomePage.CARD_ANY}) appeared on ` +
          `"${HomePage.HOME_TIMELINE_PATH}". This is the harness entry point, NOT this ` +
          `spec's subject — the signed-out home feed is known to take ~38-55s cold ` +
          `against a 60s test timeout. Check the home feed's latency before ` +
          `suspecting the test.\nOriginal: ${(error as Error).message}`
      );
    }
  }

  async gotoSpecificUrl(url: string) {
    await this.page.goto(`${url}`);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async moveToHomePage() {
    await this.getHomeNavLink.click();
    await expect(this.getHeaderAllCommunities).toBeVisible();
  }

  async moveToLeoFinanceCommunities() {
    await this.getLeoFinanceCommunitiesLink.click();
    // await this.page.waitForRequest('https://api.hive.blog/');
    await expect(this.getHeaderLeoCommunities).toBeVisible();
  }

  async moveToWorldmappinCommunities() {
    await this.getWorldmappinCommunitiesLink.click();
    await expect(this.getHeaderWorldmappinCommunities).toBeVisible();
  }

  async moveToExploreCommunities() {
    await this.getExploreCommunities.click();
  }

  async moveToFirstPostAuthorProfilePage() {
    const profilePage = new ProfilePage(this.page);
    const firstPostAuthorNick = await this.getFirstPostAuthor.innerText();
    // Click the post's author name link
    await this.getFirstPostAuthor.click();

    // Validate that you moved to the clicked post author profile page.
    // Posts is the DEFAULT view at `/@username` now (no separate Posts tab
    // to click into, no `user-post-menu` there — that testid lives only on
    // `/comments`, see profilePage.ts's class doc comment), so no extra
    // navigation step is needed once the profile has loaded.
    await this.page.waitForSelector(profilePage.profileName['_selector']);
    expect(await profilePage.profileName).toBeVisible();
    const firstPostAuthorNameProfilePage = await this.page.locator('[data-testid="post-author"], [data-testid="medium-card-author"]').first();
    await expect('@' + firstPostAuthorNick).toMatch(await firstPostAuthorNameProfilePage.innerText());
  }

  async moveToFirstPostAuthorProfilePageByAvatar() {
    const profilePage = new ProfilePage(this.page);
    const firstPostAuthorNick = await this.getFirstPostAuthor.innerText();
    // Click the post's author avatar link
    await this.getFirstPostCardAvatar.click();

    // Validate that you moved to the clicked post author profile page. See
    // moveToFirstPostAuthorProfilePage above: Posts is the default view now,
    // no Posts-tab click needed.
    await this.page.waitForSelector(profilePage.profileName['_selector']);
    expect(await profilePage.profileName).toBeVisible();
    const firstPostAuthorNameProfilePage = await this.page.locator('[data-testid="post-author"], [data-testid="medium-card-author"]').first();
    await expect('@' + firstPostAuthorNick).toMatch(await firstPostAuthorNameProfilePage.innerText());
  }

  async moveToFirstPostCommunityOrCategory() {
    const profilePage = new ProfilePage(this.page);
    const firstPostAuthorNick = await this.getFirstPostAuthor.innerText();

    if (await this.getFirstPostCardCommunityLink.isVisible()) {
      const firstPostCardCommunityLink = await this.getFirstPostCardCommunityLink;
      const firstPostCardCommunityLinkText = await this.getFirstPostCardCommunityLink.textContent();

      firstPostCardCommunityLink.click();
      await this.page.waitForSelector(
        await this.page.locator('[data-testid="community-info-sidebar"]')['_selector']
      );
      expect(await this.page.locator('[data-testid="community-name"]').textContent()).toBe(
        await firstPostCardCommunityLinkText
      );
      await expect(await this.page.locator('[data-testid="community-name-unmoderated"]').textContent()).toBe(
        'Community'
      );
    } else if (await this.getFirstPostCardCategoryLink.isVisible()) {
      const firstPostCardCategoryLink = await this.getFirstPostCardCategoryLink;
      const firstPostCardCategoryLinkText = await this.getFirstPostCardCategoryLink.textContent();

      firstPostCardCategoryLink.click();
      await this.page.waitForSelector(
        this.page.locator('[data-testid="community-info-sidebar"]')['_selector']
      );
      expect(await this.page.locator('[data-testid="community-name"]').textContent()).toBe(
        await firstPostCardCategoryLinkText
      );
      expect(await this.page.locator('[data-testid="community-name-unmoderated"]').textContent()).toBe(
        'Unmoderated tag'
      );
    }
  }

  async moveToFirstPostContentByClickingTimestamp() {
    const profilePage = new ProfilePage(this.page);
    const firstPostCardTitle = await this.getFirstPostTitle.textContent();
    // Click the post's timestamp link
    await this.getFirstPostCardTimestampLink.click();
    await this.page.waitForSelector(this.page.locator('[data-testid="article-title"]')['_selector']);
    expect(await this.page.locator('[data-testid="article-title"]').textContent()).toBe(firstPostCardTitle);
  }

  async moveToFirstPostContentByClickingTitilePostCard() {
    const firstPostCardTitle = await this.getFirstPostTitle.textContent();
    // Click the post's title link
    await this.postTitle.first().click();
    await this.page.waitForSelector(this.page.locator('[data-testid="article-title"]')['_selector']);
    expect(await this.page.locator('[data-testid="article-title"]').textContent()).toBe(firstPostCardTitle);
  }

  async moveToFirstPostContentByClickingDescriptionPostCard() {
    const firstPostCardTitle = await this.getFirstPostTitle.textContent();
    // Click the post's description link
    await this.postDescription.first().click();
    await this.page.waitForSelector(this.page.locator('[data-testid="article-title"]')['_selector']);
    expect(await this.page.locator('[data-testid="article-title"]').textContent()).toBe(firstPostCardTitle);
  }

/**
   * Find and navigate to the first post that has comments count > 0.
   * Note: This only checks the comment count badge, not whether comments are actually visible.
   * For non-logged users who need to verify visible comments, use commentsTestHelper instead.
   */
  async moveToTheFirstPostWithCommentsNumberMoreThanZero() {
    const postsCard = await this.getMainTimeLineOfPosts.all();
    const postsComments = await this.getPostChildren.all();

    for (let postIndex = 0; postIndex < postsComments.length; postIndex++) {
      const numberOfCommentsInPost = postsComments[postIndex];
      const postTitle = postsCard[postIndex].locator('[data-testid="post-title"] a, a[data-testid="medium-card-title"]');
      const commentsCount = await numberOfCommentsInPost.textContent();

      if (commentsCount !== '0') {
        const postTitleText = await postTitle.textContent();

        await postTitle.click();
        await this.postPage.articleAuthorData.waitFor({ state: 'visible' });
        await expect(this.postPage.articleTitle).toBeVisible();
        expect(await this.postPage.articleTitle.textContent()).toBe(postTitleText);

        break;
      }
    }
  }

  async moveToTheFirstPostCommentContantPageByClickingResponses() {
    const firstPostCardTitle = await this.getFirstPostTitle.textContent();

    // Click the post's responses link
    await this.getFirstPostChildren.click();
    await this.page.waitForSelector(await this.page.locator('[data-testid="article-title"]')['_selector']);
    expect(await this.page.locator('[data-testid="article-title"]').textContent()).toBe(firstPostCardTitle);
  }

  async moveToNavPostsPage() {
    const url = env('API_ENDPOINT');
    await this.getNavPostsLink.click();
    await expect(this.page.url()).toBe(`https://${url}/trending`);
  }




  async isTrendingCommunitiesVisible() {
    await expect(this.getTrandingCommunitiesHeader).toBeVisible();
    await expect(this.getExploreCommunities).toHaveText(/Explore communities.../);
    await expect(this.getExploreCommunities).toBeEnabled();
  }

  async mainPostsTimelineVisible(amountOfPosts: number) {
    // Validate that there are 20 posts displayed on HomePage as default (without scrolldown)
    await expect(this.getMainTimeLineOfPosts).toHaveCount(amountOfPosts);
  }

  async getElementCssPropertyValue(element: Locator, cssProperty: string) {
    const bcg = await element.evaluate((ele, css) => {
      return window.getComputedStyle(ele).getPropertyValue(css);
    }, cssProperty);
    // return value of element's css property
    return bcg;
  }

  /**
   * ★ THE THEME API IS GONE (2026-08-19). Lumen is light-only by owner ruling of
   * 2026-08-11: `next-themes` and every `dark:` variant were removed and there is
   * no theme control in the product (see `features/layouts/providers.tsx`). The
   * 52 test blocks that drove it have been deleted, so `changeThemeMode`,
   * `validateThemeModeIsDark`, `validateThemeModeIsSystem` and
   * `validateDarkModeByClass` went with them rather than being left as helpers
   * for a feature nobody can reach.
   *
   * ONE SURVIVES, and it needed correcting. The app is always light, so this is
   * no longer "is the light theme active" — it is "is the paper background what
   * it should be". Its expected value was `rgb(247, 247, 247)`, the old neutral
   * grey; Lumen's paper is warm and measures `rgb(252, 250, 248)` on the running
   * build. That literal would have failed on every run — stale in exactly the
   * same way the dark-mode tests were, just quieter about it.
   */
  async validateThemeModeIsLight() {
    expect(await this.getElementCssPropertyValue(this.getBody, 'background-color')).toBe(
      'rgb(252, 250, 248)'
    );
  }

  async validateLightModeByClass() {
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.page.locator('html')).not.toHaveClass(/dark/);
  }

  async validateFirstPostPayoutWithTooltip() {
    await expect(this.getFirstPostPayout).toBeVisible();
    await expect(this.getFirstPostPayout).toHaveText(/\$\d+/);
    await this.getFirstPostPayout.hover();
    await expect(this.getFirstPostPayoutTooltip).toBeVisible({ timeout: 15000 });
  }

  async validateFirstPostVotesWithTooltip() {
    await expect(this.getFirstPostVotes).toBeVisible();
    await this.getFirstPostVotes.hover();
    await expect(this.getFirstPostVotesTooltip).toBeVisible({ timeout: 15000 });
    const votes = await this.getFirstPostVotes.textContent();
    expect(await this.getFirstPostVotesTooltip.textContent()).toBe(votes + ' votes' + votes + ' votes');
  }

  async validateFirstPostResponsesWithTooltip() {
    await expect(this.getFirstPostChildernCommentNumber).toBeVisible();
    await expect(this.getFirstPostChildernIcon).toBeVisible();
    await this.getFirstPostChildernCommentNumber.hover();
    await expect(this.getFirstPostChildernTooltip).toBeVisible({ timeout: 15000 });
    const n = await this.getFirstPostChildernCommentNumber.textContent();
    if (n === '0') {
      expect(await this.getFirstPostChildernTooltip.textContent()).toContain('No responses. Click to respond');
    } else if (n === '1') {
      expect(await this.getFirstPostChildernTooltip.textContent()).toContain(`${n} response. Click to respond`);
    } else {
      expect(await this.getFirstPostChildernTooltip.textContent()).toContain(`${n} responses. Click to respond`);
    }
  }

  async validateFirstPostHeaderElements() {
    await expect(this.getFirstPostAuthor).toBeVisible();
    await expect(this.getFirstPostCardTimestampLink).toBeVisible();
    const authorCursor = await this.getElementCssPropertyValue(this.getFirstPostAuthor, 'cursor');
    expect(authorCursor).toBe('pointer');
    const timestampCursor = await this.getElementCssPropertyValue(this.getFirstPostCardTimestampLink, 'cursor');
    expect(timestampCursor).toBe('pointer');
    if (await this.getFirstPostCardCommunityLink.isVisible()) {
      const c = await this.getElementCssPropertyValue(this.getFirstPostCardCommunityLink, 'cursor');
      expect(c).toBe('pointer');
    }
    if (await this.getFirstPostCardCategoryLink.isVisible()) {
      const c = await this.getElementCssPropertyValue(this.getFirstPostCardCategoryLink, 'cursor');
      expect(c).toBe('pointer');
    }
  }

  async validateFirstPostUpvoteButtonWithTooltip() {
    await expect(this.getFirstPostUpvoteButton).toBeVisible();
    await expect(this.getFirstPostUpvoteButton.locator('svg')).toBeVisible();
    await this.getFirstPostUpvoteButton.hover();
    await expect(this.getFirstPostUpvoteButtonTooltip).toBeVisible({ timeout: 15000 });
    expect(await this.getFirstPostUpvoteButtonTooltip.textContent()).toContain('Upvote');
  }

  async validateFirstPostDownvoteButtonWithTooltip() {
    await expect(this.getFirstPostDownvoteButton).toBeVisible();
    await expect(this.getFirstPostDownvoteButton.locator('svg')).toBeVisible();
    await this.getFirstPostDownvoteButton.hover();
    await expect(this.getFirstPostDownvoteButtonTooltip).toBeVisible({ timeout: 15000 });
    expect(await this.getFirstPostDownvoteButtonTooltip.textContent()).toContain('Downvote');
  }

  async validateFirstPostReblogCountWithTooltip() {
    await expect(this.getFirstPostReblogCountDisplay).toBeVisible();
    await this.getFirstPostReblogCountDisplay.hover();
    await expect(this.getFirstPostReblogCountTooltip).toBeVisible();
    expect(await this.getFirstPostReblogCountTooltip.textContent()).toMatch(/reblog/i);
  }

  async validateFirstPostReputationWithTooltip() {
    await expect(this.getFirstPostAuthorReputation).toBeVisible();
    await expect(this.getFirstPostAuthorReputation).toHaveAttribute('title', 'Reputation');
  }

  async moveToMutedPosts() {
    await this.getFilterPosts.click();
    // Scope to the open dropdown — a page-wide getByText('Muted') also
    // matches any post-card description whose body contains the word
    // (real Hive content occasionally surfaces such posts into trending,
    // see e.g. @acidyo/what-the-fuck-is-up), tripping strict mode.
    await this.getFilterPostsList.getByText('Muted').click();
    await expect(this.getFirstPostTitle).toBeVisible();
  }

  async moveToFirstPost() {
    await this.postTitle.first().hover();
    await this.postTitle.first().click({ force: true });
  }

  async moveToWelcomePage() {
    await this.getNavSidebarMenu.click();
    await this.getNavSidebarMenuContent.getByRole('button', { name: 'Welcome' }).click();
    await this.page.waitForTimeout(5000);
    await expect(this.page.getByText('Welcome to Hive!')).toBeVisible();
    await expect(this.page).toHaveURL('welcome');
  }

  async moveToPrivacyPolicyPage() {
    await this.getNavSidebarMenu.click();
    await this.getNavSidebarMenuContent.getByRole('button', { name: 'Privacy Policy' }).click();
    await this.page.waitForTimeout(5000);
    await expect(this.page.locator('h1').getByText('Privacy Policy')).toBeVisible();
    await expect(this.page).toHaveURL('privacy.html');
  }

  async moveToTermsOfServicePage() {
    await this.getNavSidebarMenu.click();
    await this.getNavSidebarMenuContent.getByRole('button', { name: 'Terms of Service' }).click();
    await this.page.waitForTimeout(5000);
    await expect(this.page.locator('div').getByText('Terms of Service')).toBeVisible();
    await expect(this.page).toHaveURL('tos.html');
  }

  // Tranding All Posts
  async validateAllPostspageIsLoaded() {
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.getMainTimeLineOfPosts['_selector']);
    await expect(this.getFilterPosts).toHaveText('Trending');
  }

  // Click to close the profile menu - click the center of the home page community and filter header
  async clickToCloseProfileMenu(){
    await this.getCommunityNameElement
        .locator('..')
        .locator('..')
        .click({ force: true });
  }

  /**
   * Navigate to homepage with mobile viewport
   */
  async gotoMobile() {
    await this.page.setViewportSize(MOBILE_VIEWPORT);
    await this.page.goto('/');
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: 15000 });
  }

  /**
   * Navigate to homepage with tablet viewport
   */
  async gotoTablet() {
    await this.page.setViewportSize(TABLET_VIEWPORT);
    await this.page.goto('/');
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.getMainTimeLineOfPosts.first()).toBeVisible({ timeout: 15000 });
  }

  /**
   * Close sidebar menu by pressing Escape
   */
  async closeSidebar() {
    await this.page.keyboard.press('Escape');
    await expect(this.getNavSidebarMenuContent).not.toBeVisible();
  }

  /**
   * Get count of posts in the main timeline
   */
  async getPostsCount(): Promise<number> {
    return await this.getMainTimeLineOfPosts.count();
  }
}
