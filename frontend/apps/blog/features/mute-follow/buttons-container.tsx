'use client';

import { useEffect } from 'react';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import FollowButton from './follow-button';
import BlockButton from './block-button';
import { User } from '@smart-signer/types/common';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { useFollowMutation, useUnfollowMutation } from './hooks/use-follow-mutations';
import { Button } from '@hive/ui';
import DialogLogin from '@/blog/components/dialog-login';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLumenFollow } from '@/blog/lib/lite/client/use-lumen-follow';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';

const ButtonsContainer = ({
  username,
  user,
  variant,
  follow,
  mute,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted but
  // inert, see the `hideMute?: boolean` doc comment below.
  hideMute: _hideMute = false,
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
   * ★ VESTIGIAL SINCE 2026-08-12 (owner ruling: one control, Block — see the big
   * comment on `block` below). This used to hide the on-chain Mute button for a
   * Lumen lite author; Mute was removed from this component entirely, so the
   * prop no longer does anything.
   *
   * ★ G3 (2026-08-12, Block consolidation cleanup) — CHECKED, LEFT IN PLACE.
   * Only TWO of the four call sites this comment used to credit actually pass
   * it: `permlink/content.tsx` (`hideMute` on the post-header row) and
   * `popover-card-data.tsx` (the lite-author byline). `followers/content.tsx`
   * and `followed/content.tsx` never passed it — they render list rows, not a
   * byline, and simply relied on the default. Removing the prop cleanly still
   * means editing those two callers (plus this file), and neither is owned by
   * this pass — touching them as a drive-by alongside an unrelated cleanup
   * would be the "needless, uncoordinated diff" the original note already
   * warned against, just with the count corrected. Left in place, still safe
   * to delete everywhere in one pass whenever `permlink/content.tsx` or
   * `popover-card-data.tsx` is next touched for its own reasons.
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

  /**
   * ★ GAP-2 FIX (owner ruling 2026-08-12, "Block does not render reliably").
   * `user` is a PROP — passed straight from whichever page mounted this row,
   * most of them off raw `useUserClient()`, which cannot answer during SSR and
   * reports signed-out until `/api/users/me` returns (`server-session.tsx`'s own
   * header comment; the same bug the settings owner-gate already had). A caller
   * that had not yet re-rendered with the real answer handed this component
   * `user.isLoggedIn === false`, `useLumenBlock`'s query never ran, and Block
   * silently never appeared — on the author popover (`popover-card-data.tsx`)
   * this is the ONLY place Block is reachable from a comment or post byline.
   * This is this component's OWN `useSessionIdentity()` read, so it is correct
   * on the first render regardless of what any of the four callers pass — none
   * of them need to change for this fix to apply.
   */
  const identity = useSessionIdentity();

  const followMutation = useFollowMutation();
  const unfollowMutation = useUnfollowMutation();

  // `mute`/`follow` are the VIEWER's own ignore/blog lists (every caller constructs
  // them with `useFollowingInfiniteQuery(user.username, 1000, ...)`). `mute` no
  // longer drives a rendered control (Mute was removed, owner ruling 2026-08-12) —
  // only `follow` still needs beyond-first-page pagination, for `isFollow` below.
  // `get_following` caps a single page at 1000 entries; for a viewer following more
  // than that, whoever landed past the first page used to read as not-followed,
  // offering "Follow" to someone already followed. Keep fetching while more pages
  // exist; react-query dedupes this per query key across every card sharing it, so
  // this does not add a fetch per card.
  const {
    hasNextPage: followHasNextPage,
    isFetchingNextPage: followIsFetchingNextPage,
    fetchNextPage: fetchNextFollowPage
  } = follow;

  // ★ `cancelRefetch: false` IS LOAD-BEARING, NOT A STYLE CHOICE (2026-08-11).
  // `follow` is the SAME useInfiniteQuery result, passed down as a prop to every
  // ButtonsContainer on the page (followers/content.tsx and followed/content.tsx
  // both render one per row). React flushes every mounted instance's effects
  // before any of their state updates lands, so all of them observe
  // `hasNextPage && !isFetchingNextPage` at once and all call `fetchNextPage()`
  // in the same tick. React Query v4's `fetchNextPage` defaults `cancelRefetch`
  // to `true`, which does not merge those calls — the 2nd..Nth cancel the 1st's
  // promise and start a fresh one each. Measured on a 20-row followers page with
  // the viewer's own list forced past 1000 entries (has-next-page): 20 distinct
  // outbound `get_following` requests per page turn, not 1. Worse, `getFollowing`
  // (packages/transaction/lib/hive-api.ts) never wires the query's abort signal
  // into the chain call, so a "cancelled" fetch keeps running upstream anyway —
  // cancelling client-side state buys nothing and the wasted request still lands
  // on the Hive node. `cancelRefetch: false` makes every re-entrant call while a
  // fetch is already in flight return that SAME promise instead of restarting
  // (query-core's `Query.fetch`: `else if (this.promise) return this.promise`).
  // Verified this collapses the 20-per-turn storm to exactly 1 real request.
  useEffect(() => {
    if (followHasNextPage && !followIsFetchingNextPage) {
      fetchNextFollowPage({ cancelRefetch: false });
    }
  }, [followHasNextPage, followIsFetchingNextPage, fetchNextFollowPage]);

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

  // ★ BLOCK IS OFFERED TO EVERYONE, ON EVERY BYLINE — the one moderation control
  // here (owner ruling 2026-08-12 retired the on-chain Mute button that used to
  // sit beside it; see the removed `hideMute`/`viewerIsLite` machinery this
  // replaced). A block is always Lumen's, always available to both account tiers,
  // and always means the same thing: this person disappears from my feeds, and
  // their replies under my posts stop being served to anybody.
  //
  // `targetKind` says which name-space `username` is from. `liteTarget` is exactly
  // that distinction, and it matters here more than anywhere else: a Lumen handle and
  // a Hive account can share a spelling, and blocking the wrong one would erase an
  // innocent person's comments from other readers' screens.
  //
  // Gated on `identity`, not the `user` prop — see the big comment on `identity`
  // above for why.
  const block = useLumenBlock(
    username,
    liteTarget ? 'lumen' : 'hive',
    identity.isLoggedIn && username !== identity.username
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
    : follow.isLoading || follow.isFetching || followMutation.isPending || unfollowMutation.isPending;
  return (
    <>
      {/* ★ `identity.isLoggedIn`, NOT `user.isLoggedIn` — see the big comment on
          `identity` above. Gating this on the raw prop is exactly what made Block
          (and this whole signed-in row) intermittently render as a login-prompt
          button for an already-signed-in reader. */}
      {identity.isLoggedIn ? (
        <>
          <FollowButton
            loading={loading}
            variant={variant}
            isFollow={isFollow}
            onClick={handlerFollow}
            disabled={temporaryDisabled}
          />
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
