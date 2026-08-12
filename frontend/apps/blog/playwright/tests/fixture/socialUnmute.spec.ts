import { test, expect } from '../support/fixture-proxy-test';
import {
  installBroadcastInterceptor,
  expectFollowCustomJson
} from '../support/fixture-auth/broadcast-interceptor';
import { UserListPage } from '../support/pages/userListPage';
import { FOLLOWER, BLACKLIST_TARGETS, WHAT_UNMUTE, gotoOwnList } from '../support/followMuteContext';

/**
 * §9.2 Mute — MUTE-02: unmute (remove a single account from the muted
 * list) via its row button on the owner's `/lists/muted` page.
 *
 * ★ RETARGETED (2026-08-12, Block consolidation cleanup). This used to
 * click a profile-header "Unmute" toggle button
 * (`features/mute-follow/buttons-container.tsx`, `data-testid="profile-mute-button"`).
 * That surface — and the whole redesigned profile header it belonged to —
 * doesn't render a Mute control at all any more: Mute's WRITE affordance
 * was retired from every primary surface (profile/post/comment overflow
 * menus, the author popover, `ButtonsContainer`) in favour of one control,
 * Block (owner ruling 2026-08-12, `lib/lite/social/block-service.ts`).
 *
 * On-chain mute now works exactly the way Blacklist always has: management
 * only, from its dedicated `/lists/muted` page (compare
 * `socialBlacklistManage.spec.ts`'s BL-02, which this test now mirrors
 * 1:1). Adding a mute is already covered from that same page by MUTE-03/04
 * (`socialMutedListAdd.spec.ts`); this file covers the one operation
 * nothing else in the mute suite does — removing a SINGLE existing entry
 * and confirming the rest of the list survives, the same gap BL-02 fills
 * for Blacklist. (The old profile-header "add a mute" spec,
 * `socialMute.spec.ts`, was deleted rather than retargeted here: pointing
 * it at the same `/lists/muted` add-form MUTE-03 already exercises would
 * have been pure duplicate coverage.)
 *
 * Reuses the `socialMutedListPage_populated` overlay MUTE-05
 * (`socialMutedListReset.spec.ts`) already established — pre-loads
 * `BLACKLIST_TARGETS` into the muted list, so `hiveio`'s row and its
 * Unmute button are present without any new fixture recording.
 *
 * Wire-form: wax aliases `unmuteBlog` to `unfollowBlog`, so the payload is
 * `["follow", { follower, following, what: [""] }]` — single-string
 * `following` (no rest args) and a 1-element `what` holding the empty
 * UNFOLLOW action.
 */

test.use({
  fixtureTestName: 'socialMutedListPage_populated',
  authenticatedUser: {}
});

test('MUTE-02 — Remove account from muted list via row button', async ({ page }) => {
  const broadcast = await installBroadcastInterceptor(page, undefined, {
    confirmInBlock: true
  });
  await gotoOwnList(page, 'muted');
  const userList = new UserListPage(page);
  const target = BLACKLIST_TARGETS[0];
  await expect(userList.itemRow(target)).toBeVisible();

  await userList.removeButton(target).click();
  await broadcast.waitForCount(1);

  expectFollowCustomJson(broadcast.calls[0], {
    follower: FOLLOWER,
    following: target,
    what: WHAT_UNMUTE
  });

  await expect(userList.itemRow(target)).toHaveCount(0);
  // Removing one leaves the rest — same "no stale full-list re-render"
  // check BL-02 makes for blacklist.
  await expect(userList.items).toHaveCount(BLACKLIST_TARGETS.length - 1);
});
