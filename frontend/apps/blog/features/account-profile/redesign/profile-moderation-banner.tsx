'use client';

import { Link } from '@hive/ui';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { useModerationStatus } from '@/blog/features/mute-follow/hooks/use-moderation-status';

/**
 * ════ E1 (BUILDMAP-FUCKERY-V2, G3) — "muting a user currently does nothing" ════
 *
 * The headline defect: @bpcvoter2 is confirmed (via `bridge.get_follow_list
 * {observer:"lordbutterfly", follow_type:"blacklisted"}` -> `[bpcvoter2, daylaykay]`)
 * on BOTH lordbutterfly's mute list and his blacklist, and `/@bpcvoter2` rendered
 * completely unmodified — cover, avatar, bio, follower counts, every post — with
 * nothing anywhere on the page indicating the viewer had moderated this account.
 *
 * This banner is that missing indication, plus the E5-style "route back to the
 * relevant list" — the same affordance the comment-thread reveal control gets for
 * the same reason: a moderation state without a way back to the list that caused it
 * is a dead end, not a control.
 *
 * Self-contained: fetches its own moderation status via the same hook the profile
 * menu and the post/comment overflow menus use, so it agrees with them by
 * construction rather than by convention. Renders nothing when the viewer has not
 * moderated this account — the common case — so it costs nothing extra when idle.
 */
export default function ProfileModerationBanner({
  username,
  liteTarget = false
}: {
  username: string;
  liteTarget?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const moderation = useModerationStatus(username, liteTarget);

  if (!moderation.isModerated) return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-destructive/25 bg-destructive/5 px-5 py-3.5 font-sans text-[13.5px] text-destructive"
      data-testid="profile-moderation-banner"
    >
      <span>
        {moderation.isMuted && moderation.isBlacklisted
          ? t('user_profile.moderation_banner_both', { username })
          : moderation.isMuted
            ? t('user_profile.moderation_banner_muted', { username })
            : t('user_profile.moderation_banner_blacklisted', { username })}
      </span>
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {moderation.isMuted ? (
          <>
            <button
              type="button"
              onClick={moderation.toggleMute}
              disabled={moderation.muteBusy}
              className="font-semibold underline-offset-2 hover:underline disabled:opacity-60"
              data-testid="profile-moderation-banner-unmute"
            >
              {t('user_profile.unmute_button')}
            </button>
            <Link
              href={`/@${user.username}/lists/muted`}
              className="underline-offset-2 hover:underline"
              data-testid="profile-moderation-banner-muted-list-link"
            >
              {t('user_profile.moderation_banner_view_list')}
            </Link>
          </>
        ) : null}
        {moderation.isBlacklisted ? (
          <>
            <button
              type="button"
              onClick={moderation.toggleBlacklist}
              disabled={moderation.blacklistBusy}
              className="font-semibold underline-offset-2 hover:underline disabled:opacity-60"
              data-testid="profile-moderation-banner-unblacklist"
            >
              {t('user_profile.unblacklist_button')}
            </button>
            <Link
              href={`/@${user.username}/lists/blacklisted`}
              className="underline-offset-2 hover:underline"
              data-testid="profile-moderation-banner-blacklisted-list-link"
            >
              {t('user_profile.moderation_banner_view_list')}
            </Link>
          </>
        ) : null}
      </span>
    </div>
  );
}
