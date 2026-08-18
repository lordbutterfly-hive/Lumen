'use client';

import { Icons } from '@ui/components/icons';
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
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
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
  /**
   * ★★★ SAME RACE AS EVERY OTHER OWNERSHIP GATE (2026-08-12, F5). This was raw
   * `useUserClient()` for the two checks below that decide WHICH UI renders — "are
   * you logged in at all" and "is this your own profile" — which cannot answer
   * during SSR and reports "signed out" until `/api/users/me` returns. A signed-in
   * reader hard-loading their own profile briefly saw a "Follow" button offering to
   * follow themselves (the login-gate hadn't yet flipped, so neither had the
   * own-profile check), and any signed-in reader saw the DialogLogin-wrapped button
   * instead of the real follow control. `identity` (server-session.tsx) is seeded
   * from the session cookie the server already read, so both checks are correct on
   * the first render. `user.account_tier` stays on the raw hook below — it does not
   * exist on `identity` by design (only the real client object has it), same as
   * `list-variant.tsx` / `muted-list.tsx`.
   */
  const identity = useSessionIdentity();
  const explorerHost = env('EXPLORER_DOMAIN') || '';

  const moderation = useModerationStatus(username, liteTarget);
  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();
  // Lumen's own follow graph: used when either side is keyless. Called before the
  // early returns below, because hooks cannot be conditional.
  const lumen = useLumenFollow(
    username,
    identity.isLoggedIn && username !== identity.username && (user.account_tier === 'lite' || liteTarget)
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
    identity.isLoggedIn && username !== identity.username
  );

  if (!identity.isLoggedIn) {
    return (
      <DialogLogin>
        <button
          type="button"
          className="rounded-xl bg-surface-42 px-7 py-3 font-sans text-[15px] leading-[24px] font-semibold text-ink-27"
          data-testid="profile-follow-button"
        >
          {t('user_profile.follow_button')}
        </button>
      </DialogLogin>
    );
  }

  // ★ DEFECT FIX (2026-08-17): this used to return null for your own profile —
  // there was no way to reach the editor from the page that most needs it.
  // Links to the same `/@you/settings` page the account menu's Settings row
  // and `left-rail.tsx`'s settingsHref already use, rather than building a
  // second editor. The hooks above (moderation/lumen/block) are still called
  // unconditionally before this branch — they no-op for `username === identity
  // .username` by their own internal checks — so this early return stays safe.
  if (identity.username === username) {
    return (
      <div className="flex shrink-0 items-center gap-2.5">
        <Link
          href={`/@${username}/settings`}
          className="flex items-center gap-1.5 rounded-xl border border-line-11 bg-surface-1 px-7 py-3 font-sans text-[15px] leading-[24px] font-semibold text-ink-7 transition-colors hover:bg-surface-16"
          data-testid="profile-edit-button"
        >
          <Icons.pencil className="h-4 w-4" />
          {t('user_profile.edit_profile_button')}
        </Link>
      </div>
    );
  }

  const isFollow = lumen.applies
    ? lumen.isFollowing
    : Boolean(
        following.data?.pages[0]?.some((f) => f.follower === identity.username && f.following === username)
      );
  // On the Lumen path the viewer's chain follow list is irrelevant and may never
  // load at all (a lite viewer has no Hive account), so it must not gate the button.
  const busy = lumen.applies || lumen.pending
    ? lumen.busy || lumen.pending
    : following.isLoading || followMutation.isPending || unfollowMutation.isPending;

  const handleFollowClick = async () => {
    try {
      // ★ REFUSE RATHER THAN GUESS (2026-08-12). `lumen.applies` is false both when
      // this pair genuinely has no Lumen edge AND when the state read failed, and
      // the branch below treats false as "so it must be a chain follow". For a
      // keyless viewer that means reaching for a signer that does not exist; for a
      // lite target it means broadcasting a chain `custom_json` follow against a
      // name that is not a Hive account at all.
      //
      // `unknown` is scoped to exactly the pairs where a Lumen edge was POSSIBLE —
      // the query never runs, so never errors, otherwise — so refusing here can
      // never block an ordinary Hive-to-Hive follow. Same check
      // `buttons-container.tsx` now makes; this file has the same routing and was
      // missed when that one was fixed.
      if (lumen.unknown) return;
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

  // ★ ADOPTING `muteStatusUnknown`/`blacklistStatusUnknown` (2026-08-12, job 1 — G4).
  // `moderation.isModerated` is `isMuted || isBlacklisted`, and both halves stay
  // `false` on a read failure for backward compatibility (see `use-moderation-
  // status.ts`) — so without this check, a mute or blacklist read that genuinely
  // failed for THIS pair rendered the exact same plain black "Follow" CTA as a
  // truly clean account, on the one surface whose entire job is telling a viewer
  // "you already moderated this account" (see the E2 comment on the badge below).
  // That is the same "unknown reads as safe" shape `medium-post-card.tsx`'s
  // `muteStatusUnknown` gate already exists to prevent for feed content — this is
  // the same fix applied to the primary CTA slot instead of a card's visibility.
  // Only relevant when NOT already known-moderated: if `isModerated` is already
  // true, the badge below is already telling the truth regardless of what the
  // OTHER, still-uncertain half would have said.
  const moderationStatusUncertain = !moderation.isModerated && moderation.moderationStatusUnknown;

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
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 font-sans text-[14px] leading-[22px] font-semibold text-destructive"
          data-testid="profile-moderated-badge"
        >
          {t(moderatedBadgeKey)}
        </span>
      ) : moderationStatusUncertain ? (
        // ★ NEITHER "Follow" NOR the moderated badge — see `moderationStatusUncertain`'s
        // doc above. Neutral, not destructive: this is not a claim that the account IS
        // moderated (`use-moderation-status.ts` keeps the backward-compat `false` for a
        // reason — this pair may genuinely be clean), only that the primary CTA cannot
        // honestly say which right now.
        <span
          className="rounded-xl border border-line-11 bg-surface-14 px-4 py-3 font-sans text-[14px] leading-[22px] font-semibold text-ink-10"
          data-testid="profile-moderation-unknown-badge"
        >
          {t('user_profile.moderation_status_unknown_badge')}
        </span>
      ) : (
        <button
          type="button"
          onClick={handleFollowClick}
          // Disabled on `unknown` too, not just refused on click: a button that
          // looks live and does nothing is its own bad state. Same treatment
          // `follow-button.tsx` now gives it.
          disabled={busy || lumen.unknown}
          data-testid="profile-follow-button"
          className={cn(
            'rounded-xl px-7 py-3 font-sans text-[15px] leading-[24px] font-semibold transition-colors disabled:opacity-60',
            isFollow
              ? 'border border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16'
              : 'bg-surface-42 text-ink-27 hover:bg-surface-41'
          )}
        >
          {lumen.unknown
            ? t('user_profile.follow_status_unknown')
            : isFollow
              ? t('profile.following')
              : t('user_profile.follow_button')}
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('profile.overflow_menu_label')}
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-line-11 bg-surface-1 text-ink-8 hover:bg-surface-16"
          >
            <Icons.moreHorizontal className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* The badge above took over the primary CTA slot, so Follow/Unfollow has to
              stay reachable from somewhere — here. Same condition as the badge itself
              (moderated OR uncertain), so this item is never missing while a badge, not
              the Follow button, occupies the primary slot. */}
          {moderation.isModerated || moderationStatusUncertain ? (
            <DropdownMenuItem
              onClick={handleFollowClick}
              disabled={busy || lumen.unknown}
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
          ) : block.unknown ? (
            // The state read failed rather than "this pair cannot be blocked" — see
            // `unknown`'s doc on `use-lumen-block.ts`. A disabled item that says so is
            // right; letting Block vanish here would read as "this person can't be
            // blocked", which is never true.
            <DropdownMenuItem
              disabled
              className="cursor-not-allowed"
              data-testid="profile-block-menu-item-unknown"
              title={t('user_profile.block_status_unknown_hint')}
            >
              {t('user_profile.block_status_unknown')}
            </DropdownMenuItem>
          ) : null}
          {/* ★ ONE CONTROL, CALLED BLOCK (owner ruling, 2026-08-12).
              "on Lumen mute and personal blacklist should be the same damn thing …
              btw it should be called block. just call it block."

              Mute and Blacklist used to sit here as two further items, so this menu
              offered three overlapping ways to moderate one person, each with a
              different reach and a different way to undo it. Both are now gone from
              every overflow menu (this one, the post card, the comment card, and the
              Follow/Block row) in favour of Block alone.

              Block is also the only one of the three that could carry the owner's
              actual requirement. Mute and Blacklist are per-viewer chain preferences:
              they hide someone from YOU and do nothing about that person spamming
              your posts for everyone else, which is the reason the ruling was made.
              Block hides them from you AND stops their replies under your content
              reaching any other reader (block-service.ts, effects A and B). It also
              works for both account tiers, where the chain operations need a key the
              lite half of the userbase does not have.

              Existing on-chain mute/blacklist entries are still honoured on read and
              are still removable from Settings, so nothing a user set before this is
              stranded. */}
          {explorerHost ? (
            <DropdownMenuItem asChild>
              <Link
                href={`${explorerHost}/@${username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex cursor-pointer items-center gap-2"
              >
                <Icons.externalLink className="h-4 w-4" />
                {t('profile.overflow.view_on_explorer')}
              </Link>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
