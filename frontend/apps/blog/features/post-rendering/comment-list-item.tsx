'use client';

import { MoreHorizontal } from 'lucide-react';
import { Icons } from '@hive/ui/components/icons';
import parseDate from '@hive/ui/lib/parse-date';
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@hive/ui/components/card';
import { cn } from '@hive/ui/lib/utils';
import { Link } from '@hive/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
import { Separator } from '@ui/components/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@ui/components/accordion';
import { memo, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import DetailsCardVoters from '@/blog/features/post-rendering/details-card-voters';
import { ReplyTextbox } from '../post-editor/reply-textbox';
import DetailsCardHover from '../list-of-posts/details-card-hover';
import { IFollowList, Entry } from '@hive/common-hiveio-packages/wax';
import clsx from 'clsx';
import { Badge } from '@ui/components/badge';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '../../components/dialog-login';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';

import { PostDeleteDialog } from './post-delete-dialog';
import dmcaUserList from '@hive/ui/config/lists/dmca-user-list';
import userIllegalContent from '@hive/ui/config/lists/user-illegal-content';
import gdprUserList from '@ui/config/lists/gdpr-user-list';
import RendererContainer from './rendererContainer';
import { useDeleteCommentMutation } from './hooks/use-comment-mutations';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import MutePostDialog from './mute-post-dialog';
import ChangeTitleDialog from '../community-profile/change-title-dialog';
import { AlertDialogFlag } from './alert-window-flag';
import FlagTooltip from './flag-icon';
import TimeAgo from '@hive/ui/components/time-ago';
import { getUserAvatarUrl } from '@hive/ui';
import { UserPopoverCard } from './user-popover-card';
import { useTranslation } from '@/blog/i18n/client';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { getCommentMuteReasonKey, isOwnModerationHide } from '@/blog/lib/muted-reasons';
import { classifyBlacklist } from '@/blog/lib/moderation/blacklist-reason';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';

interface CommentListProps {
  permissionToMute: Boolean;
  comment: Entry;
  parent_depth: number;
  mutedList: IFollowList[];
  parentPermlink: string;
  discussionAuthor: string;
  discussionPermlink: string;
  observer: string;
  parentAuthor: string;
  flagText: string | undefined;
  filteringEnabled?: boolean;
  onCommnentLinkClick: (hash: string) => void;
  /** Set by CommentList once nesting passes MAX_VISUAL_DEPTH (item 10): the
   *  thread stops indenting further, so this names who the flattened reply is
   *  actually answering, since the connector line no longer shows it. */
  replyingToAuthor?: string;
  children?: ReactNode;
}
export const commentClassName =
  'font-sanspro text-[12.5px] prose-h1:text-[20px] prose-h2:text-[17.5px] prose-h4:text-[13.7px] sm:text-[13.4px] sm:prose-h1:text-[21.5px] sm:prose-h2:text-[18.7px] sm:prose-h3:text-[16px]  sm:prose-h4:text-[14.7px] lg:text-[14.6px] lg:prose-h1:text-[23.3px] lg:prose-h2:text-[20.4px] lg:prose-h3:text-[17.5px] lg:prose-h4:text-[16px] prose-h3:text-[15px] prose-p:mb-[9.6px] prose-p:mt-[1.6px] last:prose-p:mb-[3.2px] prose-img:max-w-full prose-img:h-auto prose-img:max-h-[400px]';

const CommentListItem = memo(function CommentListItem({
  permissionToMute,
  comment,
  parent_depth,
  mutedList,
  parentPermlink,
  parentAuthor,
  flagText,
  discussionAuthor,
  discussionPermlink,
  observer,
  filteringEnabled = true,
  onCommnentLinkClick,
  replyingToAuthor,
  children
}: CommentListProps) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  /**
   * ★ SAME BUG CLASS AS app-header.tsx ("NEVER SHOW A SIGNED-IN READER A
   * SIGNED-OUT HEADER", 2026-08-10, N-3). `user.isLoggedIn`/`user.username`
   * cannot answer during SSR and report signed-out/empty on the client until
   * `/api/users/me` returns, so any RENDER gate read straight off `user`
   * flickers a signed-in reader into the signed-out variant for that window.
   * `identity` prefers the client's real answer once it has landed and falls
   * back to the cookie the server already read before then.
   *
   * Fixed on this pass (2026-08-11): both AlertDialogFlag triggers, the
   * footer Reply/DialogLogin branch, the Edit button's ownership check, the
   * comment PostDeleteDialog's outer ownership+visibility gate, and the
   * "manage list" link (including the `hiddenReasonListHref` it points at,
   * below — its href was still built from the raw, stale `user.username`).
   * `replyStorageId`/`editStorageId` further down are intentionally left on
   * raw `user` — they key a localStorage draft, not a render, and a stale
   * key for one extra render just means the draft briefly keys under '' and
   * self-corrects, never a wrong-user collision. `PostDeleteDialog`'s own
   * internal `user.isLoggedIn` check is a separate file/hook call, still
   * raw — same accepted residual as the AlertDialogFlag dialogs above: in
   * the narrow window where the SSR-cookie fallback says logged-in but the
   * raw query hasn't answered, the dialog can mount with its own confirm
   * button briefly absent, self-healing the moment the client answer lands.
   */
  const identity = useSessionIdentity();
  const ref = useRef<HTMLTableRowElement>(null);

  // Every Lumen post and reply is published on chain by ONE shared account, so a
  // comment thread showed that account's name against everybody's words. The overlay
  // puts the real person back. No-op for ordinary Hive comments.
  //
  // DISPLAY ONLY — the name, the avatar and the link to this comment's own page.
  // Everything below still uses `comment.author`, deliberately: it is the account
  // that signed this comment, which is what the mute/blacklist/DMCA checks must
  // match, what the flag and mute dialogs act on, what the `#@author/permlink`
  // anchors have to agree with, and — most importantly — what `ReplyTextbox` needs
  // as the parent author, since a reply naming the wrong parent would be rejected by
  // the chain.
  const liteOverlay = useLiteOverlay(comment);
  const displayAuthor = liteOverlay?.author ?? comment.author;

  const isMutedByViewer = mutedList?.some((x) => x.name === comment.author);
  const isGrayedByStats = comment.stats?.gray;
  // ★ NOT `comment.blacklists.length > 0` — Hivemind mixes a synthetic
  // "reputation-N" token into that array for any low/negative-reputation author,
  // with no list involved at all. See `classifyBlacklist` for the measured proof
  // (bpcvoter1/bpcvoter3: reputation-only, on NO real list; bpcvoter2: confirmed
  // on lordbutterfly's own list, and the only entry carrying "my blacklist").
  // `isGrayedByStats` below is intentionally unaffected — hiding low-reputation
  // comments by default is correct; MISLABELLING why is what was wrong.
  const blacklistReason = classifyBlacklist(comment.blacklists);
  // ★ E5 (BUILDMAP-FUCKERY-V2, G3) — "Reveal Comment" gave no author-level context
  // and no route back to the list that caused the hide. Only the two REAL, viewer-
  // controlled list matches get a link — a community-moderation hide, a low-
  // reputation hide or a plain downvote have no list to route back to; the reason
  // text next to "Reveal Comment" already names those, unchanged.
  //
  // ★ Still computed even though `isMutedByViewer`/`own` now hard-hide below
  // (`userModerationHidden`) rather than reaching this link: `blacklistReason`
  // 'followed' still routes a collapsed comment back to the followed-list page,
  // and this expression stays correct for that case without a second branch.
  const hiddenReasonListHref = isMutedByViewer
    ? `/@${identity.username}/lists/muted`
    : blacklistReason === 'own'
      ? `/@${identity.username}/lists/blacklisted`
      : blacklistReason === 'followed'
        ? `/@${identity.username}/lists/followed_blacklists`
        : null;
  // ★ OWNER RULING 2026-08-12 — "mute and personal blacklist should be the same
  // damn thing... just call it block." The comment overflow menu's ONE moderation
  // control is Block (below), not separate Mute/Blacklist items. Acts on
  // `displayAuthor`/its name-space, same split ButtonsContainer/ProfileActions
  // already use for Block: `comment.author` is the SHARED publishing account for
  // a lite-authored comment, and blocking THAT would block every lite author's
  // comments at once — the identical trap the old Mute/Blacklist code guarded
  // against with `targetIsLite`. `identity` (not `user`) is deliberate: the same
  // async-identity race that hid Block on the profile dropdown (server-session.tsx)
  // would otherwise hide it here too.
  const block = useLumenBlock(
    displayAuthor,
    liteOverlay ? 'lumen' : 'hive',
    identity.isLoggedIn && displayAuthor !== identity.username
  );
  const handleBlockClick = async () => {
    const failure = await block.toggle();
    if (failure) {
      handleError(new Error(failure), {
        method: block.isBlocking ? 'lumen-unblock' : 'lumen-block',
        params: { username: displayAuthor }
      });
    }
  };
  // ★ THE VIEWER'S OWN MODERATION HARD-HIDES — NO COLLAPSE, NO REVEAL (owner
  // ruling 2026-08-12; see `isOwnModerationHide`'s doc for exactly which of the
  // 9 hidden-reason states this covers and which stay collapsed). This is
  // SEPARATE from `isOriginallyHidden` below, which still drives the low-
  // reputation collapse-with-Reveal the owner said must NOT change.
  const userModerationHidden = isOwnModerationHide(Boolean(isMutedByViewer), blacklistReason);
  const isOriginallyHidden = filteringEnabled && isGrayedByStats;
  const [hiddenComment, setHiddenComment] = useState(isOriginallyHidden);
  const [openState, setOpenState] = useState<string>(isOriginallyHidden ? '' : 'item-1');
  const [tempraryHidden, setTemporaryHidden] = useState(false);
  const commentId = `@${comment.author}/${comment.permlink}`;

  // Build storage keys only when user is logged in (empty string disables hook)
  const replyStorageId = user.isLoggedIn
    ? `replybox-/${comment.author}/${comment.permlink}-${user.username}`
    : '';
  const editStorageId = user.isLoggedIn
    ? `editbox-/${comment.author}/${comment.permlink}-${user.username}`
    : '';

  // Use hooks for reply and edit state - provides cross-tab sync and automatic TTL
  const [storedReply, setStoredReply, removeStoredReply] = useStorageWithTTL<boolean>(
    replyStorageId,
    false,
    StorageTTL.UI_STATE
  );
  const [storedEdit, setStoredEdit, removeStoredEdit] = useStorageWithTTL<boolean>(
    editStorageId,
    false,
    StorageTTL.UI_STATE
  );

  // Wrapper to match expected interface and handle storage
  const setReply = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      if (typeof value === 'function') {
        setStoredReply((prev) => value(prev));
      } else if (value) {
        setStoredReply(true);
      } else {
        removeStoredReply();
      }
    },
    [setStoredReply, removeStoredReply]
  );

  const setEdit = useCallback(
    (value: boolean) => {
      if (value) {
        setStoredEdit(true);
      } else {
        removeStoredEdit();
      }
    },
    [setStoredEdit, removeStoredEdit]
  );

  // Use stored values directly as state
  const reply = storedReply;
  const edit = storedEdit;
  const userFromDMCA = dmcaUserList.some((e) => e === comment.author);
  const legalBlockedUser = userIllegalContent.some((e) => e === comment.author);
  const userFromGDPR = gdprUserList.some((e) => e === comment.author);
  const parentFromGDPR = gdprUserList.some((e) => e === comment.parent_author);

  useEffect(() => {
    // `isMutedByViewer` dropped from this recompute (2026-08-12): it now hard-hides
    // the whole comment via `userModerationHidden` below, before this state ever
    // matters, and folding it back in here would make `filteringEnabled` — the
    // low-reputation "show N filtered comments" switch — able to reveal it again,
    // exactly the reveal affordance the owner said must not exist for it.
    const shouldBeHidden = filteringEnabled && !!comment.stats?.gray;
    setHiddenComment(shouldBeHidden);
    setOpenState(shouldBeHidden ? '' : 'item-1');
    setTemporaryHidden(filteringEnabled && !!comment.stats?.gray);
  }, [comment.stats?.gray, filteringEnabled]);
  const currentDepth = comment.depth - parent_depth;

  const deleteCommentMutation = useDeleteCommentMutation();
  const deleteComment = async (permlink: string) => {
    try {
      await deleteCommentMutation.mutateAsync({ permlink, discussionAuthor, discussionPermlink, observer });
    } catch (error) {
      handleError(error, { method: 'deleteComment', params: { permlink } });
    }
  };

  // Receive output from dialog and do action according to user's
  // response.
  const dialogAction = (permlink: string): void => {
    if (permlink) {
      deleteComment(permlink);
    }
  };

  if (userFromGDPR || parentFromGDPR) {
    return null;
  }
  // ★ OWNER RULING 2026-08-12 — "we should have no collapses like Hiveblog or
  // ecency or peakd... it works the same way" as Block. A comment from someone
  // the viewer muted or personally blacklisted is now gone the same way a
  // genuinely Lumen-Blocked account's comment already is (filtered out before
  // this component ever mounts, in `[permlink]/content.tsx`'s `discussionState`)
  // — no card, no "Reveal Comment", and the subtree goes with it for the same
  // reason `block-filter.ts` cascades a Block's hide: a reply routinely quotes
  // what it answers, so leaving it visible would serve the hidden words back
  // through somebody else's mouth. Recoverable only from Settings (Muted Users /
  // Blacklisted Users), same as an actual Block is only recoverable from the
  // Blocked Accounts list.
  if (userModerationHidden) {
    return null;
  }
  return (
    <>
      {currentDepth < 8 ? (
        <li data-testid="comment-list-item" className="w-full min-w-0">
          <div className="w-full min-w-0" id={commentId} ref={ref}>
            <Accordion type="single" collapsible value={openState} className="w-full min-w-0">
              <AccordionItem className="w-full min-w-0" value="item-1">
                {/* ★ THE COMMENT SUBTREE WAS AN UNMIGRATED VISUAL SYSTEM (v8, post detail).
                    Measured on a real thread: 181 bordered boxes at border-radius 0 with
                    border rgb(241,245,249), plus stray 6px, 8px and 12px radii, while the
                    rest of the app is 14/18/20/22px on #ebebeb / #eee2dc. Card's own
                    default (`rounded-md`, themed `border`) is what produced most of it.
                    Pinned to the house tokens here: white surface, #ebebeb hairline,
                    14px radius, which is the radius the design system assigns to rows. */}
                <Card
                  className={cn(
                    `mb-4 w-full min-w-0 overflow-hidden rounded-[14px] border-[#ebebeb] bg-white text-primary depth-${comment.depth}`,
                    {
                      'opacity-50 hover:opacity-100': hiddenComment || tempraryHidden,
                      'border border-destructive': comment._temporary,
                      'border border-blue-400/50': comment._optimistic
                    }
                  )}
                >
                  {/* ★ ONE padding token for the whole card (item 5/6/8): CardHeader
                      carries it here, CardContent and CardFooter below match it
                      exactly (px-3 py-2), and nothing inside any of the three rows
                      adds its own competing offset (the old pl-1/ml-4/px-[5px]/px-2
                      mix is what produced 4px at one depth and 12-16px at another —
                      it was never depth-dependent, just inconsistent per row). */}
                  <CardHeader className="px-3 py-2">
                    <div className="flex w-full justify-between">
                      <div
                        className="flex w-full flex-col justify-start sm:flex-row sm:items-center"
                        data-testid="comment-card-header"
                      >
                        <div className="flex w-full items-center justify-between text-xs sm:text-sm">
                          <div className="flex flex-wrap items-center">
                            {comment._temporary && !comment._optimistic ? (
                              <div className="flex items-center font-bold hover:cursor-pointer hover:text-destructive">
                                {displayAuthor}
                              </div>
                            ) : (
                              <>
                                {comment._optimistic && (
                                  <span className="mr-2 flex items-center gap-1 text-xs text-blue-500">
                                    <CircleSpinner size={10} color="#3b82f6" loading />
                                    {t('global.publishing')}
                                  </span>
                                )}
                                {/* ★ item 7: ONE avatar rule for every depth. Used to be TWO —
                                    a 40px avatar rendered before the card (desktop only,
                                    outside this component's own padding, and the thing that
                                    made the per-depth indent compound by 52px on top of the
                                    24px thread line) plus this 20px one (mobile only). Now
                                    there is just this one, at every breakpoint and every depth,
                                    living inside the card's own padding so it can never float
                                    in the gutter or cross the connector line. The card-level
                                    `opacity-50` already fades hidden/temporary comments, so this
                                    doesn't need its own opacity variant. */}
                                <img
                                  className="mr-1.5 h-[20px] w-[20px] shrink-0 rounded-3xl"
                                  height="20"
                                  width="20"
                                  src={getUserAvatarUrl(displayAuthor, 'small')}
                                  alt={`${displayAuthor} profile picture`}
                                  loading="lazy"
                                />
                                <UserPopoverCard
                                  // The card ACTS on the real signing account —
                                  // follow, mute and the profile lookup all live in
                                  // there — and only DISPLAYS the lite name.
                                  author={comment.author}
                                  liteName={liteOverlay?.author}
                                  author_reputation={comment.author_reputation}
                                  blacklist={comment.blacklists}
                                />
                                {comment.author_title ? (
                                  <Badge
                                    variant="outline"
                                    className="mr-1 border-destructive"
                                    data-testid="comment-user-affiliation-tag"
                                  >
                                    <span className="mr-1">{comment.author_title}</span>
                                    <ChangeTitleDialog
                                      permlink={parentPermlink}
                                      moderateEnabled={permissionToMute}
                                      userOnList={comment.author}
                                      title={comment.author_title ?? ''}
                                      community={comment.community ?? ''}
                                    />
                                  </Badge>
                                ) : (
                                  <ChangeTitleDialog
                                    permlink={parentPermlink}
                                    moderateEnabled={permissionToMute}
                                    userOnList={comment.author}
                                    title={comment.author_title ?? ''}
                                    community={comment.community ?? ''}
                                  />
                                )}
                                <Link
                                  href={`#@${comment.author}/${comment.permlink}`}
                                  className="ml-1 hover:text-destructive md:text-sm"
                                  title={String(parseDate(comment.created))}
                                  data-testid="comment-timestamp-link"
                                  onClick={() => {
                                    onCommnentLinkClick(`#@${comment.author}/${comment.permlink}`);
                                  }}
                                >
                                  <TimeAgo date={comment.created} />
                                </Link>
                                {!comment._optimistic && (
                                  <Link
                                    className="p-1 sm:p-2"
                                    href={`/${comment.category}/@${displayAuthor}/${comment.permlink}`}
                                    data-testid="comment-page-link"
                                    aria-label={`Open ${displayAuthor}'s reply on its own page`}
                                  >
                                    <Icons.link className="h-3 w-3" />
                                  </Link>
                                )}
                                {/* ★ item 10: once CommentList stops indenting past
                                    MAX_VISUAL_DEPTH, this is the only thing left that says
                                    who a flattened reply is actually answering. */}
                                {replyingToAuthor && (
                                  <span
                                    className="whitespace-nowrap text-[11px] text-muted-foreground"
                                    data-testid="comment-replying-to"
                                  >
                                    {t('cards.comment_card.replying_to', { author: replyingToAuthor })}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                          {comment._temporary && !comment._optimistic ? null : !hiddenComment ? (
                            <div className="flex items-center">
                              {/* Only show flag here for non-originally-hidden comments; originally hidden ones show flag in the reveal/hide section */}
                              {!isOriginallyHidden && flagText && comment.community && !identity.isLoggedIn ? (
                                <DialogLogin>
                                  <FlagTooltip onClick={() => {}} />
                                </DialogLogin>
                              ) : !isOriginallyHidden && flagText && comment.community && identity.isLoggedIn ? (
                                <AlertDialogFlag
                                  community={comment.community}
                                  username={comment.author}
                                  permlink={comment.permlink}
                                  flagText={flagText}
                                >
                                  <FlagTooltip onClick={() => {}} />
                                </AlertDialogFlag>
                              ) : null}
                              <AccordionTrigger
                                className="pb-0 pt-1 !no-underline sm:hidden"
                                aria-label={
                                  openState === 'item-1' ? 'Collapse this reply' : 'Expand this reply'
                                }
                                onClick={() => setOpenState((prev) => (prev === 'item-1' ? '' : 'item-1'))}
                              />
                            </div>
                          ) : null}
                        </div>
                        {comment._temporary && !comment._optimistic ? null : isOriginallyHidden ? (
                          <div className="flex w-full items-center justify-between">
                            <AccordionTrigger
                              className="pb-0 pt-1 !no-underline "
                              onClick={() => setOpenState((prev) => (prev === 'item-1' ? '' : 'item-1'))}
                            >
                              <span
                                // ★ item 9: this used to wrap mid-phrase ("Reveal
                                // Comment" / "(blacklisted)" on separate lines) once the
                                // per-depth indent (item 10) had eaten enough width.
                                // whitespace-nowrap keeps it one line; the row itself is
                                // free to wrap around it if the viewport is that narrow.
                                className="cursor-pointer whitespace-nowrap text-xs sm:text-sm"
                                onClick={() => setHiddenComment(!hiddenComment)}
                              >
                                {hiddenComment
                                  ? t('cards.comment_card.reveal_comment')
                                  : t('cards.comment_card.hide_comment')}
                                {hiddenComment && (
                                  <span className="ml-1 text-muted-foreground">
                                    (
                                    {t(
                                      getCommentMuteReasonKey(
                                        comment.stats?.muted_reasons,
                                        isMutedByViewer,
                                        blacklistReason
                                      )
                                    )}
                                    )
                                  </span>
                                )}
                              </span>
                            </AccordionTrigger>
                            {/* Flag icon stays in this section for originally hidden comments */}
                            <div className="flex items-center gap-2">
                              {/* ★ E5 — the way back to the list that caused this hide.
                                  Deliberately OUTSIDE the AccordionTrigger button above:
                                  an anchor nested inside a button is invalid HTML, so the
                                  link lives in this sibling row instead. */}
                              {hiddenComment && hiddenReasonListHref && identity.isLoggedIn ? (
                                <Link
                                  href={hiddenReasonListHref}
                                  className="whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline sm:text-sm"
                                  data-testid="comment-hidden-reason-list-link"
                                >
                                  {t('cards.comment_card.manage_list_link')}
                                </Link>
                              ) : null}
                              {flagText && comment.community && !identity.isLoggedIn ? (
                                <DialogLogin>
                                  <FlagTooltip onClick={() => {}} />
                                </DialogLogin>
                              ) : flagText && comment.community && identity.isLoggedIn ? (
                                <AlertDialogFlag
                                  community={comment.community}
                                  username={comment.author}
                                  permlink={comment.permlink}
                                  flagText={flagText}
                                >
                                  <FlagTooltip onClick={() => {}} />
                                </AlertDialogFlag>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {comment._temporary && !comment._optimistic ? null : !openState ? (
                          <div
                            className="flex h-5 items-center gap-2 text-xs sm:text-sm"
                            data-testid="comment-card-footer"
                          >
                            <VotesComponentWrapper post={comment} type="comment" />

                            <DetailsCardHover
                              post={comment}
                              decline={parseFloat(comment.max_accepted_payout) === 0}
                            >
                              <div className="flex items-center hover:cursor-pointer hover:text-destructive ">
                                {'$'}
                                {comment.payout.toFixed(2)}
                              </div>
                            </DetailsCardHover>
                            {comment.children ? (
                              <>
                                <Separator orientation="vertical" />
                                <div className="flex items-center text-nowrap">
                                  {comment.children}{' '}
                                  {comment.children > 1
                                    ? t('cards.comment_card.replies')
                                    : t('cards.comment_card.one_reply')}
                                </div>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {!hiddenComment ? (
                        <AccordionTrigger
                          className="mr-2 hidden pb-0 pt-1 !no-underline sm:block"
                          aria-label={openState === 'item-1' ? 'Collapse this reply' : 'Expand this reply'}
                          onClick={() => setOpenState((prev) => (prev === 'item-1' ? '' : 'item-1'))}
                        />
                      ) : null}
                    </div>
                  </CardHeader>
                  <AccordionContent className="h-fit p-0">
                    {/* ★ item 8: this used to be header / hairline / body / hairline /
                        footer — three stacked, separately-bordered bands rather than one
                        card. Both internal <Separator>s are gone; the card's own border
                        is the only edge now, and CardContent matches the same px-3 py-2
                        token as the header and footer above/below it. */}
                    <CardContent
                      className="h-fit w-full min-w-0 overflow-hidden px-3 py-2 hover:bg-background-tertiary"
                      data-testid="comment-card-to-hover"
                    >
                      {legalBlockedUser ? (
                        <div className="px-2 py-6">{t('global.unavailable_for_legal_reasons')}</div>
                      ) : userFromDMCA ? (
                        <div className="px-2 py-6">{t('post_content.body.copyright')}</div>
                      ) : edit && comment.parent_permlink && comment.parent_author ? (
                        <ReplyTextbox
                          editMode={edit}
                          onSetReply={setEdit}
                          username={comment.parent_author}
                          permlink={comment.permlink}
                          parentPermlink={comment.parent_permlink}
                          storageId={editStorageId}
                          comment={comment}
                          discussionAuthor={discussionAuthor}
                          discussionPermlink={discussionPermlink}
                          observer={observer}
                        />
                      ) : (
                        <CardDescription data-testid="comment-card-description">
                          <RendererContainer
                            body={comment.body}
                            author={comment.author}
                            permlink={comment.permlink}
                            className={commentClassName}
                          />
                        </CardDescription>
                      )}
                    </CardContent>
                    <CardFooter className="px-3 py-2">
                      {comment._temporary && !comment._optimistic ? null : (
                        <div
                          // ★ item 9: this used to be a single non-wrapping row inside a
                          // Card with `overflow-hidden`. Once per-depth indent (fixed
                          // separately, item 10) ate enough of the card's width the row
                          // had nowhere to go but clip — the downvote arrow rendered
                          // half-width and the payout vanished past the card's right
                          // edge. flex-wrap means a still-narrow card reflows the row
                          // onto a second line instead of silently cutting it off.
                          className="flex flex-wrap items-center gap-2 pt-1 text-xs sm:text-sm"
                          data-testid="comment-card-footer"
                        >
                          <VotesComponentWrapper post={comment} type="comment" />
                          <DetailsCardHover
                            post={comment}
                            decline={parseFloat(comment.max_accepted_payout) === 0}
                          >
                            <div
                              data-testid="comment-card-footer-payout"
                              className={clsx(
                                'flex items-center hover:cursor-pointer hover:text-destructive',
                                {
                                  'line-through opacity-50': parseFloat(comment.max_accepted_payout) === 0
                                }
                              )}
                            >
                              {'$'}
                              {comment.payout.toFixed(2)}
                            </div>
                          </DetailsCardHover>
                          {!!comment.stats && comment.stats.total_votes > 0 ? (
                            <>
                              <div className="flex items-center">
                                <DetailsCardVoters post={comment}>
                                  <span className="hover:text-destructive">
                                    {!!comment.stats && comment.stats.total_votes > 1
                                      ? t('cards.post_card.votes', { votes: comment.stats.total_votes })
                                      : t('cards.post_card.vote')}
                                  </span>
                                </DetailsCardVoters>
                              </div>
                            </>
                          ) : null}
                          {/* ★ item 11: "the app's tokens" — copied verbatim from the
                              reply editor's own Cancel button (reply-textbox.tsx), the
                              nearest sibling component in this same feature, rather than
                              inventing a new de-emphasised-text convention here. */}
                          {identity.isLoggedIn ? (
                            <button
                              disabled={deleteCommentMutation.isLoading}
                              onClick={() => setReply(!reply)}
                              className="flex items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                              data-testid="comment-card-footer-reply"
                            >
                              {t('cards.comment_card.reply')}
                            </button>
                          ) : (
                            <DialogLogin>
                              <button
                                className="flex items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                                data-testid="comment-card-footer-reply"
                              >
                                {t('post_content.footer.reply')}
                              </button>
                            </DialogLogin>
                          )}
                          {identity.isLoggedIn && comment.author === identity.username ? (
                            <button
                              disabled={deleteCommentMutation.isLoading}
                              onClick={() => {
                                setEdit(!edit);
                              }}
                              className="flex items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                              data-testid="comment-card-footer-edit"
                            >
                              {t('cards.comment_card.edit')}
                            </button>
                          ) : null}
                          {comment.replies.length === 0 &&
                          identity.isLoggedIn &&
                          comment.author === identity.username &&
                          new Date() < new Date(`${comment.payout_at}Z`) ? (
                            <PostDeleteDialog
                              permlink={comment.permlink}
                              action={dialogAction}
                              label="Comment"
                            >
                              <button
                                disabled={edit || deleteCommentMutation.isLoading}
                                className="flex items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                                data-testid="comment-card-footer-delete"
                              >
                                {deleteCommentMutation.isLoading ? (
                                  <CircleSpinner
                                    loading={deleteCommentMutation.isLoading}
                                    size={18}
                                    color="#dc2626"
                                  />
                                ) : (
                                  t('cards.comment_card.delete')
                                )}
                              </button>
                            </PostDeleteDialog>
                          ) : null}
                          {permissionToMute ? (
                            <MutePostDialog
                              comment={true}
                              community={comment.community ?? ''}
                              username={comment.author}
                              permlink={comment.permlink}
                              contentMuted={comment.stats?.gray ?? false}
                              discussionPermlink={parentPermlink}
                              discussionAuthor={parentAuthor}
                              temporaryDisable={comment.stats?._temporary}
                            />
                          ) : null}
                          {/* ★ E2, REVISED 2026-08-12 (owner ruling) — Block reachable
                              from the comment itself, not only from a popover triggered
                              by clicking the author's name. This used to be two items,
                              Mute and Blacklist; the owner's ruling collapsed them into
                              the one control that already does both of what those two
                              were trying to do, plus the part neither of them could
                              (hiding the blocked account's replies under the viewer's
                              OWN content from every other reader — see
                              `lib/lite/social/block-service.ts`). Hidden (not disabled)
                              for the same reason Mute/Blacklist were: a lite comment's
                              `comment.author` is the shared publishing account, not a
                              blockable person — `useLumenBlock`'s own "not yourself"
                              check covers the rest. */}
                          {block.available ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={t('profile.overflow_menu_label')}
                                  className="flex items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                                  data-testid="comment-card-footer-overflow"
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52">
                                <DropdownMenuItem
                                  onClick={handleBlockClick}
                                  disabled={block.busy}
                                  className="cursor-pointer text-destructive focus:text-destructive"
                                  data-testid="comment-block-menu-item"
                                >
                                  {block.isBlocking
                                    ? t('user_profile.unblock_button')
                                    : t('user_profile.block_button')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      )}
                    </CardFooter>
                    {reply && user && user.isLoggedIn ? (
                      <div className="px-2 pb-2">
                        <ReplyTextbox
                          editMode={false}
                          onSetReply={setReply}
                          username={comment.author}
                          permlink={comment.permlink}
                          storageId={replyStorageId}
                          comment=""
                          discussionAuthor={discussionAuthor}
                          discussionPermlink={discussionPermlink}
                          observer={observer}
                        />
                      </div>
                    ) : null}
                  </AccordionContent>
                </Card>
                {/* Children rendered without AccordionContent so replies are always visible even when parent is hidden */}
                {children ? <div className="h-fit p-0">{children}</div> : null}
              </AccordionItem>
            </Accordion>
          </div>
        </li>
      ) : currentDepth === 8 ? (
        <div className="h-8">
          <Link
            href={`/${comment.category}/@${displayAuthor}/${comment.permlink}`}
            className="text-destructive"
          >
            {t('cards.comment_card.load_more')}...
          </Link>
        </div>
      ) : null}
    </>
  );
});

export default CommentListItem;
