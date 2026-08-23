import { Locator, Page, expect } from '@playwright/test';

/**
 * ★★★ `[data-testid="profile-navigation"]` IS GONE (2026-08-10, verified still true
 * 2026-08-21). See the DELETED-tests comments in profilePage.spec.ts /
 * profileBlogPage.spec.ts for what that removal already covered — no live locator in
 * this file references it any more, only historical comments do.
 *
 * ★★★ RE-AUDITED 2026-08-21 against a further redesign pass (`profile-redesign-main`,
 * `profile-identity-block`, `ProfileLeagueChip`, `IdentityPill` on post cards) that
 * landed after the 2026-08-10/13 notes below were written. Those notes are now WRONG
 * in places (most importantly: `profile-stats` is NOT alive any more) and have been
 * superseded by this pass. Ground truth used: /tmp/testid-inventory.json (live
 * per-page testid capture) + direct source reads, cited inline at each field.
 *
 * ★ `profile-info` → repointed to `[data-testid="profile-identity-block"]`
 * (features/account-profile/redesign/profile-identity.tsx:122). That block now holds
 * everything the old profile-info card held except the display name (moved to the
 * shared masthead's bare `<h1>`, no testid — profile-main.tsx:247,
 * features/layouts/page-masthead.tsx:94) and the discrete stats-bar wrapper (the
 * stats line is now un-wrapped content inside this same block —
 * profile-identity.tsx:255-296).
 *
 * ★ `profile-stats` → ALSO repointed to `[data-testid="profile-identity-block"]`. The
 * old standalone `ProfileStatsBar` card was deleted 2026-08-13 (see
 * profile-identity.tsx's own doc comment); the four numbers are now an un-wrapped
 * line inside the identity block, so there is no narrower live container to point at.
 * `profileFollowers`/`profileNumberOfPosts`/`profileFollowing`/`profileHP` below no
 * longer derive from `profileStats` as a scoping parent — each is now independently,
 * more precisely selected (href for the two still-`<a>` stats, a text pattern for
 * Posts since it became a bare `<span>`, the live `profile-hp-effective` testid for
 * HP).
 *
 * ★ `profile-name` → repointed to `page.locator('h1')`. Confirmed by source
 * (page-masthead.tsx:94, `headingLevel` defaults to `'h1'`; profile-main.tsx:247 does
 * not override it) that this is the only `<h1>` profile-main.tsx or any component it
 * mounts renders (grepped features/account-profile, features/layouts/user-profile,
 * features/discovery-feed for `<h1`/`headingLevel` — the only other sitewide `<h1>`
 * is home-shell.tsx's sr-only heading, a different route).
 *
 * ★ `profileAbout` → repointed to `[data-testid="profile-identity-block"] > p`. The
 * bio paragraph itself carries NO testid (profile-identity.tsx:202, confirmed by
 * grep — genuinely missing, not renamed) but it is structurally the ONLY `<p>` that
 * component ever renders (the empty-bio prompt at line 208-214 is an `<a>`, not a
 * `<p>`), so this is unambiguous.
 *
 * ★ `profileJoined`/`profileLastTimeActive`/`profileLocation` → all three are bare
 * `<span className="flex items-center gap-1.5">` siblings with NO testid and
 * IDENTICAL classes (profile-identity.tsx:217-234) — genuinely missing testids.
 * Repointed by TEXT, since the translated label words are stable and exclusive:
 * "Joined ..." / "Active ..." (locales/en/common_blog.json: user_profile.joined /
 * user_profile.active). `profileLocation` is derived by ELIMINATION — the meta row
 * renders at most these three spans, in this order, and location has no label of its
 * own (it is the raw `profile.location` string with an icon), so "neither Joined nor
 * Active" is exactly location-or-absent. This correctly resolves to an EMPTY locator
 * (not a wrong one) on a profile with no location set, which is the safe failure mode.
 *
 * ★ `userBannerLevelLink`/`userBannerLevelImg`/`userBannerTwitterBadgeLink` → NOT
 * fixed, left pointing at dead testids, see the two `User Banner Row - User level
 * badge` tests in profilePage.spec.ts for why: the HiveBuzz whale/orca badge these
 * checked (title="X is a Whale...", src="/whale.png") has been replaced by an
 * unrelated feature — `ProfileLeagueChip` (features/retention/components/
 * profile-league-chip.tsx), Lumen's own tier/rank system ("Beacon · rank 7 of 9"),
 * different data source, different image (an SVG emblem, not `/whale.png`), different
 * copy entirely. There is no drift-fix here, the feature the test describes is gone.
 *
 * ★ `postsPostAuthor`/`postAvatar` (`medium-card-author`/`medium-card-avatar`) →
 * repointed per the handoff brief: `identity-pill-profile` (renders `@handle`, so
 * every textContent comparison downstream needed the leading `@` accounted for — done
 * at each call site in the two spec files, not by weakening the assertions) and the
 * first `<a>` inside `identity-pill` respectively. See features/discovery-feed/
 * identity-pill.tsx.
 *
 * ★ `postRebloggedLabel`/`postRebloggedAuthorLink` → repointed to
 * `medium-card-reblogged-by` / `medium-card-reblogged-by-link`
 * (medium-post-card.tsx:850-863), the current card's reblog-provenance testids. The
 * old `reblogged-label`/`reblogged-author-link` testids still exist in source but only
 * on the legacy `post-list-item.tsx` "classic" card, which the live testid inventory
 * confirms is NOT what renders on `/@handle` any more (medium-post-card.tsx replaced
 * it — see that file's own doc comment at line 812).
 *
 * ★ `postTitle` → repointed to the title-only inner `<span>`
 * (`a[data-testid="medium-card-title"] h2 span:first-child`), NOT the whole anchor.
 * The anchor's full textContent now includes the post date, inlined right after the
 * title with no separator (medium-post-card.tsx:1210-1233, "THE DATE HAS LEFT THIS
 * ROW... It now sits inline after the title"), which would corrupt any exact title
 * comparison. The title span is always the first child of the `<h2>`, so this stays
 * exact-text-safe. Clicking the span still navigates — it is nested inside the same
 * `<a>`, so the click bubbles to it exactly like clicking the date does.
 *
 * ★ `postTimestamp` → there is no more separate, clickable timestamp element; the
 * date moved inside the title anchor (same note as above). Repointed to the one
 * element inside that anchor carrying a native `title` attribute — the bare
 * `<span title="...">` `TimeAgo` renders (packages/ui/components/time-ago.tsx:115) —
 * which is the closest live equivalent of "the timestamp, as its own sub-element".
 *
 * ★ `postCommunityLink`/`postCategoryLink` → NOT fixed, left dead. The redesigned
 * card collapsed both into ONE `medium-card-rubric` slot (medium-post-card.tsx:963,
 * doc comment: "the rubric slot shows the post's first tag instead... If there is no
 * tag either, the rubric is omitted") with no way to tell from a testid alone which
 * case rendered. Pointing both fields at the same element would make BOTH branches of
 * the test that uses them ('move to the community page after clicking
 * community/category link...') fire together, running the community-only assertions
 * even on a tag-fallback post. That is a test-logic decision, not a locator fix — see
 * the report handed back with this pass.
 *
 * ★ `postReputation`/`postReputationTooltip` → NOT fixed, left dead. The
 * redesigned card's byline (`IdentityPill`) has no reputation display at all — grepped
 * medium-post-card.tsx and identity-pill.tsx for "reputation", zero hits. Reputation
 * now only appears via the hover-triggered `UserPopoverCard`
 * (features/post-rendering/user-popover-card.tsx), not as a static, always-visible
 * element, so there is nothing to point a "visible with title=Reputation" check at.
 *
 * ★ `crossPostBanner`/`crossPostAuthorLink`/`crossPostOriginalLink` → NOT fixed, left
 * dead. Same story as reblog: these testids exist only on the legacy
 * `post-list-item.tsx` card. `medium-post-card.tsx` has no cross-post attribution
 * surface at all (grepped for "cross-post", zero hits) — this is a feature gap in the
 * redesign, not a rename, and the test that depends on it
 * ('cross-post original link author matches...') will keep silently `test.skip`-ing
 * (`crossPostCount` is always 0) until either the feature is rebuilt or the test is
 * retired.
 *
 * ★ `postReblogCountDisplay`/`postReblogCountTooltip` → repointed to
 * `medium-card-reblog-count` / `medium-card-reblog-tooltip`
 * (medium-post-card.tsx:1531-1553); confirmed the tooltip text is literally `Reblog`
 * (LABELS.reblog, medium-post-card.tsx:64), matching the existing `/reblog/i` check.
 *
 * ★ `postResponse`/`postResponseTooltip` (`post-card-response-link`/
 * `post-card-responses`) and `postPayoutTooltip` (`payout-post-card-tooltip`) needed
 * NO fix — both are shared components (`PostCardCommentTooltip`, `DetailsCardHover`)
 * that `medium-post-card.tsx` reuses as-is, confirmed still wired in
 * (medium-post-card.tsx:1502-1509, 1568).
 */
export class ProfilePage {
  readonly page: Page;
  readonly profileNickName: any;
  readonly profileInfo: any;
  readonly profileSubpageMain: any;
  readonly profileName: Locator;
  readonly profileAbout: Locator;
  readonly profileLastTimeActive: Locator;
  readonly profileJoined: Locator;
  readonly profileLocation: Locator;
  readonly profileStats: Locator;
  readonly followButton: Locator;
  readonly userLinks: Locator;
  readonly profileBlogPostsList: Locator;

  readonly postBlogItem: any;
  readonly postsMenu: Locator;
  readonly postsPostAuthor: Locator;
  readonly postsMenuPostsButton: Locator;
  readonly postsMenuCommentsButton: Locator;
  readonly postsMenuPayoutsButton: Locator;
  readonly postRebloggedLabel: Locator;
  readonly firstPostRebloggedLabel: Locator;
  readonly postRebloggedAuthorLink: Locator;
  readonly postTitle: Locator;
  readonly postDescription: Locator;
  readonly postCommunityLink: Locator;
  readonly postCategoryLink: Locator;
  readonly postTimestamp: Locator;
  readonly postUpvoteButton: Locator;
  readonly postDownvoteButton: Locator;
  readonly postUpvoteTooltip: Locator;
  readonly postDownvoteTooltip: Locator;
  readonly postPayout: Locator;
  readonly postPayoutTooltip: Locator;
  readonly postVotes: Locator;
  readonly postVotesTooltip: Locator;
  readonly postResponse: Locator;
  readonly postResponseTooltip: Locator;
  readonly postReblogCountDisplay: Locator;
  readonly postReblogCountTooltip: Locator;
  readonly postAvatar: Locator;
  readonly postReputation: Locator;
  readonly postReputationTooltip: Locator;
  readonly crossPostBanner: Locator;
  readonly crossPostAuthorLink: Locator;
  readonly crossPostOriginalLink: Locator;
  readonly postsPostListLocator: Locator;
  readonly postsCommentsListLocator: Locator;
  readonly postsPayoutsListLocator: Locator;

  readonly repliesCommentListItem: any;
  readonly repliesCommentListItemLoadNewer: Locator;
  readonly repliesCommentListItemTitle: Locator;
  readonly repliesCommentListItemDescription: Locator;
  readonly repliesCommentListItemAvatar: Locator;
  readonly repliesCommentListItemAvatarLink: Locator;
  readonly repliesCommentListItemCommunityLink: Locator;
  readonly repliesCommentListItemTimestamp: Locator;
  readonly repliesCommentListItemUpvote: Locator;
  readonly repliesCommentListItemDownvote: Locator;
  readonly repliesCommentListItemUpvoteTooltip: Locator;
  readonly repliesCommentListItemDownvoteTooltip: Locator;
  readonly repliesCommentListItemPayout: Locator;
  readonly repliesCommentListItemPayoutTooltip: Locator;
  readonly repliesCommentListItemVotes: Locator;
  readonly repliesCommentListItemVotesTooltip: Locator;
  readonly repliesCommentListItemRespond: Locator;
  readonly repliesCommentListItemRespondFirst: Locator;
  readonly repliesCommentListItemRespondTooltip: Locator;
  readonly repliesCommentListItemArticleTitle: Locator;

  readonly notificationsMenu: any;
  readonly notificationsMenuAllButton: Locator;
  readonly notificationsMenuRepliesButton: Locator;
  readonly notificationsMenuMentionsButton: Locator;
  readonly notificationsMenuFollowsButton: Locator;
  readonly notificationsMenuUpvotesButton: Locator;
  readonly notificationsMenuReblogsButton: Locator;
  readonly notificationsMenuAllContent: Locator;
  readonly notificationsMenuRepliesContent: Locator;
  readonly notificationListItemInReplies: Locator;
  readonly notificationsMenuMentionsContent: Locator;
  readonly notificationListItemInMentions: Locator;
  readonly notificationsMenuFollowsContent: Locator;
  readonly notificationListItemInFollows: Locator;
  readonly notificationsMenuUpvotesContent: Locator;
  readonly notificationListItemInUpvotes: Locator;
  readonly notificationsMenuReblogsContent: Locator;
  readonly notificationListItemInReblogs: Locator;
  readonly notificationNickName: Locator;
  readonly notificationAccountIconLink: Locator;
  readonly notificationAccountAndMessage: Locator;
  readonly notificationTimestamp: Locator;
  readonly notificationListItemInAll: Locator;
  readonly notificationListItemEvenInAll: Locator;
  readonly notificationListItemOddInAll: Locator;
  readonly notificationProgressBar: Locator;
  readonly notificationLoadMoreButtonInAll: Locator;
  readonly notificationLoadMoreButtonInReblogs: Locator;

  readonly publicProfileSettings: any;
  readonly publicProfileSettingsHeader: Locator;
  readonly apiEndpointCard: Locator;
  readonly apiSelectedNodeText: Locator;
  readonly apiEndpointButton: Locator;
  readonly firstSetMainButton: Locator;
  readonly apiEndpointAISearchButton: Locator;
  readonly apiAddressInput: Locator;
  readonly apiFilterInput: Locator;
  readonly apiAddButton: Locator;
  readonly apiRestoreDefaultServerSetButton: Locator;
  readonly preferencesProfileSettingsHeader: Locator;
  readonly advancedProfileSettingsHeader: Locator;
  readonly ppsProfilePictureUrlLabel: Locator;
  readonly ppsProfilePictureUrlInput: Locator;
  readonly ppsCoverImageUrlLabel: Locator;
  readonly ppsCoverImageUrlInput: Locator;
  readonly ppsDisplayNameLabel: Locator;
  readonly ppsDisplayNameInput: Locator;
  readonly ppsAboutLabel: Locator;
  readonly ppsAboutInput: Locator;
  readonly ppsLocationLabel: Locator;
  readonly ppsLocationInput: Locator;
  readonly ppsWebsiteLabel: Locator;
  readonly ppsWebsiteInput: Locator;
  readonly ppsBlacklistDescriptionLabel: Locator;
  readonly ppsBlacklistDescriptionInput: Locator;
  readonly ppsMuteListDescriptionLabel: Locator;
  readonly ppsMuteListDescriptionInput: Locator;
  readonly ppsButtonUpdate: Locator;

  readonly preferencesSettings: Locator;
  readonly preferencesSettingsChooseLanguage: Locator;
  readonly preferencesSettingsNoSafeForWorkContent: Locator;
  readonly preferencesSettingsBlogPostRewards: Locator;
  readonly preferencesSettingsCommentsPostRewards: Locator;
  readonly preferencesSettingsReferralSystem: Locator;

  readonly advancedSettingsApiEndpointRadioGroup: Locator
  readonly advancedSettingsApiEndpointList: Locator
  readonly advancedSettingsApiEndpointButton: Locator
  readonly advancedSettingsApiEndpointAdd: Locator
  readonly advancedSettingsApiEndpointAddInput: Locator
  readonly advancedSettingsApiEndpointAddButton: Locator
  readonly advancedSettingsApiResetEndpointsButton: Locator

  readonly thirdPartyAppPeakdLink: Locator;
  readonly thirdPartyAppHivebuzzLink: Locator;

  readonly communitySubscriptionHeader: any;

  readonly profileNumberOfPosts: Locator;
  readonly profileHP: Locator;
  readonly profileFollowing: Locator;
  readonly profileFollowers: Locator;

  readonly followedBlacklists: Locator;
  readonly followedBlacklistsHeader: Locator;
  readonly followedMutedLists: Locator;
  readonly followedMutedListsHeader: Locator;

  readonly socialBadgesAchievemntsMenuBar: Locator;
  readonly socialMenuBarBadges: Locator;
  readonly socialMenuBarActivity: Locator;
  readonly socialMenuBarPersonal: Locator;
  readonly socialMenuBarMeetups: Locator;
  readonly socialMenuBarChallenges: Locator;
  readonly socialCommunitySubscriptionsLabel: Locator;
  readonly socialCommunitySubscriptionsDescription: Locator;
  readonly socialAuthorSubscribedCommunitiesList: Locator;
  readonly socialAuthorSubscribedCommunitiesListItem: Locator;
  readonly socialAuthorSubscribedCommunitiesLink: Locator;
  readonly socialAuthorSubscribedCommunitiesRoleTag: Locator;
  readonly socialAuthorSubscribedCommunitiesAffiliationTag: Locator;
  readonly socialBadgesAchivementsLabel: Locator;
  readonly socialBadgesAchivementsDescription: Locator;
  readonly socialBadgeAchivement: Locator;
  readonly blogTabPostsContainer: Locator;
  readonly firstCommunityLinkPostsComments: Locator;
  readonly communityName: Locator;
  readonly communityTimeStamp: Locator;

  // Single locator covering Blog/Posts/Comments/Payouts/Replies empty states —
  // the app emits the same `data-testid="user-has-not-started-blogging-yet"`
  // for all of them; only the rendered text differs by translation key.
  readonly userHasNotStartedBloggingYetMsg: Locator;
  readonly userDoesNotHaveAnySubscriptionsYetMsg: Locator;
  readonly userHasNotHadAnyNotificationsYetMsg: Locator;
  readonly userBannerLevelLink: Locator;
  readonly userBannerLevelImg: Locator;
  readonly userBannerTwitterBadgeLink: Locator;
  readonly profileNameString: string;
  readonly followBtn: string;
  readonly profileStatsString: string;

  readonly notFoundPage: Locator;
  readonly notFoundHeading: Locator;

  readonly followedFollowersPageHeading: Locator;
  readonly followedFollowersList: Locator;
  readonly followedFollowersListItems: Locator;

  readonly postsMenuActiveTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.followBtn = '[data-testid="profile-follow-button"]'
    // ★ `profile-info` DEAD → `profile-identity-block` (profile-identity.tsx:122).
    // See the class doc comment above for the full mapping rationale.
    this.profileInfo = page.locator('[data-testid="profile-identity-block"]');
    /**
     * ★ The live "we are on a profile SUBPAGE" anchor (added 2026-08-11):
     * `features/layouts/user-profile/profile-subpage-shell.tsx:87`. Server-rendered,
     * so it is a safe wait target. Use this instead of the dead `profileInfo`
     * (`profile-info` — 0 occurrences in product source; see the class doc above)
     * on /communities, /followers, /following, /settings and friends.
     */
    this.profileSubpageMain = page.locator('[data-testid="profile-subpage-main"]');
    // ★ `profile-name` DEAD → the shared masthead's bare `<h1>`, no testid
    // (page-masthead.tsx:94, profile-main.tsx:247). Only `<h1>` on this route.
    this.profileName = page.locator('h1');
    this.profileNameString = 'h1';
    this.profileNickName = page.locator('[data-testid="profile-nickname"]');
    // ★ `profile-about` has no testid at all (profile-identity.tsx:202) — it is the
    // ONLY `<p>` the identity block ever renders (the empty-bio prompt is an `<a>`).
    this.profileAbout = page.locator('[data-testid="profile-identity-block"] > p');
    // ★ `user-last-time-active`/`user-joined`/`user-location` all DEAD — none of the
    // three meta-row spans (profile-identity.tsx:217-234) carry a testid, and all
    // three share identical classes. Repointed by the stable, mutually-exclusive
    // translated label text; profileLocation is "neither Joined nor Active" by
    // elimination, which resolves to an empty (not wrong) locator when absent.
    this.profileLastTimeActive = page
      .locator('[data-testid="profile-identity-block"] span.items-center')
      .filter({ hasText: /^Active/ });
    this.profileJoined = page
      .locator('[data-testid="profile-identity-block"] span.items-center')
      .filter({ hasText: /^Joined/ });
    this.profileLocation = page
      .locator('[data-testid="profile-identity-block"] span.items-center')
        // ★ `.first()`: the identity block holds several `span.items-center` rows and
        // more than one survives the Joined/Active exclusion, which makes this a
        // strict-mode violation rather than "the location". Location is the first
        // such row; measured as a strict-mode failure in the 2026-08-21 run.
        .filter({ hasNotText: /^(Joined|Active)/ })
        .first();
    // ★ `profile-stats` DEAD — the standalone stats card was deleted 2026-08-13; its
    // four numbers are now unwrapped content inside `profile-identity-block`
    // (profile-identity.tsx:255-296), so that block is the closest live "we're on a
    // profile page, stats are visible" proxy. See class doc comment for why the child
    // locators below no longer scope off this field.
    this.profileStats = page.locator('[data-testid="profile-identity-block"]');
    this.profileStatsString = '[data-testid="profile-identity-block"]'
    // ★ Followers/Following are still real `<a href="/@user/followers|following">`
    // links (profile-identity.tsx:256,268) — selected by href, not position, since
    // Posts is no longer an `<a>` (see below) and the old `> a` nth-index would now
    // silently pick the wrong element. HP has its own live testid.
    this.profileFollowers = page.locator('[data-testid="profile-identity-block"] a[href$="/followers"]');
    this.profileFollowing = page.locator('[data-testid="profile-identity-block"] a[href$="/following"]');
    // ★ Posts count is now a bare `<span>`, no href, no testid (profile-identity.tsx:
    // 261-263) — matched by its own rendered text shape ("<number> post(s)"), which is
    // the only element in the block matching that exact anchored pattern.
    this.profileNumberOfPosts = page
      .locator('[data-testid="profile-identity-block"]')
      .getByText(/^[\d,—]+\s+posts?$/);
    // ★ HP now has its OWN live testid (profile-identity.tsx:286) — direct, not
    // derived from a stats-line index any more.
    this.profileHP = page.locator('[data-testid="profile-hp-effective"]');
    this.followButton = page.locator('[data-testid="profile-follow-button"]');
    // ★ `muteButton` REMOVED (2026-08-12, Block consolidation cleanup). It
    // targeted `data-testid="profile-mute-button"`, which no longer renders
    // anywhere — the redesigned profile header (`ProfileActions`) offers a
    // Block menu item, not a Mute button, and this locator's last two
    // callers (`socialMute.spec.ts`, deleted; `socialUnmute.spec.ts`,
    // retargeted at `/lists/muted`) no longer need it.
    this.userLinks = page.locator('[data-testid="user-links"]');
    this.profileBlogPostsList = page.getByTestId('post-list-profile-blog-list');

    this.postBlogItem = page.locator('[data-testid="post-list-item"], [data-testid="medium-card"]');
    this.postsMenu = page.locator('[data-testid="user-post-menu"]');
    // ★ `post-author`/`medium-card-author` DEAD → `identity-pill-profile`
    // (identity-pill.tsx:134). Renders `@handle` (leading `@`), unlike the old bare
    // handle — every textContent comparison against this field in the spec files
    // strips the `@` explicitly rather than weakening the assertion.
    this.postsPostAuthor = page.locator('[data-testid="identity-pill-profile"]');
    this.postsMenuPostsButton = page.locator('[data-testid="user-post-menu"]').getByText('Posts');
    this.postsMenuCommentsButton = page.locator('[data-testid="user-post-menu"]').getByText('Comments');
    this.postsMenuPayoutsButton = page.locator('[data-testid="user-post-menu"]').getByText('Payouts');
    // ★ `reblogged-label`/`reblogged-author-link` DEAD on this card → the current
    // card's reblog-provenance testids (medium-post-card.tsx:850-863).
    this.postRebloggedLabel = page.locator('[data-testid="medium-card-reblogged-by"]');
    this.firstPostRebloggedLabel = this.postBlogItem.first().locator(this.postRebloggedLabel);
    this.postRebloggedAuthorLink = page.locator('[data-testid="medium-card-reblogged-by-link"]');
    // ★ `a[data-testid="medium-card-title"]` per the established mapping (the testid
    // IS the anchor), scoped one level deeper to the title-only span
    // (medium-post-card.tsx:1210-1230): the anchor's full text now also contains the
    // post date inlined right after the title with no separator, which would corrupt
    // any exact-title comparison. The span is always the `<h2>`'s first child.
    // Clicking it still navigates — it is nested inside the same `<a>`.
    this.postTitle = this.postBlogItem.locator(
      '[data-testid="post-title"] > a, a[data-testid="medium-card-title"] h2 span:first-child'
    );
    this.postDescription = this.postBlogItem.locator('[data-testid="post-description"], [data-testid="medium-card-dek"]');
    // ★ `post-card-community`/`post-card-category` DEAD on this card — NOT fixed. The
    // redesign collapsed both into ONE `medium-card-rubric` slot with no testid-level
    // way to tell which case rendered; see the class doc comment above for why a
    // single-locator fix here would be a confident-but-wrong guess, not a repoint.
    this.postCommunityLink = page.locator('[data-testid="post-card-community"]');
    this.postCategoryLink = page.locator('[data-testid="post-card-category"]');
    // ★ `post-card-timestamp` DEAD — there is no separate clickable timestamp any
    // more, the date moved inside the title anchor (see postTitle above). Repointed
    // to the one element inside that anchor with a native `title` attribute — the
    // bare `<span title="...">` `TimeAgo` renders (time-ago.tsx:115) — the closest
    // live equivalent of "the timestamp, as its own sub-element". Still nested inside
    // `a[data-testid="medium-card-title"]`, so `.click()` still navigates.
    this.postTimestamp = page.locator('a[data-testid="medium-card-title"] span[title]');
    this.postUpvoteButton = page.locator('[data-testid="upvote-button"]');
    this.postDownvoteButton = page.locator('[data-testid="downvote-button"]');
    this.postUpvoteTooltip = page.locator('[data-testid="upvote-button-tooltip"]');
    this.postDownvoteTooltip = page.locator('[data-testid="downvote-button-tooltip"]');
    this.postPayout = page.locator('[data-testid="post-payout"], [data-testid="medium-card-payout"]');
    this.postPayoutTooltip = page.locator('[data-testid="payout-post-card-tooltip"]');
    // ★ `post-total-votes` DEAD — NOT fixed, and NOT a rename. Confirmed by inventory
    // (absent from every captured page) and by source comment
    // (medium-post-card.tsx:1461): the standalone total-votes display was DELETED
    // 2026-08-14 for being a duplicate — "this sibling printed total_votes a second
    // time, so every card read '759 759'". `vote-tally-up`/`vote-tally-down`
    // (votes-component.tsx:509,529, alive, inside `vote-control`) are a DIFFERENT
    // metric (the up/down split, not a combined total), so pointing this field at
    // either would silently change what is being measured, not repoint it. This field
    // has zero consumers across the whole test suite (grepped), so nothing regresses
    // by leaving it dead — flagging rather than guessing.
    this.postVotes = page.locator('[data-testid="post-total-votes"]');
    this.postVotesTooltip = page.locator('[data-testid="post-card-votes-tooltip"]');
    this.postResponse = page.locator('[data-testid="post-card-response-link"]');
    this.postResponseTooltip = page.locator('[data-testid="post-card-responses"]');
    // Reblog button on profile list pages (interactive - opens confirmation dialog)
    // ★ `post-card-reblog-count`/`-tooltip` DEAD on this card → `medium-card-reblog-count`
    // / `medium-card-reblog-tooltip` (medium-post-card.tsx:1531-1553). Tooltip text is
    // literally `Reblog` (LABELS.reblog, medium-post-card.tsx:64) — still matches /reblog/i.
    this.postReblogCountDisplay = page.locator('[data-testid="medium-card-reblog-count"]');
    this.postReblogCountTooltip = page.locator('[data-testid="medium-card-reblog-tooltip"]');
    // ★ `post-card-avatar`/`medium-card-avatar` DEAD → per the handoff brief, the
    // card's face has no testid of its own; it is the first `<a>` inside
    // `[data-testid="identity-pill"]` (identity-pill.tsx:130-141), scoped per-card via
    // `:first-child` (the avatar Link is literally the pill's first DOM child).
    this.postAvatar = page.locator('[data-testid="identity-pill"] > a:first-child');
    // ★ `post-author-reputation`/`post-reputation-tooltip` DEAD — NOT fixed. The
    // redesigned byline (`IdentityPill`) has no reputation display at all (grepped
    // medium-post-card.tsx + identity-pill.tsx, zero hits); reputation now only
    // appears via the hover-triggered `UserPopoverCard`, not a static element.
    this.postReputation = page.locator('[data-testid="post-author-reputation"]');
    this.postReputationTooltip = page.locator('[data-testid="post-reputation-tooltip"]');
    // ★ `cross-post-*` DEAD on this card — NOT fixed. These testids exist only on the
    // legacy `post-list-item.tsx` card; `medium-post-card.tsx` has no cross-post
    // attribution surface at all (grepped, zero hits) — a feature gap, not a rename.
    this.crossPostBanner = page.getByTestId('cross-post-banner');
    this.crossPostAuthorLink = page.getByTestId('cross-post-author-link');
    this.crossPostOriginalLink = page.getByTestId('cross-post-original-link');
    this.postsPostListLocator = page.getByTestId('post-list-user-posts');
    this.postsCommentsListLocator = page.getByTestId('comment-list-replies');
    this.postsPayoutsListLocator = page.getByTestId('post-list-user-payouts');

    this.repliesCommentListItem = page.locator('[data-testid="comment-list-item"]');
    this.repliesCommentListItemLoadNewer = page.locator('[div > button]').getByText('Load Newer');
    this.repliesCommentListItemTitle = page.locator('[data-testid="comment-card-title"]');
    this.repliesCommentListItemDescription = page.locator('[data-testid="comment-card-description"]');
    this.repliesCommentListItemAvatar = page.locator('[data-testid="comment-author-avatar"]');
    this.repliesCommentListItemAvatarLink = page.locator('[data-testid="comment-author-avatar-link"]');
    this.repliesCommentListItemCommunityLink = page.locator('[data-testid="comment-community-category-link"]');
    this.repliesCommentListItemTimestamp = page.locator('[data-testid="comment-timestamp"]');
    this.repliesCommentListItemUpvote = page.locator('[data-testid="comment-card-footer"] [data-testid="upvote-button"]');
    this.repliesCommentListItemDownvote = page.locator('[data-testid="comment-card-footer"] [data-testid="downvote-button"]');
    this.repliesCommentListItemUpvoteTooltip = page.locator('[data-testid="upvote-button-tooltip"]');
    this.repliesCommentListItemDownvoteTooltip = page.locator('[data-testid="downvote-button-tooltip"]');
    this.repliesCommentListItemPayout = page.locator('[data-testid="post-payout"], [data-testid="medium-card-payout"]');
    this.repliesCommentListItemPayoutTooltip = page.locator('[data-testid="payout-post-card-tooltip"]');
    this.repliesCommentListItemVotes = page.locator('[data-testid="comment-vote"]');
    this.repliesCommentListItemVotesTooltip = page.locator('[data-testid="comment-vote-tooltip"]');
    this.repliesCommentListItemRespond = page.locator('[data-testid="post-card-response-link"]');
    this.repliesCommentListItemRespondFirst = this.repliesCommentListItemRespond.first();
    this.repliesCommentListItemRespondTooltip = page.locator('[data-testid="comment-respond-tooltip"]');
    this.repliesCommentListItemArticleTitle = page.locator('[data-testid="article-title"]');

    this.notificationsMenu = page.locator('[data-testid="notifications-local-menu"]');
    this.notificationsMenuAllButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('All');
    this.notificationsMenuRepliesButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('Replies');
    this.notificationsMenuMentionsButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('Mentions');
    this.notificationsMenuFollowsButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('Follows');
    this.notificationsMenuUpvotesButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('Upvotes');
    this.notificationsMenuReblogsButton = page
      .locator('[data-testid="notifications-local-menu"]')
      .getByText('Reblogs');
    this.notificationsMenuAllContent = page.locator('[data-testid="notifications-content-all"]');
    this.notificationsMenuRepliesContent = page.locator('[data-testid="notifications-content-replies"]');
    this.notificationListItemInReplies = this.notificationsMenuRepliesContent.locator('[data-testid="notification-list-item"]');
    this.notificationsMenuMentionsContent = page.locator('[data-testid="notifications-content-mentions"]');
    this.notificationListItemInMentions = this.notificationsMenuMentionsContent.locator('[data-testid="notification-list-item"]');
    this.notificationsMenuFollowsContent = page.locator('[data-testid="notifications-content-follows"]');
    this.notificationListItemInFollows = this.notificationsMenuFollowsContent.locator('[data-testid="notification-list-item"]');
    this.notificationsMenuUpvotesContent = page.locator('[data-testid="notifications-content-upvotes"]');
    this.notificationListItemInUpvotes = this.notificationsMenuUpvotesContent.locator('[data-testid="notification-list-item"]');
    this.notificationsMenuReblogsContent = page.locator('[data-testid="notifications-content-reblogs"]');
    this.notificationListItemInReblogs = this.notificationsMenuReblogsContent.locator('[data-testid="notification-list-item"]');

    this.notificationNickName = page.locator('[data-testid="subscriber-name"]');
    this.notificationAccountIconLink = page.locator('[data-testid="notification-account-icon-link"]');
    this.notificationAccountAndMessage = page.locator('[data-testid="notification-account-and-message"]');
    this.notificationTimestamp = page.locator('[data-testid="notification-timestamp"]');
    this.notificationListItemInAll = this.notificationsMenuAllContent.locator('[data-testid="notification-list-item"]');
    this.notificationListItemEvenInAll = this.notificationsMenuAllContent.locator('[data-testid="notification-list-item"]:nth-of-type(even)');
    this.notificationListItemOddInAll =  this.notificationsMenuAllContent.locator('[data-testid="notification-list-item"]:nth-of-type(odd)');
    this.notificationProgressBar = page.locator('[data-testid="notification-progress-bar"]');
    this.notificationLoadMoreButtonInAll = this.notificationsMenuAllContent.getByText('Load more');
    this.notificationLoadMoreButtonInReblogs = this.notificationsMenuReblogsContent.getByText('Load more');
    // this.subscribersLoadMoreButton = this.subscribersNotificationContent.getByText('Load more');


    this.publicProfileSettings = page.locator('[data-testid="public-profile-settings"]');
    this.publicProfileSettingsHeader = this.publicProfileSettings.locator('h2').nth(0);
    this.apiEndpointCard = this.publicProfileSettings.locator('.rounded-lg');
    this.apiEndpointButton = this.publicProfileSettings.locator('[data-testid="comment-close-open"]').first();
    this.firstSetMainButton = this.publicProfileSettings.getByTestId('hc-set-api-button').first();
    this.apiSelectedNodeText = this.publicProfileSettings.getByTestId('hc-selected');
    this.apiEndpointAISearchButton = this.publicProfileSettings.locator('[data-testid="comment-close-open"]').last();
    this.apiAddressInput = this.publicProfileSettings.locator('[data-testid="api-address-input"]');
    this.apiFilterInput = this.publicProfileSettings.locator('[placeholder="Filter by URL…"]');
    this.apiAddButton = this.publicProfileSettings.locator('button').getByText('Add');
    this.apiRestoreDefaultServerSetButton = this.publicProfileSettings.getByText('Restore default API server set');
    this.preferencesProfileSettingsHeader = this.publicProfileSettings.locator('h2').nth(1);
    this.advancedProfileSettingsHeader = this.publicProfileSettings.locator('h2').nth(2);

    this.ppsProfilePictureUrlLabel = this.publicProfileSettings.locator('[for="profileImage"]');
    this.ppsProfilePictureUrlInput = this.publicProfileSettings.locator('#profileImage');
    this.ppsCoverImageUrlLabel = this.publicProfileSettings.locator('[for="coverImage"]');
    this.ppsCoverImageUrlInput = this.publicProfileSettings.locator('#coverImage');
    this.ppsDisplayNameLabel = this.publicProfileSettings.locator('[for="name"]');
    this.ppsDisplayNameInput = this.publicProfileSettings.locator('#name');
    this.ppsAboutLabel = this.publicProfileSettings.locator('[for="about"]');
    this.ppsAboutInput = this.publicProfileSettings.locator('#about');
    this.ppsLocationLabel = this.publicProfileSettings.locator('[for="location"]');
    this.ppsLocationInput = this.publicProfileSettings.locator('#location');
    this.ppsWebsiteLabel = this.publicProfileSettings.locator('[for="website"]');
    this.ppsWebsiteInput = this.publicProfileSettings.locator('#website');
    this.ppsBlacklistDescriptionLabel = this.publicProfileSettings.locator('[for="blacklistDescription"]');
    this.ppsBlacklistDescriptionInput = this.publicProfileSettings.locator('#blacklistDescription');
    this.ppsMuteListDescriptionLabel = this.publicProfileSettings.locator('[for="mutedListDescription"]');
    this.ppsMuteListDescriptionInput = this.publicProfileSettings.locator('#mutedListDescription');
    this.ppsButtonUpdate = this.publicProfileSettings.locator('[data-testid="pps-update-button"]');

    this.preferencesSettings = page.locator('[data-testid="settings-preferences"]');
    this.preferencesSettingsChooseLanguage = this.preferencesSettings.locator(
      '[data-testid="choose-language"]'
    );
    this.preferencesSettingsNoSafeForWorkContent = this.preferencesSettings.locator(
      '[data-testid="not-safe-for-work-content"]'
    );
    this.preferencesSettingsBlogPostRewards = this.preferencesSettings.locator(
      '[data-testid="blog-post-rewards"]'
    );
    this.preferencesSettingsCommentsPostRewards = this.preferencesSettings.locator(
      '[data-testid="comment-post-rewards"]'
    );
    this.preferencesSettingsReferralSystem = this.preferencesSettings.locator(
      '[data-testid="referral-system"]'
    );

    this.advancedSettingsApiEndpointRadioGroup = page.locator('[data-testid="api-endpoint-radiogroup"]')
    this.advancedSettingsApiEndpointList = this.advancedSettingsApiEndpointRadioGroup.locator('div label')
    this.advancedSettingsApiEndpointButton = this.advancedSettingsApiEndpointRadioGroup.locator('div button')
    this.advancedSettingsApiEndpointAdd = page.locator('[data-testid="add-api-endpoint"]')
    this.advancedSettingsApiEndpointAddInput = this.advancedSettingsApiEndpointAdd.locator('input')
    this.advancedSettingsApiEndpointAddButton = this.advancedSettingsApiEndpointAdd.locator('button')
    this.advancedSettingsApiResetEndpointsButton = page.getByText('Reset Endpoints')

    // Use partial href matching - URL varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag
    this.thirdPartyAppPeakdLink = page.locator('[data-testid="badges-achievements-description"] a[href*="peakd.com"]');
    this.thirdPartyAppHivebuzzLink = page.locator('[data-testid="badges-achievements-description"] a[href*="hivebuzz.me"]');
    this.communitySubscriptionHeader = page.getByText('Community Subscriptions');
    this.followedBlacklists = page.getByText('Followed Blacklists');
    this.followedBlacklistsHeader = page.locator('h1.text-xl.font-bold').first();
    this.followedMutedLists = page.getByText('Followed Muted Lists')
    this.followedMutedListsHeader = page.locator('h1.text-xl.font-bold').first();

    this.socialBadgesAchievemntsMenuBar = page.locator('[data-testid="badges-activity-menu"]');
    this.socialMenuBarBadges = this.socialBadgesAchievemntsMenuBar.getByText('Badges');
    this.socialMenuBarActivity  = this.socialBadgesAchievemntsMenuBar.getByText('Activity');
    this.socialMenuBarPersonal  = this.socialBadgesAchievemntsMenuBar.getByText('Personal');
    this.socialMenuBarMeetups  = this.socialBadgesAchievemntsMenuBar.getByText('Meetups');
    this.socialMenuBarChallenges  = this.socialBadgesAchievemntsMenuBar.getByText('Challenges');
    this.socialCommunitySubscriptionsLabel = page.locator('[data-testid="community-subscriptions-label"]');
    this.socialCommunitySubscriptionsDescription = page.locator('[data-testid="community-subscriptions-description"]');
    this.socialAuthorSubscribedCommunitiesList = page.locator('[data-testid="author-subscribed-communities-list"]');
    this.socialAuthorSubscribedCommunitiesListItem = page.locator('[data-testid="author-community-subscribed-list-item"]');
    this.socialAuthorSubscribedCommunitiesLink = page.locator('[data-testid="author-community-subscribed-link"]');
    this.socialAuthorSubscribedCommunitiesRoleTag = page.locator('[data-testid="author-role-community"]');
    this.socialAuthorSubscribedCommunitiesAffiliationTag = page.locator('[data-testid="author-affiliation-tag"]');
    this.socialBadgesAchivementsLabel = page.locator('[data-testid="badges-achievements-label"]');
    this.socialBadgesAchivementsDescription = page.locator('[data-testid="badges-achievements-description"]');
    this.socialBadgeAchivement = page.locator('[data-testid="badge-achievement"]');
    this.blogTabPostsContainer = page.locator('main.container');
    this.firstCommunityLinkPostsComments = page.locator('span.text-xs a').first();
    this.communityName = page.locator('[data-testid="community-name"]');
    this.communityTimeStamp = page.locator('span.text-xs a').nth(1);
    this.userHasNotStartedBloggingYetMsg = page.locator('[data-testid="user-has-not-started-blogging-yet"]');
    this.userDoesNotHaveAnySubscriptionsYetMsg = page.locator('[data-testid="user-does-not-have-any-subscriptions-yet"]');
    this.userHasNotHadAnyNotificationsYetMsg = page.locator('[data-testid="user-has-not-had-any-notifications-yet"]');
    // ★ `profile-level-link`/`profile-level-image`/`profile-twitter-badge` DEAD — NOT
    // fixed. The HiveBuzz whale/orca level badge these targeted no longer exists;
    // `ProfileLeagueChip` (profile-league-chip.tsx) replaced it with an unrelated
    // feature (Lumen's own tier/rank system, different data source, an SVG emblem
    // instead of `/whale.png`/`/orca.png`, different copy entirely). See the class
    // doc comment above.
    this.userBannerLevelLink = page.locator('[data-testid="profile-level-link"]');
    this.userBannerLevelImg = page.locator('[data-testid="profile-level-image"]');
    this.userBannerTwitterBadgeLink = page.locator('[data-testid="profile-twitter-badge"]');

    this.notFoundPage = page.locator('[data-testid="not-found-page"]');
    this.notFoundHeading = this.notFoundPage.locator('h1');

    // Followed / Followers pages render an `<h1>` with the pagination label
    // ("Followed page 1 from 46" / "Followers page 1 from 46").
    this.followedFollowersPageHeading = page.locator('main main h1').first();
    this.followedFollowersList = page.locator('main main ul').first();
    this.followedFollowersListItems = this.followedFollowersList.locator('li');

    this.postsMenuActiveTab = this.postsMenu.locator('[data-state="active"]');
  }

  async gotoProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
  }

  // REMOVED 2026-08-10: gotoPostsProfilePage (`/posts`), gotoPostsPayoutsProfilePage
  // (`/payout`), gotoRepliesProfilePage (`/replies`), gotoNotificationsProfilePage
  // (`/notifications`) — all four routes are deleted; each 302s to `/404` on the
  // live dev server today. `/comments` survives (gotoPostsCommentsProfilePage below).

  async gotoPostsCommentsProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}/comments`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
    await this.page.waitForSelector(this.profileBlogPostsList['_selector']);
  }

  /**
   * ★ NO LONGER WAITS FOR THE BADGE MENU (2026-08-11).
   *
   * This used to end with `waitForSelector('[data-testid="badges-activity-menu"]')`.
   * That element only renders when third-party APIs are ENABLED: `SocialActivities`
   * (features/account-social/social-activities.tsx:38-41) is mounted from the
   * `isThirdPartyApiEnabled()` branch of
   * app/[param]/(user-profile)/communities/content.tsx:61-96, and
   * `isThirdPartyApiEnabled()` (packages/transaction/lib/custom-api.ts:14-17)
   * defaults to FALSE and is explicitly `false` in every env file in this repo
   * (.env.testing:30, .env.mirrornet-testing:30) — "CSP blocks these domains
   * anyway". With it off, the page renders a plain sentence with static links to
   * peakd.com / hivebuzz.me and the badge menu never mounts.
   *
   * So this helper hung for the full selector timeout on EVERY call, in the
   * default configuration, forever. That took down the whole of
   * profileSocialPage.spec.ts (which was blamed on "PeakD 500 errors") AND two
   * still-ACTIVE tests in profilePage.spec.ts ('move to Peakd by link in Social
   * Tab', 'validate Hivebuzz link in Social Tab').
   *
   * It now waits for what the page renders in BOTH configurations. Tests that
   * genuinely need the badge widget must assert on it themselves — and require
   * REACT_APP_ENABLE_THIRD_PARTY_API=true.
   */
  async gotoSocialProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}/communities`);
    await this.page.waitForLoadState('domcontentloaded');
    // `profile-info` is dead (0 hits in product source — see the class doc); the
    // subpage shell's own wrapper is the live equivalent and is server-rendered.
    await this.page.waitForSelector(this.profileSubpageMain['_selector']);
    await this.page.waitForSelector(this.socialBadgesAchivementsLabel['_selector']);
  }

  async gotoCommunitiesProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}/communities`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
    await this.page.waitForSelector(this.socialCommunitySubscriptionsLabel['_selector']);
  }

  async gotoFollowedProfilePage(nickName: string) {
    // ★ `/following` since the 2026-08-13 route rename. `/followed` still
    // answers (308 permanent redirect) but a test that navigates through a
    // redirect is measuring the redirect as well as the page.
    await this.page.goto(`/@${nickName}/following`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
  }

  async gotoFollowersProfilePage(nickName: string) {
    await this.page.goto(`/@${nickName}/followers`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
  }

  async gotoNonExistentProfilePage(nickName: string) {
    await this.page.goto(`/@${nickName}`);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async gotoApiEndpointHealthcheckerProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}/settings`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
    await this.page.waitForSelector(this.apiEndpointButton['_selector']);
    await this.page.waitForSelector(this.page.getByText('Condenser - Get accounts')['_selector']);
  }

  async gotoAISearchApiEndpointHealthcheckerProfilePage(nickName: string) {
    await this.page.goto(`/${nickName}/settings`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(this.profileInfo['_selector']);
    await this.page.waitForSelector(this.apiEndpointAISearchButton['_selector']);
    // Click Endpoint for AI search
    await this.apiEndpointAISearchButton.click();
    await this.page.waitForSelector(this.page.getByText('AI search').first()['_selector']);
    await this.page.waitForTimeout(1000);
  }

  /*
   * ★★ WAIT FOR THE PROFILE BEFORE READING ITS NAME (2026-08-21).
   *
   * `profileName` is `page.locator('h1')` — the profile's display name is the only
   * `<h1>` on a profile page. But a POST page has an `<h1>` too: the article title.
   * Every caller of this reaches the profile by CLICKING (a popover name, an author
   * link) and then waiting only for `domcontentloaded`, which fires for the page
   * they are leaving. Lose that race and this read returns the post's title.
   *
   * Measured: three `comments.spec.ts` tests failed with
   * expected "Sicarius" / received "Hive HardFork 25 Jump Starter Kit" — the
   * fixture post's own title. Not a wrong value, a wrong page.
   *
   * Waiting for the URL to actually be a profile removes the race without
   * loosening what is asserted: the name comparison below is unchanged.
   */
  async profileNameIsEqual(authorName: string) {
    // ★ Wait for something ONLY a profile has, not a URL shape. A first attempt
    // used `waitForURL(/\/@[^/]+/)` and matched instantly on the page it was
    // leaving — a post URL is `/<community>/@<author>/<permlink>`, which contains
    // `/@author`. `profile-identity-block` renders on the profile and nowhere else.
    await this.page.locator('[data-testid="profile-identity-block"]').waitFor({ timeout: 30000 });
    expect(await this.profileName.textContent()).toMatch(authorName);
  }

  /**
   * Website link in the metadata row of the profile header. The website
   * value is rendered as the link's visible text (no dedicated testid,
   * see `profile-layout.tsx:357-363`), so we match by accessible name.
   */
  profileWebsiteLink(website: string): Locator {
    return this.page.getByRole('link', { name: website });
  }

  async profileInfoIsVisible(
    nickName: string,
    profileName: string,
    profileAbout: string,
    userJoined: string
  ) {
    await this.page.waitForSelector(this.profileInfo['_selector']);
    await expect(this.profileInfo).toBeVisible();
    // expect(await this.profileNickName.textContent()).toMatch(nickName);
    expect(await this.profileName.textContent()).toMatch(profileName);
    // await this.profileNickNameIsEqual(nickName);
    expect(await this.profileAbout.textContent()).toMatch(profileAbout);
    await expect(this.profileLastTimeActive).toBeVisible();
    expect(await this.profileJoined.textContent()).toMatch(userJoined);
    await expect(this.profileLocation).toBeVisible();
    await expect(this.profileStats).toBeVisible();
    // await expect(this.followButton).toBeVisible();
    // await expect(this.userLinks).toBeVisible();
  }

  async getElementCssPropertyValue(element: Locator, cssProperty: string) {
    const property = await element.evaluate((ele, css) => {
      return window.getComputedStyle(ele).getPropertyValue(css);
    }, cssProperty);
    // return value of element's css property
    return property;
  }

  async validatePostHeaderElementsVisible() {
    await expect(this.postsPostAuthor.first()).toBeVisible();
    await expect(this.postReputation.first()).toBeVisible();
    await expect(this.postReputation.first()).toHaveAttribute('title', 'Reputation');
    await expect(this.postTimestamp.first()).toBeVisible();
  }

  async validatePostHeaderHoverBehavior() {
    const firstPostItem = this.postBlogItem.first();

    // Author name should be a link (cursor pointer)
    const authorCursor = await this.getElementCssPropertyValue(this.postsPostAuthor.first(), 'cursor');
    expect(authorCursor).toBe('pointer');

    // Timestamp should be a link
    const timestampCursor = await this.getElementCssPropertyValue(this.postTimestamp.first(), 'cursor');
    expect(timestampCursor).toBe('pointer');

    // Community link if present
    if (await firstPostItem.filter({ has: this.postCommunityLink }).isVisible()) {
      const communityCursor = await this.getElementCssPropertyValue(this.postCommunityLink.first(), 'cursor');
      expect(communityCursor).toBe('pointer');
    }

    // Category link if present
    if (await firstPostItem.filter({ has: this.postCategoryLink }).isVisible()) {
      const categoryCursor = await this.getElementCssPropertyValue(this.postCategoryLink.first(), 'cursor');
      expect(categoryCursor).toBe('pointer');
    }
  }

  async validateUpvoteButtonStructure() {
    await expect(this.postUpvoteButton.first()).toBeVisible();
    await expect(this.postUpvoteButton.first().locator('svg').first()).toBeVisible();
  }

  async validateDownvoteButtonStructure() {
    await expect(this.postDownvoteButton.first()).toBeVisible();
    await expect(this.postDownvoteButton.first().locator('svg').first()).toBeVisible();
  }

  async validatePayoutVisible() {
    const payout = this.postPayout.first();
    await expect(payout).toBeVisible();
    await expect(payout).toHaveText(/\$\d+\.\d{2,3}/);
  }

  async validateReblogCountWithTooltip() {
    const reblogCount = this.postReblogCountDisplay.first();
    await expect(reblogCount).toBeVisible();
    await reblogCount.hover();
    await expect(this.postReblogCountTooltip.first()).toBeVisible();
    expect(await this.postReblogCountTooltip.first().textContent()).toMatch(/reblog/i);
  }

  async validateCommentUpvoteButtonStructure() {
    await expect(this.postBlogItem.first()).toBeVisible({ timeout: 15000 });
    await expect(this.postUpvoteButton.first()).toBeVisible({ timeout: 10000 });
    await expect(this.postUpvoteButton.first().locator('svg').first()).toBeVisible();
  }

  async validateCommentDownvoteButtonStructure() {
    await expect(this.postBlogItem.first()).toBeVisible({ timeout: 15000 });
    await expect(this.postDownvoteButton.first()).toBeVisible({ timeout: 10000 });
    await expect(this.postDownvoteButton.first().locator('svg').first()).toBeVisible();
  }

  async validateCommentPayoutVisible() {
    const payout = this.repliesCommentListItemPayout.first();
    await expect(payout).toBeVisible();
    await expect(payout).toHaveText(/\$\d+\.\d{2,3}/);
  }

  async validateNotificationFilterTabSwitch(button: Locator, contentPanel: Locator) {
    await expect(button).toBeVisible();
    await button.click();
    await expect(contentPanel).toBeVisible();
  }

  // REMOVED 2026-08-10: profileBlogTabIsSelected/profilePostsTabIsSelected/
  // profilePostsTabIsNotSelected/profileRepliesTabIsSelected/
  // profileRepliesTabIsNotSelected — the Blog/Posts/Replies nav tabs and the
  // `/posts` and `/replies` routes they checked no longer exist (see the class
  // doc comment above).

  async profileSocialTabIsSelected() {
    await this.page.waitForSelector(this.communitySubscriptionHeader['_selector']);
    await expect(this.page).toHaveURL(/.*communities/)
    await expect(this.page.getByText('Community Subscriptions')).toBeVisible();
    await expect(
      this.page.getByText('The author has subscribed to the following Hive Communities')
    ).toBeVisible();
    // Use data-testid instead of hardcoded text (text varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag)
    await expect(this.socialBadgesAchivementsLabel).toBeVisible();
    await expect(this.socialBadgesAchivementsDescription).toBeVisible();
  }

  async profileSocialTabIsNotSelected() {
    await expect(this.page).not.toHaveURL(/.*replies/)
  }

  // REMOVED 2026-08-10: profileNotificationsTabIsSelected/
  // profileNotificationsTabIsNotSelected/profileSettingsTabIsSelected/
  // profileSettingsTabIsNotSelected/moveToPostsTab/moveToRepliesTab/
  // moveToSocialTab/moveToNotificationsTab/moveToWalletPage/moveToSettingsTab
  // — all clicked or checked the removed profile-navigation chrome, and
  // `/notifications` no longer resolves (see the class doc comment above).
  // `/wallet` is a real, live, auth-gated top-level route now
  // (app/wallet/page.tsx) — reach it with `page.goto('/wallet')`, not via a
  // profile nav click.

  async moveToPeakdByLinkInSocialTab() {
    const pagePromise = this.page.context().waitForEvent('page');
    await this.thirdPartyAppPeakdLink.click();
    const newPage = await pagePromise;
    // URL varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag (peakd.com vs peakd.com/@user/badges)
    await expect(newPage).toHaveURL(/peakd\.com/);
    await expect(newPage).toHaveTitle(/PeakD/);
  }

  async moveToHivebuzzByLinkInSocialTab() {
    const pagePromise = this.page.context().waitForEvent('page');
    await this.thirdPartyAppHivebuzzLink.click();
    const newPage = await pagePromise;
    // URL varies based on REACT_APP_ENABLE_THIRD_PARTY_API flag (hivebuzz.me vs hivebuzz.me/@user)
    await expect(newPage).toHaveURL(/hivebuzz\.me/);
    await expect(newPage).toHaveTitle('HiveBuzz');
  }
}
