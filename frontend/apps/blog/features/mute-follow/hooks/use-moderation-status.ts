import { useEffect } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';
import { useFollowListQuery } from '@/blog/components/hooks/use-follow-list';
import { useMuteMutation, useUnmuteMutation } from './use-mute-mutations';
import {
  useBlacklistBlogMutation,
  useUnblacklistBlogMutation
} from '@/blog/components/hooks/use-blacklist-mutations';
import { handleError } from '@ui/lib/handle-error';

/**
 * ════ E1/E2 (BUILDMAP-FUCKERY-V2, G3) — "muting does nothing" ════
 *
 * Every surface that offers Mute/Blacklist OUTSIDE the /lists pages (the profile
 * header's "..." menu, the post overflow menu, the comment overflow menu) needs the
 * SAME answer to "is the viewer already muting/blacklisting this account" and the
 * SAME two actions to flip it — one hook so all three agree and invalidate the same
 * caches, instead of three independent re-derivations that can drift.
 *
 * Reuses the exact mutations the /lists pages and the redesigned profile's Mute item
 * already use (`useMuteMutation`/`useUnmuteMutation`,
 * `useBlacklistBlogMutation`/`useUnblacklistBlogMutation`) — this file adds no new
 * transaction logic, only a shared read+toggle shape around them.
 *
 * Both mute and blacklist are Hive chain operations naming a real account on both
 * ends. Neither side may be a Lumen lite handle: a lite VIEWER has no chain signer,
 * and a lite TARGET (published through the shared proxy account) is not itself a
 * Hive account — muting it would silently mute the shared publisher for every lite
 * author. `targetIsLite` mirrors the flag `ProfileActions`/`ButtonsContainer` already
 * use for exactly this reason. When either is true, `available` is false and callers
 * should hide the controls rather than show a broken button (same "hidden, not
 * disabled-and-confusing" rule Mute already followed before this hook existed).
 */
export function useModerationStatus(username: string, targetIsLite = false) {
  const { user } = useUserClient();
  /**
   * ★ SAME SSR RACE AS EVERY OTHER IDENTITY GATE IN THIS APP (2026-08-12, G4).
   * `available` used to read `user.isLoggedIn`/`user.username` straight off raw
   * `useUserClient()`, which cannot answer during SSR and reports signed-out /
   * empty-username until `/api/users/me` returns (`server-session.tsx`'s own
   * header comment; the exact race `comment-list-item.tsx`, `profile-actions.tsx`
   * and `votes-component.tsx` already fixed the same way). For THIS hook the
   * consequence is worse than a flickering button: `available` gates `queryName`
   * below, so a signed-in reader's mute/blacklist reads did not even START until
   * the client round trip landed — every card gated on `isMuted`/`isModerated`
   * during that window rendered as if the viewer had moderated nobody, for
   * exactly the same reason (a query that never fired can never report `isError`,
   * so `muteStatusUnknown` could not save this case). `identity` is seeded from
   * the session cookie the server already read, so `available` is correct from
   * the first render for the isLoggedIn/username half of this check.
   *
   * `user.account_tier` deliberately STAYS on the raw hook — it does not exist on
   * `identity` (only the real client user object carries it, same reasoning
   * `profile-actions.tsx`/`muted-list.tsx` already document), and this hook's
   * account_tier gate is unchanged from before this fix either way.
   */
  const identity = useSessionIdentity();
  const available =
    identity.isLoggedIn && user.account_tier !== 'lite' && !targetIsLite && username !== identity.username;
  const queryName = available ? identity.username : '';

  const muteList = useFollowingInfiniteQuery(queryName, 1000, 'ignore', ['ignore']);
  const blacklist = useFollowListQuery(queryName, 'blacklisted');
  const { hasNextPage: muteHasNextPage, isFetchingNextPage: muteIsFetchingNextPage, fetchNextPage: fetchNextMutePage } =
    muteList;

  // ★ item 4 (adversarial review, confirmed real): Hive's `get_following` caps a
  // single page at 1000 (see `getFollowing` in hive-api.ts), and `isMuted` used to
  // read `pages[0]` only. For a viewer muting more than 1000 accounts, whoever
  // landed past the first 1000 (in whatever order the chain returns them) read as
  // NOT muted here — the mute/unmute menu label would say "Mute" for someone
  // already muted, and re-muting them is a no-op at best. Keep fetching while more
  // pages exist so the full list is eventually loaded (bounded by the viewer's
  // actual ignore-list size, not an arbitrary count); react-query dedupes this
  // across every card sharing the query key, so this does not add a fetch per card.
  useEffect(() => {
    if (available && muteHasNextPage && !muteIsFetchingNextPage) {
      fetchNextMutePage();
    }
  }, [available, muteHasNextPage, muteIsFetchingNextPage, fetchNextMutePage]);

  const muteMutation = useMuteMutation();
  const unmuteMutation = useUnmuteMutation();
  const blacklistMutation = useBlacklistBlogMutation();
  const unblacklistMutation = useUnblacklistBlogMutation();

  // `identity.username`, not `user.username`: `queryName` (above) is what this list
  // was actually fetched FOR, and since the SSR-race fix, that is `identity.username`
  // — matching against the still-possibly-stale raw `user.username` here would mean
  // this comparison could fail to match its own query's rows during the same race
  // window this hook just closed for `available`.
  const isMuted = Boolean(
    muteList.data?.pages.some((page) =>
      page.some((f) => f.follower === identity.username && f.following === username)
    )
  );
  const isBlacklisted = Boolean(blacklist.data?.some((entry) => entry.name === username));

  // ★ THE FAIL-OPEN DEFECT'S CONSUMER-SIDE FIX (2026-08-12). `use-following-
  // infinitequery.tsx` no longer swallows a genuine `condenser_api.get_following`
  // failure into an empty page, so a timed-out/errored fetch now correctly leaves
  // `muteList.data` unset and sets `muteList.isError` — but `isMuted` above still
  // computes to `false` in that state, because "no data yet" and "confirmed not
  // muted" are the same expression (`data?.pages.some(...)` on `undefined`).
  // Silently equating those two is EXACTLY the bug: a reader who has muted someone
  // must not be shown that author's content just because the mute list could not
  // be read this time.
  //
  // `muteStatusUnknown` names the third state explicitly so a consumer can refuse
  // to treat "unknown" as "clear" — see `medium-post-card.tsx`'s render gate,
  // the one place in this codebase where `isMuted` decides whether content is
  // shown (not just a button label). Scoped to `available`: a viewer for whom
  // moderation does not apply at all (signed out, viewing themselves, lite
  // pairing) was never going to hide anything here regardless of this query's
  // outcome, so their render must not be held up by an error that cannot change
  // their answer.
  const muteStatusUnknown = available && muteList.isError;

  // ★ THE SAME DEFECT, ONE LAYER UP (2026-08-12, job 2 — G4). `getFollowList`
  // (`packages/transaction/lib/bridge-api.ts`) and `useFollowListQuery`
  // (`components/hooks/use-follow-list.tsx`) never swallow a `bridge.get_follow_list`
  // failure into a fake empty array — unlike the ORIGINAL mute bug, there is no
  // `.catch(() => [])` anywhere in this fetch's path, and React Query's default
  // retry (3 attempts, backoff) runs and correctly sets `blacklist.isError` on a
  // genuine, exhausted failure. So the FETCH does not fail open.
  //
  // But `isBlacklisted` above is exactly the same expression `isMuted` used to be
  // before its fix: `blacklist.data?.some(...)` on `undefined` — which is what
  // `blacklist.data` is during BOTH "still loading" and "errored, retries
  // exhausted". A caller reading only `isBlacklisted` cannot tell a confirmed-clear
  // account from one whose blacklist read genuinely failed — the same silent
  // "unknown reads as safe" shape, just produced by an unchecked `isError` instead
  // of a swallowed exception. `blacklistStatusUnknown` names that third state the
  // same way `muteStatusUnknown` does, scoped to `available` for the same reason
  // (a viewer for whom moderation does not apply was never going to hide anything
  // here regardless of this query's outcome).
  const blacklistStatusUnknown = available && blacklist.isError;

  // Convenience for a consumer that only needs "can I trust `isModerated`'s `false`
  // right now" and does not care WHICH half is unreadable — `profile-actions.tsx`
  // is the first of these (job 1). Either half being unknown is enough: `isModerated`
  // is an OR of the two, so a false negative on either one taints it.
  const moderationStatusUnknown = muteStatusUnknown || blacklistStatusUnknown;

  const muteBusy = muteMutation.isPending || unmuteMutation.isPending;
  const blacklistBusy = blacklistMutation.isPending || unblacklistMutation.isPending;

  const toggleMute = async () => {
    try {
      if (isMuted) await unmuteMutation.mutateAsync({ username });
      else await muteMutation.mutateAsync({ username });
    } catch (error) {
      handleError(error, { method: isMuted ? 'unmute' : 'mute', params: { username } });
    }
  };

  const toggleBlacklist = async () => {
    try {
      if (isBlacklisted) await unblacklistMutation.mutateAsync({ blog: username });
      else await blacklistMutation.mutateAsync({ otherBlogs: username });
    } catch (error) {
      handleError(error, { method: isBlacklisted ? 'unblacklist' : 'blacklist', params: { username } });
    }
  };

  return {
    /** False when either side cannot hold a chain moderation record — hide, don't disable. */
    available,
    isMuted,
    isBlacklisted,
    isModerated: isMuted || isBlacklisted,
    /**
     * True when the mute list could not be read (after React Query's own retries
     * are exhausted) for a viewer/target pair where the answer actually matters.
     * `isMuted` stays `false` in this state for backward compatibility with
     * existing callers that only read a button label — a caller that GATES
     * rendered content on mute status must also check this flag. See the note
     * at its computation above.
     */
    muteStatusUnknown,
    /**
     * True when the blacklist could not be read (after React Query's own retries
     * are exhausted) for a viewer/target pair where the answer actually matters.
     * `isBlacklisted` stays `false` in this state for the same backward-compat
     * reason `isMuted` does — see the note at its computation above and at
     * `muteStatusUnknown`.
     */
    blacklistStatusUnknown,
    /** Either half of `isModerated` could be wrong right now — see the note above. */
    moderationStatusUnknown,
    muteBusy,
    blacklistBusy,
    toggleMute,
    toggleBlacklist
  };
}
