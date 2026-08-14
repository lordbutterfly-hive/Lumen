import { Page } from '@playwright/test';
import { HomePage } from './pages/homePage';
import { CommunitiesPage } from '../support/pages/communitiesPage';
import { CommentEditorPage } from './pages/commentEditorPage';
import {
  waitForElementVisible,
  waitForElementColor,
  waitForDownvoteColor,
  waitForCommentIsVisible
} from './utils';
import { UnmoderatedTagPage } from './pages/unmoderatedTagPage';
import { CommunitiesExplorePage } from './pages/communitiesExplorerPage';

export async function waitForCommunitySubscribeButton(page: Page) {
  const communityPage = new CommunitiesPage(page);
  const selectorSubscribeButton = await communityPage.communitySubscribeButton['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, selectorSubscribeButton, timeout, interval);
}

export async function waitForCommunityJoinedLeaveButton(page: Page) {
  const communityPage = new CommunitiesPage(page);
  const selectorSubscribeButton = await communityPage.communityJoinedLeaveButton['_selector'];
  const timeout = 30000;
  const interval = 3000;

  await waitForElementVisible(page, selectorSubscribeButton, timeout, interval);
}

export async function waitForLifestyleCommunitySubscribeButtonInCommunityExplorerPage(page: Page) {
  const communitiesExplorerPage = new CommunitiesExplorePage(page);
  const selectorSubscribeButton = await communitiesExplorerPage.getLifestyleCommunityButton['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, selectorSubscribeButton, timeout, interval);
}

export async function waitForLifestyleCommunityJoinedLeaveButtonInCommunityExplorerPage(page: Page) {
  const communitiesExplorerPage = new CommunitiesExplorePage(page);
  const selectorJoinedLeaveButton = await communitiesExplorerPage.getLifestyleCommunityButton['_selector'];
  const timeout = 30000;
  const interval = 3000;

  await waitForElementVisible(page, selectorJoinedLeaveButton, timeout, interval);
}

export async function waitForCommentEditorIsLoaded(page: Page) {
  const commentEditorPage = new CommentEditorPage(page);
  const commentRepleyEditor = await commentEditorPage.getReplayEditorElement['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, commentRepleyEditor, timeout, interval);
}

export async function waitForCommunityCreatedPost(page: Page, postTitle: string) {
  const communityPage = new CommunitiesPage(page);
  const selectorCreatedPost = await communityPage.page.getByText(postTitle)['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, selectorCreatedPost, timeout, interval);
}

export async function waitForPostIsVisibleInUnmoderatedTagPage(page: Page, postTitle: string) {
  const unmoderatedTagPage = new UnmoderatedTagPage(page);
  const selectorCreatedPost = await unmoderatedTagPage.page.getByText(postTitle).first()['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, selectorCreatedPost, timeout, interval);
}

export async function waitForCreatedCommentIsVisible(page: Page, commentContent: string) {
  const timeout = 30000;
  const interval = 4000;

  await waitForCommentIsVisible(page, commentContent, timeout, interval);
}

export async function waitForFirstBroadcastedUpvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostUpvoteButton = await homePage.firstPostCardUpvoteButtonLocator['_selector'];

  const timeout = 20000;
  const interval = 4000;
  const lightModeRedColor = 'rgb(218, 43, 43)'; // upvote icon's color not processed in the dark mode

  await waitForElementColor(page, selectorFirstPostUpvoteButton, lightModeRedColor, timeout, interval);
}

export async function waitForFirstProcessedUpvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostUpvoteButton = await homePage.firstPostCardUpvoteButtonLocator['_selector'];
  const timeout = 20000;
  const interval = 4000;
  const lightModeWhiteColor = 'rgb(255, 255, 255)'; // upvote icon's color processed in the light mode

  await waitForElementColor(page, selectorFirstPostUpvoteButton, lightModeWhiteColor, timeout, interval);
}

export async function waitForFirstBroadcastedDownvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostDownvoteButton = await homePage.firstPostCardDownvoteButtonLocator['_selector'];

  const timeout = 20000;
  const interval = 4000;
  const lightModeRedColor = 'rgb(75, 85, 99)'; // upvote icon's color not processed in the dark mode

  await waitForDownvoteColor(page, selectorFirstPostDownvoteButton, lightModeRedColor, timeout, interval);
}

export async function waitForFirstProcessedDownvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostDownvoteButton = await homePage.firstPostCardDownvoteButtonLocator['_selector'];
  const timeout = 20000;
  const interval = 4000;
  const lightModeWhiteColor = 'rgb(255, 255, 255)'; // upvote icon's color processed in the light mode

  await waitForDownvoteColor(page, selectorFirstPostDownvoteButton, lightModeWhiteColor, timeout, interval);
}

export async function waitForSecondBroadcastedDownvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostDownvoteButton = await homePage.getSecondPostDownvoteButtonIcon['_selector'];

  const timeout = 20000;
  const interval = 4000;
  const lightModeRedColor = 'rgb(75, 85, 99)'; // upvote icon's color not processed in the dark mode

  await waitForDownvoteColor(page, selectorFirstPostDownvoteButton, lightModeRedColor, timeout, interval);
}

export async function waitForSecondProcessedDownvoteLightMode(page: Page) {
  const homePage = new HomePage(page);
  const selectorFirstPostDownvoteButton = await homePage.getSecondPostDownvoteButtonIcon['_selector'];
  const timeout = 20000;
  const interval = 4000;
  const lightModeWhiteColor = 'rgb(255, 255, 255)'; // upvote icon's color processed in the light mode

  await waitForDownvoteColor(page, selectorFirstPostDownvoteButton, lightModeWhiteColor, timeout, interval);
}

/**
 * ★★★ THIS WAITED ON AN ELEMENT THAT NO LONGER EXISTS, AND PASSED ANYWAY (2026-08-14).
 *
 * It was `page.waitForSelector('.circle__Wrapper-sc-16bbsoy-0', { state: 'detached' })`
 * — the styled-components class of the `CircleSpinner` that used to REPLACE the
 * whole up (or down) side of the vote control while a vote was in flight. That
 * spinner was deleted on 2026-08-14: it unmounted the only element that could
 * render the commit ring, at the exact instant the ring was asked to appear, so
 * the cast animation was structurally impossible.
 *
 * Playwright resolves a `detached` wait IMMEDIATELY when the selector never
 * matched anything. So this helper did not fail — it went green in 3ms instead
 * of 807ms, and every assertion behind it (vote colour, tooltip text) began
 * firing roughly 800ms early against a control that was still mid-flight. 18
 * call sites across `votingPOM.spec.ts` and `votingSlider.spec.ts` lost their
 * sync point without a single red test. A silent green is worse than a hang:
 * a hang gets fixed.
 *
 * ★ The in-flight signal is now `disabled` ON the button, which stays mounted —
 * measured present for 36-41 frames of a cast, where the spinner was present for
 * 39. Waiting for it to CLEAR is the same sync point, expressed against the
 * element that actually exists now.
 *
 * ★ `state: 'attached'` FIRST, deliberately. That is the half that cannot pass
 * vacuously: if the vote button is missing entirely — wrong page, control not
 * rendered, testid renamed — this throws instead of sailing through, which is
 * exactly the failure the old helper hid. Only then do we wait for the disabled
 * state to lift.
 */
export async function waitForCircleSpinnerIsDetatched(page: Page) {
  const inFlight = '[data-testid="upvote-button"][disabled], [data-testid="downvote-button"][disabled]';

  // The control must be on the page at all before "not in flight" means anything.
  await page.waitForSelector('[data-testid="upvote-button"], [data-testid="downvote-button"]', {
    state: 'attached'
  });
  await page.waitForSelector(inFlight, { state: 'detached' });
}

export async function waitForLifestyleMySubscriptionsLink(page: Page) {
  const homePage = new HomePage(page);
  const selectorLifestyleMySubscriptionLink = await homePage.getLifestyleCommunityLink['_selector'];
  const timeout = 20000;
  const interval = 4000;

  await waitForElementVisible(page, selectorLifestyleMySubscriptionLink, timeout, interval);
}
