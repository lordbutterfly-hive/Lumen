import { test, expect } from '../support/fixture-proxy-test';
import { TIMEOUTS } from '../support/constants';

/**
 * §9.2 Mute → Block consolidation — MUTE-PROP-01.
 *
 * ★ REWRITTEN (2026-08-12, Block consolidation cleanup). This used to mute a
 * comment author LIVE via the user popover's MuteButton
 * (`data-testid="profile-mute-button"`, mounted by
 * `features/mute-follow/buttons-container.tsx`) and assert the comment
 * collapsed in-place behind an AccordionTrigger reading "Reveal Comment
 * (muted by you)". Neither half of that is still true:
 *
 *   1. Mute's WRITE affordance was retired from every primary surface —
 *      including this popover — in favour of one control, Block (owner
 *      ruling 2026-08-12: "mute and personal blacklist should be the same
 *      damn thing... just call it block", `lib/lite/social/block-service.ts`).
 *      There is no more MuteButton to click here; `buttons-container.tsx`
 *      only renders Follow + Block now, for every author.
 *   2. Even the OLD behaviour this test asserted (collapse-with-Reveal for
 *      the viewer's own mute) is gone. `lib/muted-reasons.ts`'s
 *      `isOwnModerationHide` now hard-hides a comment from an account the
 *      viewer personally muted or blacklisted — no card, no Reveal, the
 *      same treatment an actual Block gets
 *      (`comment-list-item.tsx`'s `if (userModerationHidden) return null`).
 *
 * This spec now proves the structural half of the Block reality that
 * doesn't require a new mutation: the popover offers Block, and nothing
 * calling itself Mute renders there for anybody. It deliberately does NOT
 * click Block. Unlike on-chain mute (a Hive `custom_json` this suite stubs
 * via `installBroadcastInterceptor`), a Lumen block is a same-origin
 * `/api/lite/block` POST to this app's own backend — nothing in
 * `playwright/tests/support/fixture-auth/` mocks that (see that directory's
 * CLAUDE.md: it only stubs chain broadcast/verify_authority RPCs and
 * replays chain reads through the :8200 fixture proxy). Exercising a real
 * Block click here would write a real row against whatever backend this
 * suite's webServer is actually wired to — outside what this offline
 * fixture harness is built to prove safely, and no part of this cleanup
 * pass builds new mock infrastructure for `/api/lite/block/*`.
 *
 * `/api/lite/block/state-bulk` (which `useLumenBlock` now coalesces every
 * mounted card's request into — see that hook's doc for the N+1 fix this
 * batching replaced, 2026-08-12) is stubbed LOCALLY, in this spec only, so
 * the assertion below is deterministic regardless of whether a real Lumen DB
 * is reachable from this webServer: `state-bulk/route.ts` degrades any
 * lookup failure to `available:false` for every requested target ("must
 * never claim a block that may not exist"), which would make BlockButton
 * silently vanish and fail this test for an environment reason that has
 * nothing to do with whether Mute is really gone. The stub below echoes back
 * whatever `(target, kind)` pairs the page actually batched together — every
 * comment on this thread mounts its own `useLumenBlock`, so the real request
 * asks about all of steevc's fellow commenters too, not just him.
 *
 * Pinned post + commenter unchanged from the original recording:
 * `/@hiveio/hive-at-blockchain-rio` has 8 top-level (depth=1) replies;
 * `steevc` is one of them ("Have fun spreading the word about Hive.").
 * Re-record if the post is removed or steevc's top-level comment is pruned.
 */

const MUTE_COMMENT_POST = '/@hiveio/hive-at-blockchain-rio';
const MUTE_COMMENT_TARGET = 'steevc';

test.use({
  fixtureTestName: 'socialMuteCommentEffect',
  authenticatedUser: {}
});

test('MUTE-PROP-01 — Comment author popover offers Block, not Mute', async ({ page }) => {
  // Same-origin Lumen route, not a chain call — see the file doc above for
  // why this is stubbed here rather than left to whatever this webServer's
  // real backend answers. Reads the real `targets` query param so this stays
  // correct regardless of how many other comment authors' `useLumenBlock`
  // instances happen to share this page's coalescing window.
  await page.route('**/api/lite/block/state-bulk**', (route) => {
    const url = new URL(route.request().url());
    let pairs: [string, string][] = [];
    try {
      pairs = JSON.parse(url.searchParams.get('targets') ?? '[]');
    } catch {
      pairs = [];
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        states: pairs.map(([target, kind]) => ({ target, kind, available: true, blocking: false }))
      })
    });
  });

  await page.goto(MUTE_COMMENT_POST);
  await expect(page.getByTestId('login-btn')).toBeHidden({
    timeout: TIMEOUTS.HYDRATION
  });

  // Locate steevc's comment — the comment-list-item whose author-name-link
  // button contains the target's username inside the header `<button>`.
  // The button text concatenates name + reputation ("steevc(75)"), so we
  // match on the inner `<span>` that holds just the name to keep the
  // locator immune to reputation drift on re-record.
  const targetComment = page
    .getByTestId('comment-list-item')
    .filter({
      has: page
        .getByTestId('author-name-link')
        .locator('span', { hasText: new RegExp(`^${MUTE_COMMENT_TARGET}$`) })
    })
    .first();
  await expect(targetComment).toBeVisible();

  // Open the popover from the author's name.
  await targetComment.getByTestId('author-name-link').first().click();
  const popover = page.getByTestId('user-popover-card-content');
  await expect(popover).toBeVisible();

  // Block is the one moderation control now — offered inline next to
  // Follow (buttons-container.tsx), not behind a menu, in the popover.
  const blockButton = popover.getByTestId('profile-block-button');
  await expect(blockButton).toBeVisible();
  await expect(blockButton).toHaveText('Block');

  // Mute never mounts here any more, for anybody — buttons-container.tsx
  // no longer imports MuteButton at all.
  await expect(popover.getByTestId('profile-mute-button')).toHaveCount(0);
});
