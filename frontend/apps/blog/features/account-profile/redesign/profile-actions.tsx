'use client';

import { MoreHorizontal, ExternalLink } from 'lucide-react';
import env from '@beam-australia/react-env';
import { Link } from '@hive/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import DialogLogin from '@/blog/components/dialog-login';
import { useFollowMutation, useUnfollowMutation } from '@/blog/features/mute-follow/hooks/use-follow-mutations';
import { useMuteMutation, useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { useFollowingInfiniteQuery } from '@/blog/features/account-lists/hooks/use-following-infinitequery';

/**
 * Follow toggle (ink "Follow" → outline "Following") + overflow "⋯" menu
 * (Mute/Unmute, block explorer). Real follow/mute mutations — the same
 * `useFollow*`/`useMute*` hooks `ButtonsContainer` uses — restyled to the
 * handoff's pill button instead of the shared `<Button>` component, since
 * the design's Follow control has its own exact ink/outline spec.
 *
 * `following` is the VIEWER's own following list, lifted from `ProfileMain`
 * (it also drives the profile owner's own follower-count display there), so
 * this component doesn't duplicate that fetch.
 */
export default function ProfileActions({
  username,
  following
}: {
  username: string;
  following: UseInfiniteQueryResult<IFollow[]>;
}) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const explorerHost = env('EXPLORER_DOMAIN') || '';

  const mute = useFollowingInfiniteQuery(user.username, 1000, 'ignore', ['ignore']);
  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();
  const muteMutation = useMuteMutation();
  const unmuteMutation = useUnmuteMutation();

  if (!user.isLoggedIn) {
    return (
      <DialogLogin>
        <button
          type="button"
          className="rounded-xl bg-[#1a1a17] px-7 py-3 font-sans text-[14.5px] font-semibold text-white"
          data-testid="profile-follow-button"
        >
          {t('user_profile.follow_button')}
        </button>
      </DialogLogin>
    );
  }

  if (user.username === username) return null;

  const isFollow = Boolean(following.data?.pages[0]?.some((f) => f.follower === user.username && f.following === username));
  const isMute = Boolean(mute.data?.pages[0]?.some((f) => f.follower === user.username && f.following === username));
  const busy =
    following.isLoading || followMutation.isPending || unfollowMutation.isPending || mute.isLoading;

  const handleFollowClick = async () => {
    try {
      if (isFollow) await unfollowMutation.mutateAsync({ username });
      else await followMutation.mutateAsync({ username });
    } catch (error) {
      handleError(error, { method: isFollow ? 'unfollow' : 'follow', params: { username } });
    }
  };

  const handleMuteClick = async () => {
    try {
      if (isMute) await unmuteMutation.mutateAsync({ username });
      else await muteMutation.mutateAsync({ username });
    } catch (error) {
      handleError(error, { method: isMute ? 'unmute' : 'mute', params: { username } });
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <button
        type="button"
        onClick={handleFollowClick}
        disabled={busy}
        data-testid="profile-follow-button"
        className={cn(
          'rounded-xl px-7 py-3 font-sans text-[14.5px] font-semibold transition-colors disabled:opacity-60',
          isFollow
            ? 'border border-[#e4e6e9] bg-white text-[#3f4650] hover:bg-[#f6f7f8]'
            : 'bg-[#1a1a17] text-white hover:bg-[#2a2822]'
        )}
      >
        {isFollow ? t('profile.following') : t('user_profile.follow_button')}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('profile.overflow_menu_label')}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#e4e6e9] bg-white text-[#4b5563] hover:bg-[#f6f7f8]"
          >
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={handleMuteClick} disabled={busy} className="cursor-pointer">
            {isMute ? t('user_profile.unmute_button') : t('user_profile.mute_button')}
          </DropdownMenuItem>
          {explorerHost ? (
            <DropdownMenuItem asChild>
              <Link
                href={`${explorerHost}/@${username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex cursor-pointer items-center gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                {t('profile.overflow.view_on_explorer')}
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
