'use client';

import { IFollow } from '@hive/common-hiveio-packages/wax';
import FollowButton from './follow-button';
import MuteButton from './mute-button';
import { User } from '@smart-signer/types/common';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { useMuteMutation, useUnmuteMutation } from './hooks/use-mute-mutations';
import { useFollowMutation, useUnfollowMutation } from './hooks/use-follow-mutations';
import { Button } from '@hive/ui';
import DialogLogin from '@/blog/components/dialog-login';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';

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

  const isMute = Boolean(
    mute.data?.pages[0].some((f) => f.follower === user.username && f.following === username)
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

  const isFollow = lumen.applies
    ? lumen.isFollowing
    : Boolean(
        follow.data?.pages[0].some(
          (f: { follower: string; following: string }) =>
            f.follower === user.username && f.following === username
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
