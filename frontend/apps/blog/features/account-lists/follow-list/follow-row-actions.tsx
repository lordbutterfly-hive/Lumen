'use client';

import { useEffect, useState } from 'react';
import { Icons } from '@ui/components/icons';
import { CircleSpinner } from 'react-spinners-kit';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import type { IFollow } from '@hive/common-hiveio-packages/wax';
import { User } from '@smart-signer/types/common';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@ui/components/alert-dialog';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useFollowMutation, useUnfollowMutation } from '@/blog/features/mute-follow/hooks/use-follow-mutations';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';
import { FOLLOW_BUTTON_OUTLINE, FOLLOW_BUTTON_PRIMARY, OVERFLOW_BUTTON } from './tokens';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * ★★★ THE P0 OF THE REDESIGN: `Block` STOPS BEING A SIBLING OF `Follow`.
 *
 * On both list pages every row rendered `<ButtonsContainer variant="basic">`,
 * which puts `Follow` and `Block` next to each other as two transparent
 * 14px/w500 text buttons, 36px tall, 12px apart, on a 36px row — identical
 * affordance for the benign action and for the one that removes a person from
 * your feeds and deletes their replies under your posts for every other reader.
 * In a dense list the reader is moving fast and the two are one bad pixel apart.
 *
 * Here `Follow` is the only control with weight. `Block` lives behind the `...`
 * menu and, when it would START a block, behind an `<AlertDialog>` as well —
 * the same confirmation primitive `post-delete-dialog.tsx` and
 * `reset-all-lists-dialog.tsx` already use for destructive actions, not a new
 * one. UNBLOCK is not gated: undoing a block is not destructive, and making the
 * reversal harder than the action is its own defect.
 *
 * ★ WHY THIS IS NOT A PROP ON `ButtonsContainer`. That component is also mounted
 * by the post header (`[permlink]/content.tsx`) and the author hover card
 * (`popover-card-data.tsx`), which this redesign explicitly does not own. The
 * follow/block DECISION LOGIC below is ported from it deliberately unchanged —
 * including the `cancelRefetch: false` page-turn fix and both `lumen.unknown`
 * refusals, each of which closes a measured bug documented in that file — so the
 * two stay behaviourally identical while only this surface's chrome differs.
 */
export default function FollowRowActions({
  username,
  user,
  follow,
  mute,
  liteTarget = false
}: {
  username: string;
  user: User;
  /** The VIEWER's own following list (shared across every row on the page). */
  follow: UseInfiniteQueryResult<IFollow[], unknown>;
  /** The VIEWER's own ignore list — only reads the optimistic `_temporary` flag. */
  mute: UseInfiniteQueryResult<IFollow[], unknown>;
  liteTarget?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();

  const {
    hasNextPage: followHasNextPage,
    isFetchingNextPage: followIsFetchingNextPage,
    fetchNextPage: fetchNextFollowPage
  } = follow;

  // ★ `cancelRefetch: false` IS LOAD-BEARING — ported verbatim from
  // `buttons-container.tsx`, where it is measured: every row on the page shares
  // this one query result, every mounted row's effect runs in the same tick, and
  // React Query v4 defaults `cancelRefetch` to `true`, which restarts the fetch
  // per caller instead of merging them (20 outbound `get_following` requests per
  // page turn, not 1). Do not "simplify" this.
  useEffect(() => {
    if (followHasNextPage && !followIsFetchingNextPage) {
      fetchNextFollowPage({ cancelRefetch: false });
    }
  }, [followHasNextPage, followIsFetchingNextPage, fetchNextFollowPage]);

  const lumen = useLumenFollow(username, identity.isLoggedIn && (user.account_tier === 'lite' || liteTarget));
  const block = useLumenBlock(
    username,
    liteTarget ? 'lumen' : 'hive',
    identity.isLoggedIn && username !== identity.username
  );

  const temporaryDisabled =
    mute.data?.pages[0]?.some((f) => f._temporary && f.follower === user.username && f.following === username) ||
    follow.data?.pages[0]?.some((f) => f._temporary && f.follower === user.username && f.following === username);

  const isFollow = lumen.applies
    ? lumen.isFollowing
    : Boolean(
        follow.data?.pages.some((page) =>
          page.some((f) => f.follower === user.username && f.following === username)
        )
      );

  const handleFollow = async () => {
    if (lumen.applies) {
      // The result is RETURNED, not read off `lumen.error` — that field is
      // captured in this closure at render time, so a failure recorded during
      // the click would be invisible. See buttons-container.tsx.
      const failure = await lumen.toggle();
      if (failure) handleError(new Error(failure), { method: 'lite-follow', params: { username } });
      return;
    }
    // `lumen.applies` is ALSO false while the state read is merely failing, and
    // falling through would broadcast a chain `custom_json` for a pair the chain
    // cannot hold. Refuse rather than guess.
    if (lumen.unknown) {
      handleError(new Error(t('user_profile.follow_status_unknown_hint')), {
        method: 'lite-follow',
        params: { username }
      });
      return;
    }
    try {
      if (!isFollow) await followMutation.mutateAsync({ username });
      else await unfollowMutation.mutateAsync({ username });
    } catch (error) {
      handleError(error, { method: isFollow ? 'unfollow' : 'follow', params: { username } });
    }
  };

  const commitBlock = async () => {
    const failure = await block.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: block.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username }
      });
    }
  };

  const copyProfileLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${basePath}/@${username}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      handleError(error, { method: 'copy-profile-link', params: { username } });
    }
  };

  const onLumenPath = lumen.applies || lumen.pending || lumen.unknown;
  const followBusy = onLumenPath
    ? lumen.busy || lumen.pending
    : follow.isLoading || follow.isFetching || followMutation.isPending || unfollowMutation.isPending;

  return (
    <>
      <button
        type="button"
        onClick={handleFollow}
        disabled={followBusy || Boolean(temporaryDisabled) || lumen.unknown}
        data-testid="profile-follow-button"
        className={isFollow ? FOLLOW_BUTTON_OUTLINE : FOLLOW_BUTTON_PRIMARY}
        title={lumen.unknown ? t('user_profile.follow_status_unknown_hint') : undefined}
      >
        {followBusy ? (
          <span className="flex h-5 w-12 items-center justify-center">
            {/* ★ NOT A LITERAL: the outline button this spinner sits on reads
                `hover:text-ink-brand-6` above, and the solid button beside it
                is `bg-surface-brand-12` — `rgb(var(--ink-brand-6))` keeps the
                spinner in that same red family instead of the stale
                `#c0392b`, and it is not a "danger" spinner (Follow, not
                Block), so it takes the brand token, not `destructive`. */}
            <CircleSpinner loading size={16} color={isFollow ? 'rgb(var(--ink-brand-6))' : '#ffffff'} />
          </span>
        ) : lumen.unknown ? (
          t('user_profile.follow_status_unknown')
        ) : isFollow ? (
          <>
            {/* The label swaps to "Unfollow" on hover — the button says what it
                IS until you reach for it, then what it will DO. */}
            <span className="group-hover:hidden">{t('profile.following')}</span>
            <span className="hidden group-hover:inline">{t('user_profile.unfollow_button')}</span>
          </>
        ) : (
          t('user_profile.follow_button')
        )}
      </button>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('user_profile.lists.row_menu_label', { username })}
            data-testid="follow-row-menu-trigger"
            className={OVERFLOW_BUTTON}
          >
            <Icons.moreHorizontal className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        {/* ★ THE SHARED MENU PRIMITIVE CARRIES THE OFF-PALETTE COLOUR TOO.
            `DropdownMenuContent` defaults to `rounded-md` (6px) and
            `DropdownMenuItem` to `rounded-sm` + `focus:bg-background-tertiary`
            — and `background-tertiary` IS rgb(225,231,239), the exact slate the
            zebra striping used. Overridden here (tailwind-merge keeps the last
            of two conflicting utilities) rather than in the shared component,
            which every other menu in the app renders. */}
        <DropdownMenuContent
          align="end"
          className="w-56 rounded-control border-[#ebebeb] bg-white p-1.5 shadow-[0_8px_24px_rgba(20,18,10,0.10)]"
        >
          {block.available ? (
            <DropdownMenuItem
              // `preventDefault` keeps Radix from closing the menu on its own
              // before this handler runs; the close is explicit so focus lands
              // back on the trigger before the dialog takes it.
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                if (block.isBlocking) void commitBlock();
                else setConfirmOpen(true);
              }}
              disabled={block.busy}
              // ★ `ink-brand-6`, not `#c0392b` (2026-08-14 token-migration
              // pass) — rgb(192,57,43), byte-identical to the literal in
              // light mode. `--destructive` renders a visibly different red
              // (rgb(218,43,43)) and is reserved for the vote control only.
              className="cursor-pointer rounded-control px-2.5 py-2 text-caption font-medium text-ink-brand-6 focus:bg-[#fdf2f0] focus:text-ink-brand-6"
              data-testid="follow-row-block-menu-item"
            >
              {block.isBlocking
                ? t('user_profile.lists.unblock_menu_item', { username })
                : t('user_profile.lists.block_menu_item', { username })}
            </DropdownMenuItem>
          ) : block.unknown ? (
            // The read FAILED rather than answering "this pair cannot be
            // blocked". Letting the item vanish would read as "this person
            // cannot be blocked", which is never true — same treatment
            // `profile-actions.tsx` gives it.
            <DropdownMenuItem
              disabled
              className="cursor-not-allowed rounded-control px-2.5 py-2 text-caption font-medium focus:bg-[#faf9f8]"
              data-testid="follow-row-block-menu-item-unknown"
              title={t('user_profile.block_status_unknown_hint')}
            >
              {t('user_profile.block_status_unknown')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              void copyProfileLink();
            }}
            className="flex cursor-pointer items-center gap-2 rounded-control px-2.5 py-2 text-caption font-medium text-[#3f4650] focus:bg-[#faf9f8] focus:text-[#161511]"
            data-testid="follow-row-copy-link"
          >
            <Icons.link className="h-4 w-4" />
            {copied ? t('user_profile.lists.profile_link_copied') : t('user_profile.lists.copy_profile_link')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="flex flex-col gap-4 sm:max-w-md sm:rounded-panel" data-testid="follow-row-block-dialog">
          <AlertDialogHeader className="gap-2">
            <AlertDialogTitle>{t('block_confirm_dialog.title', { username })}</AlertDialogTitle>
            <AlertDialogDescription>{t('block_confirm_dialog.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
            <AlertDialogAction
              disabled={block.busy}
              data-testid="follow-row-block-confirm"
              // ★ `bg-surface-brand-12`, not `#c0392b` (2026-08-14) —
              // rgb(192,57,43), byte-identical to the literal in light mode.
              className="rounded-control bg-surface-brand-12 text-white hover:bg-[#a93226]"
              onClick={(event) => {
                event.preventDefault();
                void commitBlock();
                setConfirmOpen(false);
              }}
            >
              {block.busy ? <CircleSpinner loading size={16} color="#ffffff" /> : t('block_confirm_dialog.action')}
            </AlertDialogAction>
            <AlertDialogCancel className="rounded-control" data-testid="follow-row-block-cancel">
              {t('global.cancel')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
