'use client';

import { Icons } from '@hive/ui/components/icons';
import parseDate from '@hive/ui/lib/parse-date';
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from '@hive/ui/components/card';
import { cn } from '@hive/ui/lib/utils';
import { Link } from '@hive/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
import { Separator } from '@ui/components/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@ui/components/accordion';
import { Popover, PopoverContent } from '@ui/components/popover';
// ★ `PopoverAnchor` is not re-exported by `@ui/components/popover` (only
// `Popover`/`PopoverTrigger`/`PopoverContent` are). Importing the primitive
// directly for the one piece the wrapper does not carry is already this
// directory's own pattern — `copy-from-input.tsx` imports `@radix-ui/react-label`
// the same way, `dialog-login.tsx` imports `@radix-ui/react-visually-hidden` —
// so this is not a new precedent. See the long note above `downvoteWeightOpen`
// for why an Anchor (not a Trigger) is what this needs.
import { PopoverAnchor } from '@radix-ui/react-popover';
import { Slider } from '@ui/components/slider';
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
import { memo, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import DetailsCardVoters from '@/blog/features/post-rendering/details-card-voters';
import { ReplyTextbox } from '../post-editor/reply-textbox';
import DetailsCardHover from '../list-of-posts/details-card-hover';
import { IFollowList, Entry } from '@hive/common-hiveio-packages/wax';
import clsx from 'clsx';
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
import PostedViaLumen from './posted-via-lumen';
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
import { fetchListVotesByCommentVoter } from '@/blog/lib/chain-fetch';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';
import { useVoteMutation } from '@/blog/features/votes/hooks/use-vote-mutation';
import { useLoggedUserContext } from '@/blog/features/votes/hooks/use-logged-user';
import { BladeGlyph } from '@/blog/features/votes/blade';
import { authorTitleOf } from '@/blog/lib/author-title';

interface CommentListProps {
  permissionToMute: Boolean;
  comment: Entry;
  parent_depth: number;
  mutedList: IFollowList[];
  /** True when the viewer's mute-list read failed (React Query's retries
   *  exhausted) — see `content.tsx`'s `mutedListUnknown` doc comment. Threaded
   *  down from there through `CommentsSection` -> `CommentList`, alongside
   *  `mutedList` itself. */
  mutedListUnknown?: boolean;
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
// ★★★ COMMENTS ARE NOW LORA, LIKE POST BODIES (2026-08-13, typography audit
// item 3) — the ONE judgment call in this pass, flagged as such.
//
// This said `font-sanspro`, which LOOKED like it was selecting a third face
// ("Source Sans Pro") and in fact resolved, character for character, to the
// same `var(--font-sans)` stack as `font-sans` — Open Sans. So a reader
// scrolling out of the article and into the replies crossed a serif-to-sans
// switch that nobody chose: post bodies are Lora (`font-serif`, see
// `features/post-editor/lib/utils.ts`), replies were Open Sans. `font-sanspro`
// has since been deleted from the Tailwind config (audit item 4), so this had
// to name a real utility either way; `font-serif` is the one that matches the
// evident intent that Lora is this product's reading face.
//
// What deliberately did NOT change: the SIZE relationship. Audit item 3 asks
// for one reading typeface AND one reading size, but making replies the same
// 17px as the article is a hierarchy decision the owner has not made, so only
// the family was unified here. Sizes are the previous ones rounded to whole
// pixels (12.5/13.4/14.6 -> 13/14/15; the middle step would collide with the
// first at a straight round, so it goes up).
//
// Every size is paired with an explicit whole-pixel line-height. `prose` sets
// `line-height: 1.75` as a UNITLESS ratio, so 14.6px produced a 25.55px line
// box and every following block inherited the fractional offset; the new
// leadings (24/24/26px, and per-heading below) are that same rhythm rounded to
// the pixel grid — to an EVEN pixel, which is what keeps a centred flex row off
// the half pixel (see `typo-codemod2` reasoning: `(26-21)/2 = 2.5`). Paragraph margins likewise: `mb-[9.6px] mt-[1.6px]
// last:mb-[3.2px]` -> `10px / 2px / 4px` (audit item 8).
//
// ★★★ `text-[13px] leading-[24px]` IS NOT DEAD CODE — DO NOT DELETE IT
// (2026-08-13). The 2026-08-13 browser audit (§4.3) reported it as "one piece
// of dead code: the comment prose class still carries `text-[13px]
// leading-[24px]` while actually computing 15px / 26px. Something later in the
// cascade overrides it — delete the dead classes." It measured at a 1534px
// viewport, where `lg:` wins. It is the base step of the three-step responsive
// ramp described immediately above. Measured on the shipped build, same page,
// same element, four widths:
//
//     390px -> 13px / 24px      (base wins)
//     700px -> 14px / 24px      (`sm:` wins)
//     900px -> 14px / 24px      (`sm:` wins)
//    1200px -> 15px / 26px      (`lg:` wins)
//
// Deleting the base pair would hand every phone whatever `prose` defaults to
// and take the comment ramp's smallest step with it. The claim was checked and
// refused; leave the ramp intact.
// ★★★ THE COMMENT RAMP AFTER ALL-LORA (2026-08-19, typography spec §5.4).
//
// The ramp above is KEPT. The spec asks for a flat 16/24 and the enumeration
// proposed collapsing the three base steps to reach it — but the note directly
// above this one records that deleting the base pair was already proposed once,
// checked, and REFUSED, because it hands every phone whatever `prose` defaults
// to. A spec written without that history does not get to overrule it silently.
//
// What the spec DOES override is the values, and it has to: the old base step was
// 13px, and the 14px lowercase floor exists because Lora's x-height is 8% smaller
// than the sans it replaced, so 13px in Lora reads roughly as 12 did before.
// Every step therefore moves up while the structure stays:
//
//     phone   13/24  ->  14/24     (the floor, exactly)
//     sm      14/24  ->  15/24
//     lg      15/26  ->  16/24     (`text-body` — the spec's stated value)
//
// So the spec's number lands where most readers are, the ramp survives, and no
// step is below the floor. `lg:leading-[26px]` becomes 24 with it, because
// `text-body` is a paired size/leading token and splitting a pair is how this
// file's own history says fractional line boxes get in.
//
// ★ WHY THE FEED CARD'S DRAWER COMMENT IS 19px AND THIS IS 16px. They are not
// the same object. The drawer shows ONE chosen comment as a feature — the pull
// quote of the card, sized a step above the 18px excerpt it sits under. This is
// the full thread, many comments in sequence, where the job is density and an
// even reading rhythm. A magazine sets a pull quote larger than its body for the
// same reason. If they are ever unified, unify UP here, not down there.
//
// The in-body h1-h4 ramp is untouched: §5.4 gives no target for headings inside
// a comment, and inventing one to make the string tidy is not a spec.
export const commentClassName =
  'font-lora text-[14px] leading-[24px] prose-h1:text-[20px] prose-h1:leading-[22px] prose-h2:text-[18px] prose-h2:leading-[24px] prose-h3:text-[15px] prose-h3:leading-[24px] prose-h4:text-[14px] prose-h4:leading-[22px] sm:text-[15px] sm:leading-[24px] sm:prose-h1:text-[22px] sm:prose-h1:leading-[24px] sm:prose-h2:text-[20px] sm:prose-h2:leading-[26px] sm:prose-h3:text-[16px] sm:prose-h3:leading-[26px] sm:prose-h4:text-[15px] sm:prose-h4:leading-[22px] lg:text-body lg:prose-h1:text-[24px] lg:prose-h1:leading-[26px] lg:prose-h2:text-[20px] lg:prose-h2:leading-[28px] lg:prose-h3:text-[18px] lg:prose-h3:leading-[28px] lg:prose-h4:text-[16px] lg:prose-h4:leading-[24px] prose-p:mb-[10px] prose-p:mt-[2px] last:prose-p:mb-[4px] prose-img:max-w-full prose-img:h-auto prose-img:max-h-[400px]';

/**
 * ★★★ FOUR HONEST PUBLISH STATES, ONLY THE FIRST WITH A SPINNER (O7 F2a,
 * 2026-08-13). A real comment (`01KZW0GB585D9GQMWVHM7NNC3Q`) spun on
 * "Publishing..." for ~24 hours with no timeout, no error branch and no
 * terminal state — because `comment._optimistic` used to mean two different
 * things (see `db-post-to-entry.ts`'s own doc): "just broadcast, resolving in
 * seconds" on the CHAIN path (`use-comment-mutations.ts`), and "has never
 * been broadcast at all, possibly ever" on the LITE path (this component's
 * server-sourced comments, before `db-post-to-entry.ts`'s flag fix). One flag,
 * one spinner, two truths — a spinner is what reads as a hang, so every state
 * below the first loses it.
 *
 * `liteOverlay` (already computed above, for the byline) is the discriminator:
 * it is non-null ONLY for an entry that passed through the lite pipeline
 * (`isLumenProxiedEntry` — matches the `lumen-`/`lite-` permlink shapes or a
 * `lumen_post_id`/`lumen/1.0` marker in `json_metadata`), so a plain chain
 * comment's fresh client-side optimistic stub (`use-comment-mutations.ts`,
 * temp `re-<author>-<ts>` permlink, no lite marker) never matches it — that
 * path keeps its existing sub-30s "Publishing…" behaviour byte-identical, as
 * the Phase-2 adjudication's sequencing note requires.
 *
 * Thresholds (15 min / 6 h) are judgement, not measurement — O7's own build
 * map names them as such and recommends re-deriving them from real drain
 * timings once the publisher has actually run for a week.
 */
const PUBLISH_QUEUED_WINDOW_MS = 15 * 60 * 1000;
const PUBLISH_WAITING_WINDOW_MS = 6 * 60 * 60 * 1000;

type PublishBadgeState = 'publishing' | 'queued' | 'waiting' | 'delayed' | 'failed' | null;

function getPublishBadgeState(
  isOptimistic: boolean,
  isLitePipeline: boolean,
  createdIso: string,
  publishFailed = false
): PublishBadgeState {
  if (!isOptimistic) return null;
  // ★ FAILED OUTRANKS EVERY AGE-BASED STATE. The ladder below is a function of
  // how OLD the post is, so a publish that permanently failed simply aged into
  // "delayed" and sat there — a word that promises it will still land. It will
  // not: its publish generations are exhausted and it needs a human. Saying so
  // is the difference between a wait and a lie.
  if (publishFailed) return 'failed';
  // Chain path: a fresh client-side optimistic comment, not from the lite
  // pipeline at all. Unchanged from before this fix — still spinning, still
  // "Publishing...", still expected to resolve in seconds via
  // `scheduleValidatedRefetch`.
  if (!isLitePipeline) return 'publishing';

  const ageMs = Date.now() - new Date(createdIso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < PUBLISH_QUEUED_WINDOW_MS) return 'queued';
  if (ageMs < PUBLISH_WAITING_WINDOW_MS) return 'waiting';
  return 'delayed';
}

const PUBLISH_BADGE_COPY_KEY: Record<Exclude<PublishBadgeState, null>, string> = {
  publishing: 'global.publishing',
  queued: 'cards.comment_card.publish_queued',
  waiting: 'cards.comment_card.publish_waiting',
  delayed: 'cards.comment_card.publish_delayed',
  failed: 'cards.comment_card.publish_failed'
};

// ★ SAME localStorage KEY, SHAPE AND STABLE-REFERENCE REQUIREMENT as
// votes-component.tsx's own `DEFAULT_VOTES_VALUES` (module-scope there too,
// not exported, so duplicated here) — `useStorageWithTTL`'s own doc comment
// asks for a stable reference for object initial values, which an inline
// literal inside the component body would not be. Reading/writing the SAME
// `'votesValues'` key means the remembered downvote weight follows the reader
// between this menu and the inline arrow on a post.
const DEFAULT_DOWNVOTE_STORAGE_VALUES = {
  post: { upvote: [100], downvote: [100] },
  comment: { upvote: [100], downvote: [100] }
};
const DEFAULT_DOWNVOTE_WEIGHT = [100];

const CommentListItem = memo(function CommentListItem({
  permissionToMute,
  comment,
  parent_depth,
  mutedList,
  mutedListUnknown,
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
  const { user, sessionUnavailable } = useUserClient();
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
  // See the four-state badge doc above `commentClassName`.
  const publishBadgeState = getPublishBadgeState(!!comment._optimistic, !!liteOverlay, comment.created, !!comment._publishFailed);

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

  /**
   * ★★★ DOWNVOTE MOVED INTO THE "···" OVERFLOW MENU (2026-08-16, spec "Demote
   * the downvote to an overflow-menu action", comment surface).
   *
   * The inline down arrow is already gone from the row below — `VotesComponentWrapper`
   * never receives `showDownvote`, so it renders `VotesComponent`'s default
   * (`FEATURE_INLINE_DOWNVOTE`, currently `false` — see `features/votes/feature-flags.ts`).
   * This block gives the same ACTION a home in the existing overflow menu,
   * reusing exactly what the inline arrow used to open rather than inventing a
   * second one:
   *
   *   · `useVoteMutation` — the SAME mutation `votes-component.tsx`'s own
   *     `submitVote` calls, so a cast from here shows the same toast, the same
   *     optimistic `stats.total_votes` bump (`use-vote-mutation.ts`), and the
   *     same manabar/discussion invalidations.
   *   · the SAME `['votes', author, permlink, voter]` React Query cache key
   *     `VotesComponentWrapper` right below already subscribes to — casting
   *     here and reading there can never disagree, and `useVoteMutation`'s own
   *     `onMutate` writes straight into that key, so this component's own
   *     `vote_downvoted` (derived from the same key, below) updates the instant
   *     a click here resolves, with no extra plumbing.
   *   · the SAME copy: `cards.post_card.downvote_warning`/`reason_1..4` for the
   *     weight popover, `vote_removal_dialog.remove_downvote_*` for the undo
   *     confirmation — the exact strings the inline arrow's own popover and
   *     `VoteRemovalDialog` already show.
   *
   * ★ WHY NOT PUPPET `VotesComponent` ITSELF FROM HERE, RATHER THAN REBUILDING
   * THE POPOVER/DIALOG MARKUP. `showDownvote: false` does not just hide the
   * down side with CSS — `feature-flags.ts`'s own note says it is "omitted from
   * the tree entirely" — so there is no mounted Popover or VoteRemovalDialog
   * instance anywhere to reach into, and neither one exposes a controlled
   * `open` prop back to a caller even when it IS mounted (`VoteRemovalDialog`
   * owns its `open` state internally; the weight popover in `votes-component.tsx`
   * is a bare uncontrolled `<Popover>`). Rule 2 for this surface is exactly
   * that gap: a dialog opened from a menu item needs its open state owned
   * OUTSIDE the menu, with an explicit place to send focus back to on close —
   * which an opaque, unreachable internal instance cannot offer no matter how
   * it is triggered. So the Popover/AlertDialog below are assembled from the
   * SAME primitives (`@ui/components/popover`, `@ui/components/alert-dialog`,
   * `Slider`, `useVoteMutation`, `useLoggedUserContext`) `votes-component.tsx`
   * itself is built from, controlled by state that lives on THIS component,
   * rather than a second, divergent implementation of "ask before downvoting".
   */
  const voter = identity.username;
  const isLiteVoter = user.account_tier === 'lite';
  // Same non-answer-vs-zero trap `votes-component.tsx`'s own `tierPending` note
  // documents at length: on a cold tab, signed in per the server cookie with no
  // client seed yet, `user.account_tier` cannot be trusted either way. Blocks
  // the mutation, not the menu item's visibility — an item that is briefly
  // unclickable is honest; one that fires down the wrong tier's path is not.
  const tierPending =
    identity.isLoggedIn && !identity.clientAnswered && !user.isLoggedIn && !sessionUnavailable;
  const downvoteMutation = useVoteMutation();
  const voteActionDisabled = downvoteMutation.isLoading || tierPending;

  // ★ THE SSR FALLBACK, SAME FIELD `vote-tallies.ts` READS. `comment.active_votes`
  // is already on this `Entry` with no extra fetch — the sign of `rshares` on
  // this voter's row is the same fact `votes-component.tsx` falls back to
  // before its own `userVotes` query has answered.
  const checkCommentVote = comment.active_votes?.find((v) => v.voter === voter);
  // Mirrors `clickedVoteButton` in votes-component.tsx: the confirmed-vote query
  // is enabled once there is SOMETHING to confirm (an SSR-known vote) or once
  // this reader has actually touched the menu's downvote action this session —
  // not on every mount, which would be one more `/api/comment-vote` request per
  // rendered comment for no reason.
  const [downvoteMenuActivated, setDownvoteMenuActivated] = useState(false);
  const { data: myCommentVotes } = useQuery({
    queryKey: ['votes', comment.author, comment.permlink, voter],
    queryFn: () =>
      isLiteVoter
        ? fetchLiteEngagement(comment.author, comment.permlink)
        : fetchListVotesByCommentVoter(comment.author, comment.permlink, voter),
    enabled: isLiteVoter ? !!voter : !!checkCommentVote || downvoteMenuActivated,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false
  });
  const myCommentVote =
    myCommentVotes?.votes[0] && myCommentVotes.votes[0].voter === voter
      ? myCommentVotes.votes[0]
      : undefined;
  // Precedence matches `myVote` in votes-component.tsx exactly, and for the
  // same reason: `myCommentVote` is the one that goes optimistic the instant a
  // click resolves and the only one that can represent "I just withdrew";
  // `checkCommentVote` still holds the stale chain row at that moment.
  const vote_downvoted = myCommentVote
    ? myCommentVote.vote_percent < 0
    : checkCommentVote
      ? Number(checkCommentVote.rshares) < 0
      : false;

  const { net_vests, vestsKnown } = useLoggedUserContext();
  // ★ DUPLICATED FROM `votes-component.tsx`'s own `VOTE_WEIGHT_DROPDOWN_THRESHOLD`
  // (not exported there) — kept identical so the SAME account sees the SAME
  // one-shot-vs-picker behaviour whichever surface it downvotes a comment from.
  // If that threshold ever changes, this one must change with it.
  const DOWNVOTE_WEIGHT_DROPDOWN_THRESHOLD = 1.0 * 1000.0 * 1000.0;
  const enableDownvoteSlider = !vestsKnown || net_vests > DOWNVOTE_WEIGHT_DROPDOWN_THRESHOLD;

  // See `DEFAULT_DOWNVOTE_STORAGE_VALUES` above for why the key/shape match
  // votes-component.tsx's own (unexported) `storedVotesValues`.
  const [storedDownvoteWeights, storeDownvoteWeights] = useStorageWithTTL(
    'votesValues',
    DEFAULT_DOWNVOTE_STORAGE_VALUES,
    StorageTTL.PERMANENT
  );
  const [sliderDownvote, setSliderDownvote] = useState<number[]>(
    storedDownvoteWeights?.comment?.downvote ?? DEFAULT_DOWNVOTE_WEIGHT
  );
  useEffect(() => {
    setSliderDownvote(storedDownvoteWeights?.comment?.downvote ?? DEFAULT_DOWNVOTE_WEIGHT);
  }, [storedDownvoteWeights]);

  const submitCommentDownvote = async (weight: number) => {
    if (tierPending) return;
    try {
      await downvoteMutation.mutateAsync({ voter, author: comment.author, permlink: comment.permlink, weight });
    } catch (error) {
      handleError(error, {
        method: 'commentDownvote',
        params: { voter, author: comment.author, permlink: comment.permlink, weight }
      });
    }
  };

  /**
   * ★ RULE 2 — NEVER NEST A RADIX DIALOG INSIDE A DropdownMenuItem. Selecting
   * the item does NOT open anything synchronously: `onSelect` is left to close
   * the menu via Radix's own default behaviour (not prevented), and the
   * Popover/AlertDialog below — both driven by state this component owns, not
   * the menu — are opened a tick later via `setTimeout(…, 0)`. This is the
   * documented workaround for the exact failure mode rule 2 names: opening a
   * Dialog/Popover in the SAME tick the menu unmounts races the menu's own
   * focus-return against the new overlay's focus-trap, and the menu wins,
   * leaving the "just-opened" dialog with no focus inside it. Deferring one
   * tick lets the menu's close (and its own focus handling) finish first.
   */
  const handleDownvoteSelect = () => {
    setDownvoteMenuActivated(true);
    if (vote_downvoted) {
      setTimeout(() => setDownvoteRemovalOpen(true), 0);
    } else if (enableDownvoteSlider) {
      setTimeout(() => setDownvoteWeightOpen(true), 0);
    } else {
      // Same as votes-component.tsx's own one-shot branch (below the vests
      // threshold): no popover, no dialog, a single full-power cast.
      void submitCommentDownvote(-10000);
    }
  };

  // ★ STATE OWNED BY THIS COMPONENT, NOT THE MENU (rule 2). `moreTriggerRef` is
  // what `onCloseAutoFocus` below sends focus back to on Cancel/Escape/confirm
  // (rule 3) — Radix's own default would return focus to whatever had it when
  // the overlay opened, which after the `setTimeout` above is unpredictable
  // (the closing menu may already have cleared it), so this is explicit rather
  // than relied upon.
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const [downvoteWeightOpen, setDownvoteWeightOpen] = useState(false);
  const [downvoteRemovalOpen, setDownvoteRemovalOpen] = useState(false);
  const returnFocusToOverflowTrigger = (event: Event) => {
    event.preventDefault();
    moreTriggerRef.current?.focus();
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
  /**
   * What the READER sees, and therefore what the stub's label and reason must
   * agree with. `openState` is what the Accordion actually renders from, so it
   * is the authority; `hiddenComment` remains only as the moderation FLAG that
   * decides whether a stub is offered at all (line ~579), never as a second
   * opinion about whether the body is on screen.
   */
  const collapsed = openState !== 'item-1';
  const [tempraryHidden, setTemporaryHidden] = useState(false);
  // ★ BUG 1 FIX (2026-08-12, FX3) — local, per-comment, same reasoning
  // `medium-post-card.tsx`'s own `moderationRevealed` gives for its own copy of
  // this state: a reader who reveals ONE unknown-status comment has not thereby
  // vouched for every other comment sharing this page's single, page-level
  // mute-list query. See the gate below, right before `userModerationHidden`.
  const [moderationRevealed, setModerationRevealed] = useState(false);
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
  // ★ BUG 1 FIX (2026-08-12, FX3) — "the mute-unknown fix reached the post card
  // but never the comment thread." `isMutedByViewer` above (`mutedList?.some(...)`)
  // reads `false` on an empty or unresolved `mutedList`, exactly like `isMuted` in
  // `use-moderation-status.ts` did before its own fix — an "unknown" mute-list read
  // and a "confirmed nobody muted" read are the same expression. Without this gate,
  // a muted account's comment renders in full, unlabelled, during a fetch hiccup —
  // directly contradicting the owner's "gone, no collapse, no Reveal" ruling below,
  // which only holds if the mute check actually ran.
  //
  // Ordered BEFORE `userModerationHidden`: this can't tell WHICH author on this page
  // is muted (the read that would answer that is the one that failed), so every
  // comment degrades the same way while the page-level mute-list query is unresolved
  // — matching `medium-post-card.tsx`'s DEFECT-2 fix on the sibling surface exactly
  // (same shape: neutral "we don't know" card + explicit Reveal, never a silent
  // "clean" render and never a silent hide). Children are withheld too, same
  // reasoning as `userModerationHidden`'s own cascade below: a reply routinely
  // quotes what it answers, and until the mute status resolves we don't yet know
  // whether the parent should be shown at all.
  if (mutedListUnknown && !moderationRevealed) {
    return (
      <li data-testid="comment-list-item" className="lm-enter w-full min-w-0">
        <div
          className="mb-4 flex w-full min-w-0 flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-line-18 bg-surface-14 px-3 py-2.5 font-sans text-caption text-ink-10"
          data-testid="comment-moderation-unknown"
        >
          <span>{t('cards.comment_card.moderation_status_unknown', { author: displayAuthor })}</span>
          <button
            type="button"
            onClick={() => setModerationRevealed(true)}
            className="font-semibold text-ink-4 underline-offset-2 hover:underline"
            data-testid="comment-moderation-unknown-reveal"
          >
            {t('cards.comment_card.moderation_status_unknown_reveal')}
          </button>
        </div>
      </li>
    );
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
        <li data-testid="comment-list-item" className="lm-enter w-full min-w-0">
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
                    `mb-4 w-full min-w-0 overflow-hidden rounded-card border-line-9 bg-surface-1 text-primary depth-${comment.depth}`,
                    {
                      'opacity-50 hover:opacity-100': hiddenComment || tempraryHidden,
                      'border border-destructive': comment._temporary,
                      'border border-line-info-2/50': comment._optimistic
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
                        <div className="flex w-full items-center justify-between text-caption sm:text-sm">
                          <div className="flex flex-wrap items-center">
                            {comment._temporary && !comment._optimistic ? (
                              <div className="flex items-center font-bold hover:cursor-pointer hover:text-destructive">
                                {displayAuthor}
                              </div>
                            ) : (
                              <>
                                {publishBadgeState && (
                                  <span
                                    className={cn('mr-2 flex items-center gap-1 text-caption', {
                                      'text-ink-info-9': publishBadgeState === 'publishing' || publishBadgeState === 'queued',
                                      'text-muted-foreground': publishBadgeState === 'waiting',
                                      'text-ink-warn-6': publishBadgeState === 'delayed'
                                    })}
                                    data-testid="comment-publish-status"
                                    data-publish-state={publishBadgeState}
                                  >
                                    {/* Spinner on the FIRST state only — a spinner is what
                                        reads as a hang, and everything past "just broadcast,
                                        resolving in seconds" is a calm, static sentence. */}
                                    {publishBadgeState === 'publishing' && (
                                      <CircleSpinner size={10} color="#3b82f6" loading />
                                    )}
                                    {t(PUBLISH_BADGE_COPY_KEY[publishBadgeState])}
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
                                {/* ★ author_title badge removed (2026-08-16, spec). ChangeTitleDialog stays:
                                    it is the moderator's set_label write control, not the display. */}
                                <ChangeTitleDialog
                                  permlink={parentPermlink}
                                  moderateEnabled={permissionToMute}
                                  userOnList={comment.author}
                                  title={authorTitleOf(comment)}
                                  community={comment.community ?? ''}
                                />
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
                                    className="whitespace-nowrap text-caption text-muted-foreground"
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
                                className="cursor-pointer whitespace-nowrap text-caption sm:text-sm"
                                // ★★★ ONE SOURCE OF TRUTH (2026-08-13, reported: the
                                // stub read "Hide Comment" while `aria-expanded="false"`,
                                // and the filter reason never appeared).
                                //
                                // This span used to carry its OWN `onClick` toggling
                                // `hiddenComment`, nested inside an `AccordionTrigger`
                                // whose click toggles `openState`. A click on the span
                                // bubbled and moved BOTH; a click anywhere else on the
                                // trigger moved only `openState`. Two states for one row,
                                // so they desynced — and because the label AND the
                                // "(reason)" beside it were keyed off `hiddenComment`
                                // while the actual collapse is driven by `openState`, the
                                // row ended up labelled "Hide Comment" while collapsed,
                                // with its explanation hidden. The reason strings were
                                // wired all along; they were gated on the wrong state.
                                //
                                // The trigger is the only thing that toggles now, and
                                // everything the reader sees is derived from `openState`.
                              >
                                {collapsed
                                  ? t('cards.comment_card.reveal_comment')
                                  : t('cards.comment_card.hide_comment')}
                                {collapsed && (
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
                              {collapsed && hiddenReasonListHref && identity.isLoggedIn ? (
                                <Link
                                  href={hiddenReasonListHref}
                                  className="whitespace-nowrap text-caption text-muted-foreground underline-offset-2 hover:text-destructive hover:underline sm:text-sm"
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
                            className="flex h-5 items-center gap-2 text-caption sm:text-sm"
                            data-testid="comment-card-footer"
                          >
                            <VotesComponentWrapper post={comment} type="comment" />

                            <DetailsCardHover
                              post={comment}
                              decline={parseFloat(comment.max_accepted_payout) === 0}
                              className="order-last ml-auto flex min-w-[88px] items-center justify-end text-[15px] font-bold tabular-nums text-[color:rgb(var(--ink-payout))]"
                            >
                              <div
                                data-testid="comment-card-footer-payout"
                                className={clsx(
                                  /* ★★★ THE SECOND FOOTER. THE 2026-08-21 FIX ONLY REACHED THE
                                     OTHER ONE (corrected 2026-08-23, owner: "why is the comment
                                     payout still in the same place on the left").

                                     This file renders TWO comment footers, both carrying
                                     `data-testid="comment-card-footer"`: the `CardFooter` below,
                                     and THIS one, which is the COLLAPSED comment's row. The owner
                                     report ("the value needs to be on the right like on posts,
                                     like on feeds") and the money-colour fix from the same report
                                     were both applied to the other site only, so every collapsed
                                     comment kept the exact layout that was reported - payout
                                     second of three, between the vote control and the reply
                                     count, and hovering RED like an error rather than reading as
                                     money.

                                     Same three properties as the sibling, deliberately identical:
                                     `order-last ml-auto` puts it at the row's right edge,
                                     `font-medium` is the requested Lora weight, and the payout ink
                                     stops it inheriting near-black and hovering to --destructive. */
                                  'order-last ml-auto flex min-w-[88px] items-center justify-end text-[15px] font-bold tabular-nums text-[color:rgb(var(--ink-payout))] hover:cursor-pointer',
                                  {
                                    'line-through opacity-50': parseFloat(comment.max_accepted_payout) === 0
                                  }
                                )}
                              >
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
                          /* ★ min-w-[24px] FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA
                              2.5.8). This trigger renders no children of its own — the
                              chevron icon (h-4 w-4) is the only content — so its width was
                              exactly the icon's 16px with zero horizontal padding. Height
                              was already 28px (py-4/pt-1 puts it above the 24px floor), so
                              only the width needed a floor. Measured across all 5 comment
                              threads on a live post: with `min-w-[24px]` applied, the
                              enclosing `<h3>` row and the comment card's own height were
                              byte-identical before and after (see comment-card-footer's own
                              note two screens up for the same measurement discipline). The
                              mobile counterpart just below (`sm:hidden`) is NOT touched here
                              — at a 390px viewport it measures 16x20 too, but there the
                              parent row hugs it tightly and grows 4px per comment when
                              enlarged, a real (if modest) cost this pass did not get
                              sign-off to spend. */
                          className="mr-2 hidden min-w-[24px] pb-0 pt-1 !no-underline sm:block"
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
                        <>
                        <CardDescription data-testid="comment-card-description">
                          <RendererContainer
                            body={comment.body}
                            author={comment.author}
                            permlink={comment.permlink}
                            className={commentClassName}
                          />
                        </CardDescription>
                        {/* ★ "posted via lumen", under the comment body and above its action row —
                            the same line the post page carries, from the same component so the two
                            cannot drift. Renders nothing for a comment Lumen did not publish. */}
                        <PostedViaLumen entry={comment} className="mt-2" />
                        </>
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
                          className="flex flex-wrap items-center gap-2 pt-1 text-caption sm:text-sm"
                          data-testid="comment-card-footer"
                        >
                          <VotesComponentWrapper post={comment} type="comment" />
                          <DetailsCardHover
                            post={comment}
                            decline={parseFloat(comment.max_accepted_payout) === 0}
                            className="order-last ml-auto flex min-w-[88px] items-center justify-end text-[15px] font-bold tabular-nums text-[color:rgb(var(--ink-payout))]"
>
                            <div
                              data-testid="comment-card-footer-payout"
                              className={clsx(
                                /* ★ Money is green, and it does not go RED under the pointer (2026-08-20,
                                   owner report). This inherited near-black and hovered to --destructive, so
                                   the one figure on the row that is money looked like body text until you
                                   touched it and then looked like an error. */
                                /* ★★ ON THE RIGHT, LIKE EVERY OTHER PAYOUT (2026-08-21, owner: "comments
                                   started mixing up the payout for comments with all the icons. the value
                                   needs to be on the right like on posts, like on feeds").
                                
                                   It sat SECOND of four in this flex row — between the vote control and the
                                   vote count — so the one figure on the row that is money read as just
                                   another icon label. `ml-auto` is what the feed card uses to push its payout
                                   to the card's right edge; `order-last` is what keeps it there, because this
                                   element is not last in the markup and `ml-auto` alone would drag the vote
                                   count and Reply across with it.
                                
                                   ★ MEDIUM, NOT NORMAL (same report): "the payouts need to be medium, not
                                   normal to give them a little bit of Lora font boldness." 400 -> 500. */
                                'order-last ml-auto flex min-w-[88px] items-center justify-end text-[15px] font-bold tabular-nums text-[color:rgb(var(--ink-payout))] hover:cursor-pointer',
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
                                  {/* ★ whitespace-nowrap + tabular-nums (2026-08-13,
                                      reported). `votes` is ONE interpolated string
                                      ("{{votes}} votes"), so with no nowrap the row's
                                      `flex-wrap` was free to break it between the number
                                      and the word once the count reached 4 digits and the
                                      line ran out of room — the number wrapping up onto
                                      the payout's line and reading as if it overlapped.
                                      tabular-nums additionally stops the digits changing
                                      width as the count revalidates. */}
                                  <span className="whitespace-nowrap tabular-nums hover:text-destructive">
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
                          {/* ★ min-h-[24px] FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA
                              2.5.8). 35.8x22 measured — width was already fine, only the
                              22px line-height-driven height failed. Measured across 5
                              comment footers: the row (`comment-card-footer`, h-5 but
                              governed by taller siblings) and the comment card itself were
                              unchanged, 0px cost, same as the "More options" trigger below. */}
                          {identity.isLoggedIn ? (
                            <button
                              disabled={deleteCommentMutation.isLoading}
                              onClick={() => setReply(!reply)}
                              className="flex min-h-[24px] items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
                              data-testid="comment-card-footer-reply"
                            >
                              {t('cards.comment_card.reply')}
                            </button>
                          ) : (
                            <DialogLogin>
                              <button
                                className="flex min-h-[24px] items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
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
                              className="flex min-h-[24px] items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
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
                                className="flex min-h-[24px] items-center text-foreground/60 hover:cursor-pointer hover:text-destructive"
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
                          {block.available || block.unknown ? (
                            <>
                              {/* ★ THE POPOVER WRAPS THE TRIGGER (not the other way round)
                                  so `PopoverAnchor` and `PopoverContent` share one `<Popover>`
                                  root — Popper positions off the Anchor's ref, not DOM
                                  nesting order, so the DropdownMenu living between them here
                                  is fine. `PopoverAnchor` only registers a position; unlike
                                  `PopoverTrigger` it adds no click handler, so clicking "···"
                                  for Block never also toggles this popover — only
                                  `handleDownvoteSelect` (via `downvoteWeightOpen`) does. */}
                              <Popover open={downvoteWeightOpen} onOpenChange={setDownvoteWeightOpen}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <PopoverAnchor asChild>
                                      <button
                                        ref={moreTriggerRef}
                                        type="button"
                                        aria-label={
                                          vote_downvoted
                                            ? t('cards.comment_card.overflow_menu_label_downvoted')
                                            : t('profile.overflow_menu_label')
                                        }
                                        className={cn(
                                          // ★ min-h/min-w-[24px] FOR THE HIT TARGET (2026-08-19,
                                          // WCAG 2.2 AA 2.5.8). No children besides the h-4 w-4
                                          // icon and no padding, so the box was exactly 16x16.
                                          // Measured across all 4 comments on this thread that
                                          // render this trigger (plus the post's own overflow
                                          // trigger, same fix, `content.tsx`): the footer row and
                                          // the comment card's height were unchanged, 0px cost.
                                          'flex min-h-[24px] min-w-[24px] items-center justify-center hover:cursor-pointer hover:text-destructive',
                                          // ★ item 4: colour alone is not an accessible signal —
                                          // the aria-label above already carries the same fact —
                                          // this is the SAME slate `--lm-vote-slate` resolves to
                                          // for a cast downvote in `vote-control.module.css`
                                          // (`.down.mine`), duplicated as literals because that
                                          // custom property is scoped to `VotesComponent`'s own
                                          // `.root` element, a sibling of this button, not an
                                          // ancestor — `var()` would not inherit across to here.
                                          vote_downvoted
                                            ? 'text-[#5b6470] dark:text-[#a3adba]'
                                            : 'text-foreground/60'
                                        )}
                                        data-testid="comment-card-footer-overflow"
                                      >
                                        <Icons.moreHorizontal className="h-4 w-4" />
                                      </button>
                                    </PopoverAnchor>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-52">
                                    {identity.isLoggedIn ? (
                                      <>
                                        {/* ★ item 5: no destructive classes here — Downvote is
                                            not styled destructive-red, unlike Block below. */}
                                        <DropdownMenuItem
                                          onSelect={handleDownvoteSelect}
                                          disabled={voteActionDisabled}
                                          className="cursor-pointer"
                                          data-testid="comment-downvote-menu-item"
                                        >
                                          {vote_downvoted
                                            ? t('cards.comment_card.remove_downvote')
                                            : t('cards.comment_card.downvote')}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                      </>
                                    ) : null}
                                    {block.available ? (
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
                                    ) : (
                                      // `unknown`, not `available`: the read failed rather than
                                      // "this pair cannot be blocked" (use-lumen-block.ts). A
                                      // disabled item that says so, not a vanished menu, is the
                                      // honest answer during a backend outage.
                                      <DropdownMenuItem
                                        disabled
                                        className="cursor-not-allowed"
                                        data-testid="comment-block-menu-item-unknown"
                                        title={t('user_profile.block_status_unknown_hint')}
                                      >
                                        {t('user_profile.block_status_unknown')}
                                      </DropdownMenuItem>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                                {/* The weight picker — same Slider, same warning copy, same
                                    reasons list the inline arrow's popover showed. Confirming
                                    closes this popover explicitly (the original branch swaps
                                    to the removal dialog once `vote_downvoted` flips instead,
                                    which this component cannot do without unmounting the whole
                                    Popover mid-open). */}
                                <PopoverContent
                                  className="z-50 max-w-xs rounded-lg bg-background-secondary p-4 shadow-lg"
                                  align="end"
                                  onCloseAutoFocus={returnFocusToOverflowTrigger}
                                  data-testid="comment-downvote-slider-popover"
                                >
                                  <div className="flex h-full items-center gap-2">
                                    <button
                                      type="button"
                                      data-testid="comment-downvote-slider-confirm"
                                      aria-label={t('cards.post_card.downvote')}
                                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground/70 hover:text-[#5b6470] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:hover:text-[#a3adba]"
                                      disabled={voteActionDisabled}
                                      onClick={() => {
                                        void submitCommentDownvote(-sliderDownvote[0] * 100);
                                        storeDownvoteWeights((prev) => ({
                                          ...prev,
                                          comment: { ...prev.comment, downvote: sliderDownvote }
                                        }));
                                        setDownvoteWeightOpen(false);
                                      }}
                                    >
                                      {/* Same blade glyph the inline arrow used, rotated the
                                          same 180° `.down svg` applies in vote-control.module.css
                                          — reproduced with a plain transform since that module's
                                          rotation rule is scoped to a class this button does not
                                          carry (see the colour note above). */}
                                      <span className="inline-block rotate-180">
                                        <BladeGlyph />
                                      </span>
                                    </button>
                                    <Slider
                                      dataTestId="comment-downvote-slider"
                                      defaultValue={sliderDownvote}
                                      value={sliderDownvote}
                                      min={1}
                                      className="w-36"
                                      onValueChange={(v: number[]) => setSliderDownvote(v)}
                                    />
                                    <div
                                      className="w-fit text-destructive"
                                      data-testid="comment-downvote-slider-percentage-value"
                                    >
                                      -{sliderDownvote}%
                                    </div>
                                  </div>
                                  <div
                                    className="flex flex-col gap-1 pt-2 text-sm"
                                    data-testid="comment-downvote-description-content"
                                  >
                                    <p>{t('cards.post_card.downvote_warning')}</p>
                                    <ul>
                                      <li>{t('cards.post_card.reason_1')}</li>
                                      <li>{t('cards.post_card.reason_2')}</li>
                                      <li>{t('cards.post_card.reason_3')}</li>
                                      <li>{t('cards.post_card.reason_4')}</li>
                                    </ul>
                                  </div>
                                </PopoverContent>
                              </Popover>

                              {/* Undo confirmation — same title/description/button copy as
                                  `VoteRemovalDialog(voteType="downvote")`. That component is
                                  not reused directly here because it owns its OWN trigger and
                                  `open` state with no external control point; rule 2 needs the
                                  open state owned by this component instead, so this is a
                                  controlled AlertDialog built from the same primitives and the
                                  same `vote_removal_dialog.*` keys. */}
                              <AlertDialog open={downvoteRemovalOpen} onOpenChange={setDownvoteRemovalOpen}>
                                <AlertDialogContent
                                  className="flex flex-col gap-8 sm:rounded-r-xl"
                                  onCloseAutoFocus={returnFocusToOverflowTrigger}
                                >
                                  <AlertDialogHeader className="gap-2">
                                    <div className="flex items-center justify-between">
                                      <AlertDialogTitle data-testid="comment-downvote-removal-dialog-header">
                                        {t('vote_removal_dialog.remove_downvote_title')}
                                      </AlertDialogTitle>
                                      <AlertDialogCancel
                                        className="border-none hover:text-ink-brand-3"
                                        data-testid="comment-downvote-removal-dialog-close"
                                      >
                                        X
                                      </AlertDialogCancel>
                                    </div>
                                    <AlertDialogDescription data-testid="comment-downvote-removal-dialog-description">
                                      {t('vote_removal_dialog.remove_downvote_description')}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
                                    <AlertDialogCancel
                                      className="hover:text-ink-brand-3"
                                      data-testid="comment-downvote-removal-dialog-cancel"
                                    >
                                      {t('vote_removal_dialog.cancel')}
                                    </AlertDialogCancel>
                                    <AlertDialogAction
                                      autoFocus
                                      className="rounded-none bg-surface-39 text-base text-ink-27 shadow-lg shadow-destructive hover:bg-destructive hover:shadow-line-26 disabled:bg-surface-34 disabled:shadow-none"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        void submitCommentDownvote(0);
                                        setDownvoteRemovalOpen(false);
                                      }}
                                      data-testid="comment-downvote-removal-dialog-ok"
                                    >
                                      {t('vote_removal_dialog.confirm')}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </>
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
