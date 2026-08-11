import { useEffect } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
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
  const available =
    user.isLoggedIn && user.account_tier !== 'lite' && !targetIsLite && username !== user.username;
  const queryName = available ? user.username : '';

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

  const isMuted = Boolean(
    muteList.data?.pages.some((page) =>
      page.some((f) => f.follower === user.username && f.following === username)
    )
  );
  const isBlacklisted = Boolean(blacklist.data?.some((entry) => entry.name === username));

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
    muteBusy,
    blacklistBusy,
    toggleMute,
    toggleBlacklist
  };
}
