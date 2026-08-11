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
import { useModerationStatus } from '@/blog/features/mute-follow/hooks/use-moderation-status';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';

/**
 * Follow toggle (ink "Follow" → outline "Following") + overflow "⋯" menu
 * (Mute/Unmute, Blacklist/Unblacklist, block explorer). Real follow/mute/blacklist
 * mutations — the same `useFollow*` hooks `ButtonsContainer` uses, and the same
 * `useModerationStatus` hook the post and comment overflow menus use — restyled to
 * the handoff's pill button instead of the shared `<Button>` component, since the
 * design's Follow control has its own exact ink/outline spec.
 *
 * ★ E1/E2 (BUILDMAP-FUCKERY-V2). Before this pass the menu carried only Mute (real,
 * but with nothing on the page to show it had any effect) and there was no Blacklist
 * control anywhere outside `/@you/lists/blacklisted` — a page that, per the same
 * audit pass, usually fails to render its own add-form. When the viewer has moderated
 * this account, the primary CTA slot shows a badge instead of a plain "Follow" (the
 * old CTA read as an ordinary un-followed stranger even for an account already
 * muted+blacklisted); Follow/Unfollow moves into the menu so the action is not lost.
 *
 * `following` is the VIEWER's own following list, lifted from `ProfileMain`
 * (it also drives the profile owner's own follower-count display there), so
 * this component doesn't duplicate that fetch.
 */
export default function ProfileActions({
  username,
  following,
  liteTarget = false
}: {
  username: string;
  following: UseInfiniteQueryResult<IFollow[]>;
  /** This profile is a Lumen lite account — no Hive account exists to follow. */
  liteTarget?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const explorerHost = env('EXPLORER_DOMAIN') || '';

  const moderation = useModerationStatus(username, liteTarget);
  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();
  // Lumen's own follow graph: used when either side is keyless. Called before the
  // early returns below, because hooks cannot be conditional.
  const lumen = useLumenFollow(
    username,
    user.isLoggedIn && username !== user.username && (user.account_tier === 'lite' || liteTarget)
  );
  // ★ BLOCK, FOR BOTH TIERS. Unlike Mute below — which is a chain operation and so is
  // hidden whenever either side is keyless — a block is always Lumen's own record and
  // is therefore always offered. It is also the stronger of the two: it hides this
  // person from the viewer's feeds AND stops their replies under the viewer's posts
  // being served to anyone. Called before the early returns; hooks cannot be
  // conditional.
  const block = useLumenBlock(
    username,
    liteTarget ? 'lumen' : 'hive',
    user.isLoggedIn && username !== user.username
  );

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

  const isFollow = lumen.applies
    ? lumen.isFollowing
    : Boolean(
        following.data?.pages[0]?.some((f) => f.follower === user.username && f.following === username)
      );
  // On the Lumen path the viewer's chain follow list is irrelevant and may never
  // load at all (a lite viewer has no Hive account), so it must not gate the button.
  const busy = lumen.applies || lumen.pending
    ? lumen.busy || lumen.pending
    : following.isLoading || followMutation.isPending || unfollowMutation.isPending;

  const handleFollowClick = async () => {
    try {
      // Either side keyless: the follow cannot be a chain operation. A lite viewer has
      // no key to sign one, and a lite profile has no account to be followed.
      if (lumen.applies) {
        // Returned, not read from the closure — see buttons-container.tsx.
        const failure = await lumen.toggle();
        if (failure) throw new Error(failure);
        return;
      }
      if (isFollow) await unfollowMutation.mutateAsync({ username });
      else await followMutation.mutateAsync({ username });
    } catch (error) {
      handleError(error, { method: isFollow ? 'unfollow' : 'follow', params: { username } });
    }
  };

  const handleBlockClick = async () => {
    const failure = await block.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: block.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username }
      });
    }
  };

  // Moderated-state badge text (E2): both, then blacklist alone, then mute alone —
  // blacklist leads because it is the stronger/more deliberate signal of the two.
  const moderatedBadgeKey =
    moderation.isBlacklisted && moderation.isMuted
      ? 'user_profile.moderated_badge_both'
      : moderation.isBlacklisted
        ? 'user_profile.moderated_badge_blacklisted'
        : 'user_profile.moderated_badge_muted';

  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {/* ★ E2: A MODERATED ACCOUNT DOES NOT GET A PLAIN "Follow" CTA. Before this,
          @bpcvoter2 — on both lordbutterfly's mute list AND his blacklist — rendered
          the exact same solid-black "Follow" button as any un-followed stranger:
          nothing in the primary CTA slot said "you have already moderated this
          account." Follow/Unfollow itself is not lost — it moves into the "⋯" menu
          below — this slot's job becomes telling the truth about moderation state. */}
      {moderation.isModerated ? (
        <span
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 font-sans text-[13.5px] font-semibold text-destructive"
          data-testid="profile-moderated-badge"
        >
          {t(moderatedBadgeKey)}
        </span>
      ) : (
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
      )}

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
          {/* The badge above took over the primary CTA slot, so Follow/Unfollow has to
              stay reachable from somewhere — here. */}
          {moderation.isModerated ? (
            <DropdownMenuItem
              onClick={handleFollowClick}
              disabled={busy}
              className="cursor-pointer"
              data-testid="profile-follow-menu-item"
            >
              {isFollow ? t('user_profile.unfollow_button') : t('user_profile.follow_button')}
            </DropdownMenuItem>
          ) : null}
          {/* Block is Lumen's own and works for every combination of the two tiers, so
              unlike Mute it is never hidden. It is also the item a reader actually
              wants from this menu: it removes this person from their feeds AND stops
              that person's replies under their posts reaching any other reader. */}
          {block.available ? (
            <DropdownMenuItem
              onClick={handleBlockClick}
              disabled={block.busy}
              className="cursor-pointer text-destructive focus:text-destructive"
              data-testid="profile-block-menu-item"
            >
              {block.isBlocking ? t('user_profile.unblock_button') : t('user_profile.block_button')}
            </DropdownMenuItem>
          ) : null}
          {/* Mute and Blacklist are both chain operations, so both are hidden whenever
              either side is a lite account: a keyless viewer cannot sign one, and a
              lite profile is not an account that can be muted or blacklisted. Better
              absent than broken. */}
          {moderation.available ? (
            <>
              <DropdownMenuItem
                onClick={moderation.toggleMute}
                disabled={moderation.muteBusy}
                className="cursor-pointer"
                data-testid="profile-mute-menu-item"
              >
                {moderation.isMuted ? t('user_profile.unmute_button') : t('user_profile.mute_button')}
              </DropdownMenuItem>
              {/* ★ E2 — THE ITEM THAT DID NOT EXIST. Previously the only way to
                  blacklist anyone was to navigate to `/@you/lists/blacklisted` and
                  hand-type the username into a page that usually failed to render its
                  add-form at all (see G2). Same mutation the /lists page's
                  unblacklist buttons already use — `useBlacklistBlogMutation` /
                  `useUnblacklistBlogMutation` — via `useModerationStatus`. */}
              <DropdownMenuItem
                onClick={moderation.toggleBlacklist}
                disabled={moderation.blacklistBusy}
                className="cursor-pointer text-destructive focus:text-destructive"
                data-testid="profile-blacklist-menu-item"
              >
                {moderation.isBlacklisted
                  ? t('user_profile.unblacklist_button')
                  : t('user_profile.blacklist_button')}
              </DropdownMenuItem>
            </>
          ) : null}
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
