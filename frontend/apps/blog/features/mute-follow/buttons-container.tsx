'use client';

import { useEffect, useState } from 'react';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import FollowButton from './follow-button';
import BlockButton from './block-button';
import { User } from '@smart-signer/types/common';
import { UseInfiniteQueryResult } from '@tanstack/react-query';
import { useFollowMutation, useUnfollowMutation } from './hooks/use-follow-mutations';
import { Button } from '@hive/ui';
import { CircleSpinner } from 'react-spinners-kit';
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
  hideBlock = false,
  followButtonClassName,
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
  /**
   * ★ REMOVES THE BLOCK PILL FROM THIS ROW (owner ruling 2026-08-19: "Block
   * does not belong in the post header — it's already in the '···' overflow
   * menu"). Verified in the browser before this was wired in: the post-detail
   * page's overflow menu (`content.tsx`, `post-header-block-menu-item`)
   * genuinely renders a working Block/Unblock item — same `useLumenBlock`
   * target/name-space, a real `POST /api/lite/block`, confirmed round-tripping
   * Block -> Unblock -> Block against this server. This prop only hides the
   * REDUNDANT copy that used to sit on this row; the other three callers of
   * this component (`popover-card-data.tsx`, `followers/content.tsx`,
   * `followed/content.tsx`) have no overflow-menu equivalent, so they do not
   * pass this and keep Block exactly as before.
   */
  hideBlock?: boolean;
  /**
   * Extra classes appended to `FollowButton`'s `className` — see that
   * component's own doc comment. Only the post-header call site
   * (`content.tsx`) passes this, to match its Follow pill to the Reblog pill
   * beside it; every other caller is unaffected.
   */
  followButtonClassName?: string;
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
  // ★ `identity`, NOT `user` (2026-08-12). This gate was the one place in this
  // file still reading raw `useUserClient()`, which reports SIGNED OUT until
  // `/api/users/me` answers. During that window the query is DISABLED, so it
  // never runs and never errors — which means the `lumen.unknown` guard added
  // today cannot fire, while the button is already clickable. A click in that
  // window falls through to the chain-follow path for a pair the chain cannot
  // hold. `identity` is seeded from the session cookie server-side and is
  // correct on the first render; `account_tier` stays on the raw hook because it
  // does not exist on `identity`.
  const lumen = useLumenFollow(
    username,
    identity.isLoggedIn && (user.account_tier === 'lite' || liteTarget)
  );

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
    // `!hideBlock`: when the caller hides this row's Block pill (the post-header
    // call site, which has its own overflow-menu Block instead), there is
    // nothing here for this state to drive — skip the request rather than
    // fetching block state that will never render.
    identity.isLoggedIn && username !== identity.username && !hideBlock
  );

  /**
   * ★★★ BLOCK ASKS FIRST — EVERYWHERE, NOT JUST IN THE FOLLOW LISTS (2026-08-14).
   *
   * This button was one click and done. A browser audit measured it on a post
   * byline: a bare 62×36 `Block` sitting directly beside `Unfollow` and `Reblog`,
   * and a single click fired `POST /api/lite/block` with no dialog, no undo
   * affordance, nothing. The follow-list redesign shipped the SAME action on the
   * SAME day behind a `…` menu AND a confirm dialog
   * (`features/account-lists/follow-list/follow-row-actions.tsx`). Same
   * destructive act, two opposite safety bars — and the unsafe one is the copy
   * that sits on every byline in the product, right next to two harmless buttons
   * it can be mis-clicked for.
   *
   * Blocking is not a preference toggle. It erases the other person's replies
   * under your posts FOR EVERY OTHER READER, which is why the dialog says so.
   *
   * ★ ONLY THE BLOCKING DIRECTION IS GATED. Unblocking stays one click: it is the
   * undo, it restores someone's voice rather than removing it, and putting a
   * speed bump in front of the recovery path is exactly backwards.
   *
   * Deliberately reuses `block_confirm_dialog.*` rather than adding new keys — the
   * two dialogs are the same question about the same action, and one wording that
   * drifts is how two surfaces end up describing one feature differently.
   */
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);

  const commitBlock = async () => {
    const failure = await block.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: block.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username }
      });
    }
  };

  const handlerBlock = async () => {
    // `block.isBlocking` is read at CLICK time, not captured at render — an unblock
    // that lands between render and click must not be confirmed as a block.
    if (!block.isBlocking) {
      setBlockConfirmOpen(true);
      return;
    }
    await commitBlock();
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
    // ★ THE BUG THIS GUARD CLOSES (2026-08-12). `lumen.applies` is ALSO false while
    // the state read is still failing (see `LumenFollow.unknown`'s doc), and without
    // this check execution fell straight through to the CHAIN mutation below — a
    // signer that does not exist for a keyless viewer, or a `custom_json` follow
    // broadcast against a name that is not a Hive account at all. `unknown` is scoped
    // by construction to exactly the pairs where a Lumen edge was possible (the query
    // never runs, so never errors, when it wasn't), so this can only refuse a follow
    // that genuinely might belong to Lumen — never an ordinary Hive-to-Hive one.
    // The button is already disabled for this state (FollowButton's `unknown` prop),
    // so a click reaching here at all means something bypassed the UI gate; refuse
    // rather than guess either way.
    if (lumen.unknown) {
      handleError(new Error(t('user_profile.follow_status_unknown_hint')), {
        method: 'lite-follow',
        params: { username }
      });
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
  // `lumen.unknown` joins the same group for the same reason: the chain's own
  // `isLoading`/`isFetching` booleans mean nothing here (a keyless viewer's chain
  // follow list may never resolve at all), and letting them leak into `loading` could
  // render a spinner in place of `FollowButton`'s honest `unknown` label instead of
  // just disabling the control.
  const onLumenPath = lumen.applies || lumen.pending || lumen.unknown;
  // ★ `follow.isFetching`, NOT INCLUDED HERE (2026-08-17, measured defect fix).
  //
  // `follow` is `useFollowingInfiniteQuery(user.username, 1000, 'blog', ...)`
  // (content.tsx:510), and the effect above (`followHasNextPage` /
  // `fetchNextFollowPage`) keeps paging it — SEQUENTIALLY, one 1000-row request
  // at a time — for as long as the viewer's own follow list has more pages.
  // React Query's `isFetching` on a `useInfiniteQuery` is true for EVERY one of
  // those background page fetches, not just the first, so a viewer who follows
  // more than 1000 accounts kept this button's spinner alive for the entire
  // multi-page chain, serially, before it ever became clickable.
  //
  // Measured against this server (curl, `/api/following`, `type=blog`,
  // `limit=1000`): a viewer following 3,747 accounts needs 4 sequential pages,
  // 0.46s + 0.16s + 0.15s + 0.15s = 0.93s end-to-end even on this box's warm
  // local network to the upstream node — and that number scales linearly and
  // UNBOUNDED with however many accounts the viewer follows, with no cap. On a
  // real deployment (higher per-request latency to a public Hive API node) that
  // is exactly the multi-second spin reported.
  //
  // `follow.isLoading` is different: it is true only for the FIRST fetch (no
  // page loaded yet at all), which this server measured at 0.15-0.46s for a
  // single request regardless of the viewer's total follow count — bounded,
  // not unbounded. Dropping `isFetching` here means the button stops spinning
  // and becomes usable as soon as page 1 answers, while pagination keeps
  // running in the background for `isFollow` (below) to pick up.
  //
  // This is an OPTIMISTIC render, not a corrected data source: if the account
  // being viewed is followed but sits past page 1 of a 1000+ list, `isFollow`
  // reads false (shows "Follow") until the background page containing it
  // loads, then self-corrects. That window can only make an ALREADY-FOLLOWED
  // click re-broadcast a follow (idempotent on chain — same end state) or an
  // ALREADY-NOT-FOLLOWED click re-broadcast an unfollow (also idempotent) —
  // never anything the mutation doesn't already handle. See
  // `use-follow-mutations.ts`'s `onMutate`, which cancels in-flight
  // `followingData` queries before writing its own optimistic entry, so a
  // click landing mid-pagination does not race the background pages either.
  const loading = onLumenPath
    ? lumen.busy || lumen.pending
    : follow.isLoading || followMutation.isPending || unfollowMutation.isPending;
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
            // `lumen.unknown`: the state read failed rather than resolving "this is a
            // chain follow" — see `LumenFollow.unknown`'s doc and `handlerFollow`'s
            // guard above. Disabled + honestly labelled, same pattern as BlockButton.
            unknown={lumen.unknown}
            className={followButtonClassName}
          />
          {!hideBlock && (
            <>
              {block.available || block.unknown ? (
                // `block.unknown`: the read failed rather than "this pair cannot be
                // blocked" (use-lumen-block.ts). Still mounted so BlockButton can render
                // its disabled, honestly-labelled state instead of vanishing during a
                // backend outage — see BlockButton's `unknown` prop.
                <BlockButton
                  loading={block.busy}
                  variant={variant}
                  isBlocking={block.isBlocking}
                  onClick={handlerBlock}
                  unknown={block.unknown}
                />
              ) : null}
              <AlertDialog open={blockConfirmOpen} onOpenChange={setBlockConfirmOpen}>
                <AlertDialogContent
                  className="flex flex-col gap-4 sm:max-w-md sm:rounded-panel"
                  data-testid="byline-block-dialog"
                >
                  <AlertDialogHeader className="gap-2">
                    <AlertDialogTitle>{t('block_confirm_dialog.title', { username })}</AlertDialogTitle>
                    <AlertDialogDescription>{t('block_confirm_dialog.description')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
                    <AlertDialogAction
                      disabled={block.busy}
                      data-testid="byline-block-confirm"
                      className="rounded-control bg-destructive text-white hover:bg-destructive/90"
                      onClick={(event) => {
                        // Radix closes the dialog on action by default; `preventDefault`
                        // keeps the close explicit so it cannot race the mutation.
                        event.preventDefault();
                        void commitBlock();
                        setBlockConfirmOpen(false);
                      }}
                    >
                      {block.busy ? (
                        <CircleSpinner loading size={16} color="#ffffff" />
                      ) : (
                        t('block_confirm_dialog.action')
                      )}
                    </AlertDialogAction>
                    <AlertDialogCancel className="rounded-control" data-testid="byline-block-cancel">
                      {t('global.cancel')}
                    </AlertDialogCancel>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
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
