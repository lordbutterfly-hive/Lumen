'use client';

import { useEffect } from 'react';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import FollowButton from './follow-button';
import MuteButton from './mute-button';
import BlockButton from './block-button';
import { User } from '@smart-signer/types/common';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMuteMutation, useUnmuteMutation } from './hooks/use-mute-mutations';
import { useFollowMutation, useUnfollowMutation } from './hooks/use-follow-mutations';
import { Button } from '@hive/ui';
import DialogLogin from '@/blog/components/dialog-login';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';

const ButtonsContainer = ({
  username,
  user,
  variant,
  follow,
  mute,
  hideMute = false,
  liteTarget = false
}: {
  username: string;
  /**
   * The person being followed is a Lumen lite account. They have no Hive account, so
   * a chain follow of them is impossible — the relationship is kept on Lumen instead,
   * for full Hive viewers as well as lite ones.
   */
  liteTarget?: boolean;
  /**
   * Drop the Mute button. Set for a Lumen lite author: muting is a chain operation
   * and a lite handle is not a Hive account, so the button could only ever record a
   * mute against a name that does not exist. Following still works, because Lumen
   * keeps its own follow graph (`liteFollow`).
   */
  hideMute?: boolean;
  user: User;
  variant:
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | 'outlineRed'
    | 'link'
    | 'redHover'
    | 'basic'
    | null
    | undefined;
  follow: UseInfiniteQueryResult<IFollow[], unknown>;
  mute: UseInfiniteQueryResult<IFollow[], unknown>;
}) => {
  const { t } = useTranslation('common_blog');

  const muteMutation = useMuteMutation();
  const unmuteMutation = useUnmuteMutation();
  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();

  // Same class as use-moderation-status.ts: `get_following` caps a single page at
  // 1000 entries, and `mute`/`follow` here are the VIEWER's own ignore/blog lists
  // (every caller constructs them with `useFollowingInfiniteQuery(user.username, 1000, ...)`).
  // For a viewer following/muting more than 1000 accounts, whoever landed past the
  // first page used to read as not-followed/not-muted below (`isMute`, `isFollow`) —
  // offering "Follow" to someone already followed, or "Mute" to someone already
  // muted. Keep fetching while more pages exist; react-query dedupes this per query
  // key across every card sharing it, so this does not add a fetch per card.
  const {
    hasNextPage: muteHasNextPage,
    isFetchingNextPage: muteIsFetchingNextPage,
    fetchNextPage: fetchNextMutePage
  } = mute;
  const {
    hasNextPage: followHasNextPage,
    isFetchingNextPage: followIsFetchingNextPage,
    fetchNextPage: fetchNextFollowPage
  } = follow;

  // ★ `cancelRefetch: false` IS LOAD-BEARING, NOT A STYLE CHOICE (2026-08-11).
  // `follow`/`mute` are the SAME useInfiniteQuery result, passed down as props
  // to every ButtonsContainer on the page (followers/content.tsx and
  // followed/content.tsx both render one per row). React flushes every mounted
  // instance's effects before any of their state updates lands, so all of them
  // observe `hasNextPage && !isFetchingNextPage` at once and all call
  // `fetchNextPage()` in the same tick. React Query v4's `fetchNextPage`
  // defaults `cancelRefetch` to `true`, which does not merge those calls — the
  // 2nd..Nth cancel the 1st's promise and start a fresh one each. Measured on a
  // 20-row followers page with the viewer's own list forced past 1000 entries
  // (has-next-page): 20 distinct outbound `get_following` requests per page
  // turn, not 1. Worse, `getFollowing` (packages/transaction/lib/hive-api.ts)
  // never wires the query's abort signal into the chain call, so a "cancelled"
  // fetch keeps running upstream anyway — cancelling client-side state buys
  // nothing and the wasted request still lands on the Hive node.
  // `cancelRefetch: false` makes every re-entrant call while a fetch is already
  // in flight return that SAME promise instead of restarting
  // (query-core's `Query.fetch`: `else if (this.promise) return this.promise`).
  // Verified this collapses the 20-per-turn storm to exactly 1 real request.
  useEffect(() => {
    if (muteHasNextPage && !muteIsFetchingNextPage) {
      fetchNextMutePage({ cancelRefetch: false });
    }
  }, [muteHasNextPage, muteIsFetchingNextPage, fetchNextMutePage]);

  useEffect(() => {
    if (followHasNextPage && !followIsFetchingNextPage) {
      fetchNextFollowPage({ cancelRefetch: false });
    }
  }, [followHasNextPage, followIsFetchingNextPage, fetchNextFollowPage]);

  const isMute = Boolean(
    mute.data?.pages.some((page) =>
      page.some((f) => f.follower === user.username && f.following === username)
    )
  );
  const temporaryDisabled =
    mute.data?.pages[0].some(
      (f) => f._temporary && f.follower === user.username && f.following === username
    ) ||
    follow.data?.pages[0].some(
      (f) => f._temporary && f.follower === user.username && f.following === username
    );

  // Lumen's own follow graph, for any pair the chain cannot hold (see useLumenFollow).
  // The query only runs when one side is keyless, so an ordinary Hive-to-Hive button
  // is unchanged and costs nothing.
  const lumen = useLumenFollow(username, user.isLoggedIn && (user.account_tier === 'lite' || liteTarget));

  // ★ BLOCK IS OFFERED TO EVERYONE, ON EVERY BYLINE — the one control here with no
  // tier condition. Mute is chain-only, so it is hidden from a lite viewer and from a
  // lite target; following splits between the chain and Lumen depending on the pair.
  // A block is always Lumen's, always available, and always means the same thing:
  // this person disappears from my feeds, and their replies under my posts stop being
  // served to anybody.
  //
  // `targetKind` says which name-space `username` is from. `liteTarget` is exactly
  // that distinction, and it matters here more than anywhere else: a Lumen handle and
  // a Hive account can share a spelling, and blocking the wrong one would erase an
  // innocent person's comments from other readers' screens.
  const block = useLumenBlock(
    username,
    liteTarget ? 'lumen' : 'hive',
    user.isLoggedIn && username !== user.username
  );

  const handlerBlock = async () => {
    const failure = await block.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: block.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username }
      });
    }
  };

  const isFollow = lumen.applies
    ? lumen.isFollowing
    : Boolean(
        follow.data?.pages.some((page) =>
          page.some(
            (f: { follower: string; following: string }) =>
              f.follower === user.username && f.following === username
          )
        )
      );
  // `hideMute` above covers a lite TARGET (you cannot mute a handle that is not a
  // Hive account). This covers a lite VIEWER, which was missed: a keyless account
  // has no Hive signer, and mute is chain-only — there is no /api/lite/mute and
  // deliberately so. Unguarded, the button rendered on every real Hive profile and
  // every author popover, and clicking it dropped into `transactionService` with no
  // signer configured, surfacing a raw error. Follow is safe because Lumen keeps
  // its own follow graph; mute has no such fallback, so the control is removed
  // rather than shown and refused.
  const viewerIsLite = user.account_tier === 'lite';

  const handlerMute = async () => {
    // Belt-and-braces: the button is not rendered for a lite viewer, but a stale
    // render or a future call site must not reach a signer that cannot exist.
    if (viewerIsLite) {
      handleError(new Error('Muting needs a Hive account. Upgrade your account to mute people.'), {
        method: 'mute',
        params: { username }
      });
      return;
    }
    if (!isMute) {
      try {
        await muteMutation.mutateAsync({ username });
      } catch (error) {
        handleError(error, { method: 'mute', params: { username } });
      }
    } else {
      try {
        await unmuteMutation.mutateAsync({ username });
      } catch (error) {
        handleError(error, { method: 'unmute', params: { username } });
      }
    }
  };
  const handlerFollow = async () => {
    // Either side keyless: the follow is Lumen-local (no on-chain custom_json),
    // recorded via /api/lite/follow.
    if (lumen.applies) {
      // The result is RETURNED, not read from `lumen.error`: that field is captured in
      // this closure at render time, so a failure recorded during the click would be
      // invisible here — every rate limit and suspension refusal was silent.
      const failure = await lumen.toggle();
      if (failure) handleError(new Error(failure), { method: 'lite-follow', params: { username } });
      return;
    }
    if (!isFollow) {
      try {
        await followMutation.mutateAsync({ username });
      } catch (error) {
        handleError(error, { method: 'follow', params: { username } });
      }
    } else {
      try {
        await unfollowMutation.mutateAsync({ username });
      } catch (error) {
        handleError(error, { method: 'unfollow', params: { username } });
      }
    }
  };

  // On the Lumen path the chain queries are irrelevant — they read the viewer's Hive
  // follow lists, which a keyless viewer does not have — so they must not be allowed
  // to hold the button in a loading state it can never leave.
  // `lumen.pending` matters: until the state query answers, `applies` is false and the
  // click would take the CHAIN path — which for a keyless viewer means a signer that
  // does not exist. Disabled until we know which path this button is.
  const loading = lumen.applies || lumen.pending
    ? lumen.busy || lumen.pending
    : mute.isLoading ||
      mute.isFetching ||
      muteMutation.isPending ||
      unmuteMutation.isPending ||
      follow.isLoading ||
      follow.isFetching ||
      followMutation.isPending ||
      unfollowMutation.isPending;
  return (
    <>
      {user.isLoggedIn ? (
        <>
          <FollowButton
            loading={loading}
            variant={variant}
            isFollow={isFollow}
            onClick={handlerFollow}
            disabled={temporaryDisabled}
          />
          {hideMute || viewerIsLite ? null : (
            <MuteButton
              loading={loading}
              variant={variant}
              isMute={isMute}
              onClick={handlerMute}
              disabled={temporaryDisabled}
            />
          )}
          {block.available ? (
            <BlockButton
              loading={block.busy}
              variant={variant}
              isBlocking={block.isBlocking}
              onClick={handlerBlock}
            />
          ) : null}
        </>
      ) : (
        <DialogLogin>
          <Button
            className=" hover:text-destructive "
            variant={variant}
            size="sm"
            data-testid="profile-follow-button"
          >
            {t('user_profile.follow_button')}
          </Button>
        </DialogLogin>
      )}
    </>
  );
};

export default ButtonsContainer;
