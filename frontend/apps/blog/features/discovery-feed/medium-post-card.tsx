'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, AlertTriangle, ImageOff } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link, UserAvatarImg, DIRECT_TIMEOUT_MS } from '@hive/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
import { Popover, PopoverTrigger, PopoverContent } from '@ui/components/popover';
import { Slider } from '@ui/components/slider';
import { useTranslation } from '@/blog/i18n/client';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { cn } from '@ui/lib/utils';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLumenBlock } from '@/blog/lib/lite/client/use-lumen-block';
import { getPostSummary, normalizeTitle } from '@/blog/lib/utils';
import { find_first_img } from '@/blog/features/list-of-posts/post-img';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { BladeGlyph, voteStyles } from '@/blog/features/votes/blade';
import { useVoteMutation } from '@/blog/features/votes/hooks/use-vote-mutation';
import type { MyVote } from '@/blog/features/votes/vote-tallies';
import { fetchListVotesByCommentVoter } from '@/blog/lib/chain-fetch';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';
import { ReblogDialog } from '@/blog/features/list-of-posts/reblog-dialog';
import { useReblogMutation } from '@/blog/features/list-of-posts/hooks/use-reblog-mutation';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import { LeagueByline } from '@/blog/features/retention/components/league-byline';
import type { RankMark } from '@/blog/features/retention/hooks/use-rank-marks';
import TokenAuthorChip from '@/blog/features/creator-tokens/ui/token-author-chip';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { isNsfwPost, useNsfwPreference } from '@/blog/lib/nsfw';
import { isNotePost } from '@/blog/lib/short-post-note';
import { useModerationStatus } from '@/blog/features/mute-follow/hooks/use-moderation-status';
import { classifyBlacklist } from '@/blog/lib/moderation/blacklist-reason';
import { isOwnModerationHide } from '@/blog/lib/muted-reasons';

// TODO: move to i18n
const LABELS = {
  in: 'in',
  reblog: 'Reblog',
  nsfwBadge: 'NSFW',
  nsfwNote: 'This post is marked NSFW.',
  nsfwReveal: 'Show anyway',
  nsfwHide: 'Hide again'
};

/**
 * Medium-style feed card for a single Hive post: a roomy text column with a
 * larger square thumbnail (only when the post actually has one), followed by
 * the FULL Hive controls row — real vote control (upvote/downvote + weight
 * slider), payout, upvote count, comments, and one-tap reblog. Medium's
 * cleanliness and spacing, Hive's actions. The controls are denser's own
 * components (`VotesComponentWrapper`, `ReblogDialog`, the card tooltips) so
 * voting/reblog behaviour stays identical to the classic feed.
 */
export default function MediumPostCard({ post, mark }: { post: Entry; mark?: RankMark }) {
  const { t } = useTranslation('common_blog');
  // ★ `sessionUnavailable` added alongside the pre-existing `user` (2026-08-16,
  // downvote-in-overflow-menu). Both feed `tierPending` below — see that
  // block's comment for why the raw client answer, not just `identity`, is
  // needed to submit a vote safely.
  const { user, sessionUnavailable } = useUserClient();
  /**
   * ★ GAP-2 FIX (owner ruling 2026-08-12, "Block does not render reliably").
   * `user.isLoggedIn` from raw `useUserClient()` cannot answer during SSR and
   * reports signed-out until `/api/users/me` returns — the same class of race
   * `server-session.tsx`'s big comment documents for the header, and the exact
   * reason a live enumeration of the profile dropdown found Block sometimes
   * absent from a signed-in session. `user` stays for everything else this card
   * already used it for (reblog author, chain follow lists); `identity` is used
   * ONLY to gate the new Block control below, so it renders on the first paint
   * instead of waiting on a client round trip.
   */
  const identity = useSessionIdentity();
  const reblogMutation = useReblogMutation();
  // A Lumen proxy post arrives from Hivemind authored by the shared publishing
  // account, so without this overlay a lite user's post shows the wrong name here.
  // No-op for ordinary Hive posts.
  const liteOverlay = useLiteOverlay(post);
  const displayAuthor = liteOverlay?.author ?? post.author;
  // ★ DECODE BEFORE DISPLAY (2026-08-13). Titles arrive from the chain exactly as
  // whatever client wrote them, and several Hive clients store HTML entities in
  // `json_metadata` — so `&#039;` and `&acute;` were printed literally on the card.
  // `normalizeTitle` decodes numeric and named entities and strips stray
  // markdown/HTML. It is the same helper `getPostSummary` now uses for the dek
  // below, so a title and its excerpt can no longer disagree about whether an
  // apostrophe is an apostrophe.
  const displayTitle = normalizeTitle(liteOverlay?.title || post.title);

  // ★ E1/E2/E4 (BUILDMAP-FUCKERY-V2, G3) — "muting a user currently does nothing".
  // Moderation acts on `post.author`, the account that actually signed on chain —
  // never `displayAuthor` — matching the rule `comment-list-item.tsx` and
  // `PostListItem` already follow. When a `liteOverlay` is present, `post.author` is
  // the SHARED publishing account behind every lite author, so offering Mute/
  // Blacklist here would silence that shared account for every lite writer, not just
  // this one — `useModerationStatus`'s `targetIsLite` hides the controls exactly the
  // way `ProfileActions`/`ButtonsContainer` already hide Mute for the same reason.
  // ★ STILL NEEDED (2026-08-12): `moderation.isMuted` and `moderation.muteStatusUnknown`
  // still decide whether this card renders (see the two gates below) — only its
  // Mute/Blacklist WRITE controls were removed from this card's overflow menu,
  // replaced by Block (owner ruling). `available`/`isBlacklisted`/`toggleMute`/
  // `toggleBlacklist`/`muteBusy`/`blacklistBusy` are no longer read here.
  const moderation = useModerationStatus(post.author, Boolean(liteOverlay));
  // NOT `post.blacklists.length > 0` — see `classifyBlacklist`'s doc for the measured
  // proof that Hivemind mixes a synthetic "reputation-N" token into that array for
  // any low/negative-reputation author with no list involved at all.
  const blacklistReason = classifyBlacklist(post.blacklists);
  const [moderationRevealed, setModerationRevealed] = useState(false);
  // ★ OWNER RULING 2026-08-12 — the post overflow menu's ONE moderation control is
  // Block, not separate Mute/Blacklist items (see comment-list-item.tsx for the
  // identical change and its reasoning). Acts on `displayAuthor`/its name-space,
  // same lite-vs-chain split `moderation` above already uses, for the same reason:
  // `post.author` is the shared publishing account for a lite-authored post.
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
   * ★★★ DOWNVOTE, MOVED HERE FROM THE INLINE ARROW (2026-08-16, spec "Demote
   * the downvote to an overflow-menu action" — the other half of the
   * `FEATURE_INLINE_DOWNVOTE` work already done in votes-component.tsx).
   *
   * That file's whole down side (Popover weight-picker, `VoteRemovalDialog`
   * for an existing downvote) is UNMOUNTED while the flag is off — its
   * `showDownvote` prop cannot be flipped on for just this card without
   * bringing the inline arrow back everywhere at once, which is the exact
   * thing that pass removed. So the popover below is a second Popover
   * INSTANCE, never a second DESIGN: the same `Popover`/`PopoverContent`/
   * `Slider` primitives, the same `voteStyles.btn`/`voteStyles.down` blade
   * button (imported from `blade.tsx`, not redrawn), the same warning-copy
   * translation keys, and the same `useVoteMutation()` write path — nothing
   * downstream of "which weight got submitted" changes.
   *
   * The vote state below is RE-DERIVED, not imported — `votes-component.tsx`
   * exports no hook for it, and this pass touches only this file — but it
   * copies the exact precedence that file's own "WHICH WAY I VOTED" comment
   * documents: `userVote` (the live, optimistic React Query row) FIRST,
   * `checkVote` (the SSR `active_votes` snapshot) only as the fallback,
   * because `active_votes` cannot represent "I just withdrew" and a
   * `checkVote`-first read would resurrect a vote this reader just removed.
   * Both read the SAME cache key (`['votes', author, permlink, voter]`)
   * `useVoteMutation`'s `onMutate` already writes to, so a vote cast from
   * THIS popover updates the tint/label here immediately, and is picked up
   * by the footer's own `VotesComponentWrapper` below for free — same key,
   * same cache, no extra plumbing.
   */
  const voter = identity.username;
  const isLite = user?.account_tier === 'lite';
  const checkVote = post.active_votes.find((entry) => entry.voter === voter);
  const [downvoteActed, setDownvoteActed] = useState(false);
  const { data: userVotes } = useQuery({
    queryKey: ['votes', post.author, post.permlink, voter],
    queryFn: () =>
      isLite
        ? fetchLiteEngagement(post.author, post.permlink)
        : fetchListVotesByCommentVoter(post.author, post.permlink, voter),
    enabled: isLite ? !!voter : !!checkVote || downvoteActed,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false
  });
  const userVote =
    userVotes?.votes[0] && userVotes.votes[0].voter === voter ? userVotes.votes[0] : undefined;
  const myVote: MyVote = userVote
    ? userVote.vote_percent > 0
      ? 'up'
      : userVote.vote_percent < 0
        ? 'down'
        : 'none'
    : checkVote
      ? Number(checkVote.rshares) < 0
        ? 'down'
        : Number(checkVote.rshares) > 0
          ? 'up'
          : 'none'
      : 'none';
  const vote_downvoted = myVote === 'down';
  /**
   * ★ `tierPending`, COPIED FROM votes-component.tsx (2026-08-13, A1 review
   * V-2 there). On a cold tab, `identity.isLoggedIn` can answer TRUE from the
   * server cookie before the client's OWN `account_tier` has loaded — voting
   * in that window takes the full-Hive-chain path even for a keyless Lumen
   * account, which has no keys and always fails. See that file's long
   * comment for the three near-misses baked into this exact condition; it is
   * reproduced verbatim rather than re-derived so the two surfaces cannot
   * silently disagree about when a vote is safe to submit.
   */
  const tierPending =
    identity.isLoggedIn && !identity.clientAnswered && !user.isLoggedIn && !sessionUnavailable;
  const voteMutation = useVoteMutation();
  const [downvoteSlider, setDownvoteSlider] = useState<number[]>([100]);
  const [downvotePopoverOpen, setDownvotePopoverOpen] = useState(false);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const downvoteMenuDisabled = voteMutation.isLoading || tierPending;
  const submitDownvote = async (weight: number) => {
    if (tierPending) return;
    setDownvoteActed(true);
    try {
      await voteMutation.mutateAsync({ voter, author: post.author, permlink: post.permlink, weight });
      // Closes the picker on a successful cast — this Popover, unlike
      // votes-component.tsx's, is not unmounted by a branch swap when
      // `vote_downvoted` flips (see the long note above), so it has to close
      // itself. Left open on error so the reader can retry without
      // re-opening the menu.
      setDownvotePopoverOpen(false);
    } catch (error) {
      setDownvoteActed(false);
      handleError(error, {
        method: 'vote',
        params: { voter, author: post.author, permlink: post.permlink, weight }
      });
    }
  };
  /**
   * ★ RULE 2 (spec): NEVER NEST A RADIX OVERLAY INSIDE A `DropdownMenuItem` —
   * it breaks focus return, because the item unmounts mid-interaction along
   * with whatever Radix parented under it. `onSelect` here does nothing but
   * flip state THIS COMPONENT owns; Radix closes the menu on its own default
   * `onSelect` behaviour (not prevented below), and the `Popover` that
   * actually shows the weight picker is a SIBLING of the `DropdownMenu`,
   * controlled entirely by that state, not a descendant of the item.
   */
  const handleDownvoteSelect = () => {
    if (downvoteMenuDisabled) return;
    if (vote_downvoted) {
      // Already downvoted: the item's own label already says the action
      // ("Remove your downvote" — see the menu below), so selecting it is
      // itself the confirmation. Same call `VoteRemovalDialog`'s onConfirm
      // makes for the inline arrow (votes-component.tsx: `submitVote(0)`) —
      // no second dialog for this branch, so rule 2 does not even apply here.
      submitDownvote(0);
    } else {
      setDownvotePopoverOpen(true);
    }
  };

  // ★ NSFW GATE (2026-08-09) — see lib/nsfw.ts for why this lives here at all.
  // Every hook runs before the `hide` early-return below, so hook order stays
  // stable across renders of the same list even as the preference changes.
  const isNsfw = isNsfwPost(post);
  const nsfwPreference = useNsfwPreference();
  // Mirrors the classic card: the preference only ever applies to a post that
  // is actually flagged, so an ordinary post is never gated by it.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    // Collapse again if the reader tightens the preference while scrolling.
    if (nsfwPreference !== 'show') setRevealed(false);
  }, [nsfwPreference]);
  const nsfwShown = !isNsfw || nsfwPreference === 'show' || revealed;

  const href = `/${post.category}/@${displayAuthor}/${post.permlink}`;
  const dek = getPostSummary(post.json_metadata, post.body);
  /**
   * ★ A NOTE IS NOT AN ARTICLE (2026-08-14, composer audit finding 7 / §9.6).
   *
   * A short post has no title of its own — the composer derives one by
   * truncating its first line — so this card printed the SAME SENTENCE twice:
   * once as a 26px semibold headline and again as the excerpt directly under it.
   * Measured on chain: `hbd-temp/testing-the-lumen-short-form-composer` has
   * `title === body`.
   *
   * When the writer marked it (`json_metadata.type === 'note'`) the headline is
   * dropped and the note's own text becomes the card's text, one step larger
   * than a dek so it still reads as the primary content. Everything else — the
   * byline, the thumbnail, the whole action bar — is untouched. Posts without
   * the marker (every post written before today, and every post from any other
   * Hive front end) take the article branch exactly as before.
   */
  const isNote = isNotePost(post.json_metadata);
  const reblogCount = post.reblogs ?? 0;
  const payoutDeclined = parseFloat(post.max_accepted_payout) === 0;
  const isReshare = post.title.includes('RE: ');

  // find_first_img falls back to the author's own avatar when no real post
  // image is found, so every card would always render "something". Medium's
  // card only shows a thumbnail when the post genuinely has one, so treat
  // that specific fallback value as "no image".
  const extractedImage = find_first_img(post);
  const authorAvatarFallback = getUserAvatarUrl(displayAuthor, 'large');
  const thumbnail = extractedImage && extractedImage !== authorAvatarFallback ? extractedImage : '';

  /**
   * ★ AN HONEST FALLBACK FOR A FAILED THUMBNAIL (2026-08-16, QA Low 9).
   *
   * Before this, `onError` on the `<img>` below just set `visibility: hidden`
   * — the 190x132 box, its rounded corners and its `bg-[#f4f5f7]` fill all
   * stayed, so a dead thumbnail was a bare grey rectangle with nothing in it:
   * indistinguishable from a slow-loading image, and with `alt=""` (correct
   * while the image is showing — the headline beside it is the real label,
   * per the X-7 fix below), a screen reader announces nothing there either.
   *
   * `onError` alone also isn't the whole story: exactly the failure mode
   * `packages/ui/components/user-avatar-img.tsx` was hardened for on
   * 2026-08-15 applies here too — Chrome's Opaque Response Blocking, a
   * privacy extension, or a DNS black-hole can complete the request with
   * ZERO pixels and never fire `onError` at all. So this mirrors that
   * component's approach instead of only handling the `onError` half: a ref
   * on the `<img>`, and a timeout (the SAME `DIRECT_TIMEOUT_MS` window, so a
   * slow-but-real load on a bad connection isn't punished any harder than an
   * avatar is) that checks `complete && naturalWidth > 0` and promotes to
   * "failed" if the image never produced pixels.
   */
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const thumbnailImgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // `nsfwShown` guards the deliberate no-request-until-revealed case just
    // below (an `<img>` never mounts while a flagged post is hidden, so the
    // ref would just be null) — AND re-arms this effect the moment a reveal
    // actually mounts the `<img>`, since it is a dependency here. Without it
    // the one-shot timer from first mount (when the element was still
    // absent) would never be replaced, and a blocked/zero-pixel image
    // revealed after that would only ever be caught by `onError`, missing
    // exactly the case this effect exists for.
    if (!thumbnail || thumbnailFailed || !nsfwShown) return;
    const timer = setTimeout(() => {
      const el = thumbnailImgRef.current;
      if (!el || (el.complete && el.naturalWidth > 0)) return;
      setThumbnailFailed(true);
    }, DIRECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // Re-arms if the post's thumbnail URL itself changes (a different card
    // reusing this component instance under the same key never happens in
    // this feed, but a stale timer racing a new `thumbnail` would otherwise
    // be a subtle bug).
  }, [thumbnail, thumbnailFailed, nsfwShown]);

  const handleReblog = async () => {
    try {
      await reblogMutation.mutateAsync({ author: post.author, permlink: post.permlink, username: user.username });
    } catch (error) {
      handleError(error, {
        method: 'reblog',
        params: { author: post.author, permlink: post.permlink, username: user.username }
      });
    }
  };

  const dialogAction = (dialogResponse: boolean): void => {
    if (dialogResponse) handleReblog();
  };

  // 'hide' means the reader asked not to see these at all — the classic list
  // renders nothing for them (`nsfw === 'hide' ? null : ...`) and so does this.
  if (isNsfw && nsfwPreference === 'hide') return null;

  // ★ DEFECT-2 FIX (2026-08-12) — mute status "unknown" must render differently
  // from "confirmed not muted", and it must NOT render as an ordinary card.
  //
  // Measured: `condenser_api.get_following` (the mute-list read behind
  // `moderation.isMuted`, see `use-moderation-status.ts`) times out often enough
  // that 3 of 4 fresh page loads lost the mute signal entirely — and because the
  // query used to swallow that failure into an empty, "successful" page (fixed in
  // `use-following-infinitequery.tsx`), this card had no way to tell "the viewer
  // mutes nobody" from "we don't know". It rendered the full post either way.
  //
  // The choice here is deliberately the SAME ONE `for-you/route.ts` already makes
  // for a failed refetch: an error must not masquerade as an empty, clean result
  // (that file's own comment: "THIS IS HOW A READER'S FEED GOT WIPED... 503 is the
  // honest answer"). Applied to a single card instead of a whole feed, "honest"
  // means the reader is told the check could not be completed and is given an
  // explicit choice to view anyway — never a card that silently claims to have
  // been checked. This also matches `hydrate()` in that same file: "cannot prove
  // X is safe => do not serve it as normal" — fail closed on the RENDER decision,
  // but say so, rather than either lying "clean" (the old bug) or lying "muted"
  // (which `medium-card-muted` below would if reused for an unknown status).
  //
  // Not gated behind `moderationRevealed` from the branch below — a reader who
  // revealed ONE unknown-status post has not thereby vouched for every other one
  // sharing this page's single, shared mute-list query.
  if (moderation.muteStatusUnknown && !moderationRevealed) {
    return (
      <article
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-dashed border-[#e0dcd4] bg-[#f9f7f5] p-[18px] font-sans text-[14px] leading-[22px] text-[#6b7280]"
        data-testid="medium-card-moderation-unknown"
      >
        <span>{t('cards.post_card.moderation_status_unknown', { author: displayAuthor })}</span>
        <button
          type="button"
          onClick={() => setModerationRevealed(true)}
          className="font-semibold text-[#2a2822] underline-offset-2 hover:underline"
          data-testid="medium-card-moderation-unknown-reveal"
        >
          {t('cards.post_card.reveal_post')}
        </button>
      </article>
    );
  }

  // ★ OWNER RULING 2026-08-12 — "we should have no collapses like Hiveblog or
  // ecency or peakd... it works the same way" as Block. This used to be a
  // collapse-with-Reveal-and-Unmute interstitial (E1); a post from someone the
  // viewer muted or personally ('own') blacklisted is now simply gone, exactly
  // like a Lumen-Blocked author's post already is on the tabs that filter
  // `isBlockedEntry` before this component ever mounts (`feed-tabs.tsx`). No
  // interstitial, no Reveal, no inline Unmute — recoverable only from Settings
  // (Muted Users / Blacklisted Users / Blocked Accounts), same as a real Block.
  // `blacklistReason === 'followed'` is NOT included — see `isOwnModerationHide`'s
  // doc for why that one stays the informational badge below, unchanged.
  //
  // Ordered AFTER the `muteStatusUnknown` gate above on purpose: that gate is
  // "we don't know yet, so don't claim clean OR muted"; this one only fires once
  // the mute-list read actually succeeded and came back positive.
  if (isOwnModerationHide(moderation.isMuted, blacklistReason)) {
    return null;
  }

  return (
    <article
      // ★ THE ROOT TESTID THE TEST SUITE NEEDS (2026-08-09). The card had testids on
      // every child and none on itself, so nothing could count posts or scope a
      // locator to "the first post". `playwright/tests/support/pages/homePage.ts`
      // asked for `li[data-testid="post-list-item"]` — the CLASSIC card, which Lumen
      // replaced with this one — and that single missing selector failed 51 of 57
      // tests in `mainTimeline.spec.ts` in a `beforeEach`, before a single assertion
      // ran. Every child testid here is `medium-card-*`, so the root follows suit.
      data-testid="medium-card"
      // ★ EACH POST IS ITS OWN CARD (owner direction, 2026-08-08). This was a
      // full-bleed row with a single hairline UNDER it, so posts read as one
      // continuous column. Now each sits in its own bordered, rounded box — the
      // same `rounded-[18px] border-[#ebebeb]` card the rest of Lumen already
      // uses, so this borrows the existing language rather than inventing a
      // second one. Borders only: type, spacing and colour are untouched.
      className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white p-[22px] shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#fdfcfb]"
    >
      {/* Reblog provenance line — only present when the underlying query supplies
          it. `EntryFeed` in feed-tabs.tsx fetches the Following tab via
          `bridge.get_account_posts({ sort: 'feed' })` specifically because that
          endpoint (unlike `get_ranked_posts`) carries `reblogged_by`, live-verified
          against api.hive.blog 2026-08-06. Mirrors the classic feed's own marker
          (post-list-item.tsx: Icons.forward + t('cards.reblogged')) so a reblog
          reads the same way everywhere in the app. */}
      {post.reblogged_by && post.reblogged_by.length > 0 ? (
        <div
          className="mb-2.5 flex items-center gap-1.5 font-sans text-[13px] leading-[20px] font-medium text-[#6b7280]"
          data-testid="medium-card-reblogged-by"
        >
          <Icons.forward className="h-3.5 w-3.5 shrink-0" />
          <Link
            href={`/@${post.reblogged_by[0]}`}
            className="hover:underline"
            data-testid="medium-card-reblogged-by-link"
          >
            {post.reblogged_by[0]}
          </Link>
          <span>{t('cards.reblogged')}</span>
        </div>
      ) : null}

      {/* Byline row */}
      <div className="flex flex-wrap items-center gap-2 font-sans text-[14px] leading-[22px] text-[#6b7280]">
        <Link href={`/@${displayAuthor}`} className="shrink-0" data-testid="medium-card-avatar">
          {/* ★ STRAIGHT TO THE IMAGE HOST (2026-08-10). This one line was 29 requests
              to our own `/api/avatar` per feed page, 6.0-6.3s each on a warm server,
              19 of them still unreturned 45s in — see the long note on
              `getUserAvatarDirectUrl`. The proxy stays as the error path, which is
              what keeps lite accounts and dead profile images working.
              ★ Now the app's one avatar component (F6 item 22, converged) — same
              direct→proxy chain this card originated, applied everywhere else too. */}
          <UserAvatarImg username={displayAuthor} pixelSize={26} alt={displayAuthor} />
        </Link>
        <Link
          href={`/@${displayAuthor}`}
          className="font-semibold text-[#2a2822] hover:underline"
          data-testid="medium-card-author"
        >
          {displayAuthor}
        </Link>
        {/* ★ E2/E4 — the blacklist mark. Informational only (see the collapse note
            above for why blacklist does not hide the card the way Mute does).
            `reputation`/`none` render nothing: a merely low-reputation author is not
            on anyone's list, and labelling them "blacklisted" is the exact mislabel
            E3 corrected for comments — same rule, same component, applied here. */}
        {blacklistReason === 'own' || blacklistReason === 'followed' ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                aria-label={t(
                  blacklistReason === 'own'
                    ? 'cards.comment_card.reason_blacklisted_by_you'
                    : 'cards.comment_card.reason_on_followed_list'
                )}
                data-testid="medium-card-blacklist-mark"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>
                {t(
                  blacklistReason === 'own'
                    ? 'cards.comment_card.reason_blacklisted_by_you'
                    : 'cards.comment_card.reason_on_followed_list'
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {/* ★★ THE BYLINE MARK, MOUNTED AT LAST (owner instruction, 2026-08-09).
            It was removed on 2026-08-08 because it rendered
            `bylineTierFromReputation(post.author_reputation)` — a DIFFERENT function
            from the profile's — so one person carried two contradicting ranks in one
            session (@taskmaster4450: Beacon in the feed, Torch on his profile).
            It is safe now for a specific reason, not because the ruling changed: the
            rank arrives from `lumen_hive_rank`, a SNAPSHOT of the very computation the
            profile runs, batched into one request per page by `useRankMarks` and never
            derived from the post payload. So a mark can differ from a profile only by
            being older, never by being computed differently — and the server's TTL
            drops it before that matters.
            `mark` is undefined for an author nobody has looked up yet, and
            `LeagueByline` renders nothing below Torch, so this is silent by default
            rather than noisy. */}
        {mark ? <LeagueByline tier={mark.tier} rankNumber={mark.rankNumber} /> : null}
        {post.community && post.community_title ? (
          <>
            {/* ★ A COMMUNITY IS SHOWN AS A TAG (owner ruling, 2026-08-07).
                Lumen has no community PAGES — no moderators, roles or subscribe —
                so this must never link to the old community layout. But the name
                is real provenance and a useful way to browse, so it links to that
                community's TAG FEED: the same Lumen feed, filtered. */}
            <span>{LABELS.in}</span>
            <Link href={`/topics/${post.community}`} className="font-semibold text-ink-brand-6 hover:underline">
              {post.community_title}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true" className="text-[#cbd0d6]">
          ·
        </span>
        <TimeAgo date={post.created} />

        {/* Creator-token chip (design brief §2) — owner ruling: a token price
            indicator belongs next to every post and every name. Renders
            nothing when the author has no token, or the answer isn't known
            yet; see the component's own doc. */}
        <TokenAuthorChip handle={displayAuthor} />

        {/* ★ E2, REVISED 2026-08-12 (owner ruling) — THE POST OVERFLOW MENU'S ONE
            MODERATION CONTROL IS BLOCK. Before this pass there was no way to
            moderate an author from the feed at all; this menu then grew Mute and
            Blacklist as two separate items. The owner's ruling collapsed both
            into Block, which already does everything those two were trying to do
            plus the half neither could (hiding this author's replies under the
            viewer's OWN content from every other reader). Hidden (not disabled)
            when either side cannot hold a Lumen block record — same "hidden, not
            disabled" rule `useModerationStatus` used, now enforced by
            `useLumenBlock`'s own `available` answer instead. */}
        {block.available || block.unknown ? (
          // ★ THE POPOVER'S ANCHOR IS AN INVISIBLE SIBLING, NOT THE REAL
          // BUTTON (2026-08-16). The obvious composition — wrap the same
          // button in both `PopoverTrigger asChild` and `DropdownMenuTrigger
          // asChild`, the way votes-component.tsx nests Tooltip inside a
          // vote trigger — does NOT work here and was tried first: Radix's
          // `Popover.Trigger` attaches its OWN click handler that calls
          // `onOpenChange` regardless of whether `open` is controlled, so
          // every click on "···" would also toggle the downvote popover.
          // That composition is safe in votes-component.tsx only because
          // Tooltip listens for hover/focus, never click — two click
          // listeners on one element genuinely collide.
          //
          // So the Popover's anchor is a separate, `pointer-events-none`
          // `<span>` absolutely positioned over the real button (via the
          // `relative` wrapper below) — present only so Radix's Popper has a
          // rect to pin the picker to. It can never receive a click itself
          // (pointer-events: none), and being a SIBLING rather than an
          // ancestor of the button, a click ON the button never bubbles
          // through it either — so `open` changes only when
          // `handleDownvoteSelect` or the Popover's own dismiss handling
          // (outside click / Escape) call `setDownvotePopoverOpen`.
          <div className="relative ml-auto flex shrink-0">
            <Popover open={downvotePopoverOpen} onOpenChange={setDownvotePopoverOpen}>
              <PopoverTrigger asChild>
                <span aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute inset-0" />
              </PopoverTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    ref={overflowTriggerRef}
                    type="button"
                    aria-label={
                      vote_downvoted
                        ? t('profile.overflow_menu_label_downvoted')
                        : t('profile.overflow_menu_label')
                    }
                    // ★ Contrast fix (2026-08-13, O5 a11y build map item 4). `#9aa1ab`
                    // measured 2.61:1 on this button's default white background —
                    // `#7a7268` (4.74:1 on white) is the plain-white replacement;
                    // the hover state already swaps to the higher-contrast
                    // `#4b5563` so the grey-ground variant isn't needed here.
                    //
                    // ★ DOWNVOTED TINT (2026-08-16, spec §4b) — `#5b6470` /
                    // dark `#a3adba` are not new colours: they are
                    // `--lm-vote-slate` from vote-control.module.css, the exact
                    // shade the Blade's own down arrow already used for "this
                    // is mine" (`.down.mine`). That file also documents WHY
                    // the light value has a dark counterpart rather than
                    // reusing one hex everywhere: `#5b6470` on the dark card
                    // background measured under 3:1 contrast. This button
                    // cannot reach that CSS custom property directly (it is
                    // scoped to `.root`, which nothing here renders), so the
                    // two literals are duplicated with this comment as the
                    // pointer back to the source of truth — not
                    // independently invented. Colour is not the only signal:
                    // the aria-label above says so in words too, since a
                    // colour-only change is not accessible on its own.
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[#f4f5f7] hover:text-[#4b5563]',
                      vote_downvoted ? 'text-[#5b6470] dark:text-[#a3adba]' : 'text-[#7a7268]'
                    )}
                    data-testid="medium-card-overflow-trigger"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                {/* ★ NOT `text-destructive` (spec §5) — on the post page this
                    item sits beside `Flag post`, and colouring it the same red
                    would make a routine curation action read as the same kind
                    of act as reporting abuse. Plain item styling only. */}
                <DropdownMenuItem
                  onSelect={handleDownvoteSelect}
                  disabled={downvoteMenuDisabled}
                  data-testid="medium-card-downvote-menu-item"
                >
                  {vote_downvoted ? t('cards.post_card.remove_downvote') : t('cards.post_card.downvote')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {block.available ? (
                  <DropdownMenuItem
                    onClick={handleBlockClick}
                    disabled={block.busy}
                    className="cursor-pointer text-destructive focus:text-destructive"
                    data-testid="medium-card-block-menu-item"
                  >
                    {block.isBlocking ? t('user_profile.unblock_button') : t('user_profile.block_button')}
                  </DropdownMenuItem>
                ) : (
                  // `unknown`, not `available`: the read failed rather than "this pair
                  // cannot be blocked" (use-lumen-block.ts). A disabled item that says
                  // so, not a vanished menu, is the honest answer during a backend
                  // outage.
                  <DropdownMenuItem
                    disabled
                    className="cursor-not-allowed"
                    data-testid="medium-card-block-menu-item-unknown"
                    title={t('user_profile.block_status_unknown_hint')}
                  >
                    {t('user_profile.block_status_unknown')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <PopoverContent
              className="z-50 max-w-xs rounded-lg bg-background-secondary p-4 shadow-lg"
              align="end"
              data-testid="medium-card-downvote-popover"
              // ★ RULE 3 (spec): FOCUS RETURNS TO THE "···" TRIGGER, EXPLICITLY.
              // Radix's default `onCloseAutoFocus` restores focus to whatever
              // was focused before the Popover opened — here that is whatever
              // the DropdownMenu left focus on mid-close, not guaranteed to be
              // this exact button since this Popover has no visible trigger of
              // its own to fall back on. Rather than rely on that default,
              // `preventDefault` it and focus the trigger ref directly: this
              // fires on Escape, on an outside click, AND on a successful cast
              // (see `submitDownvote`'s own close above) — the same, one place.
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                overflowTriggerRef.current?.focus();
              }}
            >
              <div className="flex h-full items-center gap-2">
                {/* `voteStyles.root` wraps just this button so the two custom
                    properties `.down`/`.mine`/`.btn` read (`--lm-vote-muted`,
                    `--lm-vote-slate`) resolve — those are scoped to `.root` in
                    vote-control.module.css and this popover renders outside
                    any `VoteControl` tree. `.sm` matches the density the
                    footer's own `VotesComponentWrapper` already uses on this
                    card (`size="sm"`, its default for `type="post"`). */}
                <span className={cn(voteStyles.root, voteStyles.sm)}>
                  <button
                    type="button"
                    data-testid="medium-card-downvote-confirm"
                    aria-label={t('cards.post_card.downvote')}
                    className={cn(voteStyles.btn, voteStyles.down)}
                    disabled={downvoteMenuDisabled}
                    onClick={() => submitDownvote(-downvoteSlider[0] * 100)}
                  >
                    <BladeGlyph />
                  </button>
                </span>
                <Slider
                  dataTestId="medium-card-downvote-slider"
                  defaultValue={downvoteSlider}
                  value={downvoteSlider}
                  min={1}
                  className="w-36"
                  onValueChange={(value: number[]) => setDownvoteSlider(value)}
                />
                <div className="w-fit text-destructive" data-testid="medium-card-downvote-slider-percentage-value">
                  -{downvoteSlider}%
                </div>
              </div>
              <div className="flex flex-col gap-1 pt-2 text-sm" data-testid="medium-card-downvote-description">
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
          </div>
        ) : null}
      </div>

      {/* Body grid — text column, plus a fixed thumbnail column ONLY when there
          is something to put in it.

          ★ P-2: the grid was unconditionally `1fr 190px`, and a post with no
          image filled the second track with an empty grey box. On a profile
          that is most of the page — measured on /@hbd-temp before this change,
          8 of 10 cards were grey rectangles — and the box carried no
          information at all: it was not a failed image, there was simply never
          an image. So the track only exists when it has content, and an
          imageless post gets the full width for its headline and dek instead of
          a 190px hole beside it. */}
      {/* ★ GRID → FLEX-WRAP (2026-08-13, O5 a11y build map item 5). The old
          `grid-cols-[1fr_190px]` gave the thumbnail a hard 190px track and let
          the text column (`1fr` over a `min-w-0` child) shrink to nothing —
          measured live: 80px wide on an ordinary 390px phone (three
          characters of a 26px, two-line-clamped headline), 10px at 320px,
          with the squeeze absorbed silently rather than overflowing, which is
          why an overflow-only sweep never caught it. `flex-wrap` makes the
          decision on each item's hypothetical main size instead of the
          viewport: `basis-[240px]` on the text column means the thumbnail
          wraps below exactly when the CARD (not the window) is narrower than
          240 + 26 (gap) + 190 (thumbnail) = 456px, and is otherwise
          byte-identical to the old grid — proved by injecting the equivalent
          CSS into the running page: 226px-wide text column at 320px, wrapped
          below the thumbnail, vs 10px squeezed beside it before. The old
          conditional `grid-cols-1`/`grid-cols-[1fr_190px]` branch is no
          longer needed: with no second flex child (no thumbnail, no NSFW
          placeholder) the text column simply takes the full row on its own. */}
      <div className="mt-[13px] flex flex-wrap items-start gap-[26px]">
        <div className="min-w-0 flex-1 basis-[240px]">
          {/*
           * ★★★ A NOTE WITH NOTHING TO SHOW MUST NOT RENDER AN EMPTY CARD
           * (2026-08-16, owner: "the post looks like a comment").
           *
           * The note branch drops the headline and shows the note's own text
           * instead. That is right when there IS text. When `dek` is empty the
           * old shape rendered NEITHER: `{isNote ? null : title}` followed by
           * `{isNote && dek ? note : ...}` leaves both arms empty, and the card
           * collapsed to an avatar, a name, a timestamp and an action row. On
           * the profile it read exactly like an empty comment.
           *
           * This is not hypothetical or rare: `lumen_post.body` is EMPTY for
           * every row (`length(body) = 0` measured across all six of the QA
           * account's posts), because the body travels in the publish payload
           * and lives on chain, not in that column. So every Lumen short post
           * hit this case.
           *
           * The title is the only text we have then, so show it in the note's
           * own style. This cannot reintroduce the duplication the note marker
           * exists to remove: that needed title AND body both present, and this
           * branch only runs when the body is missing.
           */}
          {isNote && !dek ? (
            <Link href={href} className="block" data-testid="medium-card-note-title">
              <p className="line-clamp-4 font-serif text-[19px] leading-[30px] text-[#2a2822]">{displayTitle}</p>
            </Link>
          ) : isNote ? null : (
            <Link href={href} className="block" data-testid="medium-card-title">
              <h2 className="line-clamp-2 font-sans text-[26px] font-semibold leading-[32px] tracking-[-0.015em] text-[#161511]">
                {displayTitle}
              </h2>
            </Link>
          )}

          {isNote && dek ? (
            <Link href={href} className="block" data-testid="medium-card-note">
              <p className="line-clamp-4 font-serif text-[19px] leading-[30px] text-[#2a2822]">{dek}</p>
            </Link>
          ) : dek ? (
            // ★ REDUNDANT TAB STOP REMOVED (2026-08-13, O5 a11y build map item
            // 8). This link, the title link above and the thumbnail link below
            // all go to the exact same `href` — three tab stops for one
            // destination on every card. `tabIndex={-1}` takes it out of the
            // sequential Tab order (it stays clickable, and stays in a screen
            // reader's browse-mode link list) while the title link remains the
            // one real stop.
            <Link href={href} className="mt-[10px] block" data-testid="medium-card-dek" tabIndex={-1}>
              <p className="line-clamp-2 font-serif text-[17px] leading-[26px] text-[#4b5563]">{dek}</p>
            </Link>
          ) : null}

          {/* The flag and the way back out. Rendered in the text column rather
              than over the thumbnail so it is still there for a flagged post
              that has no image at all. */}
          {isNsfw ? (
            <div
              className="mt-[10px] flex flex-wrap items-center gap-2 font-sans text-[13px] leading-[20px] text-[#6b7280]"
              data-testid="medium-card-nsfw-notice"
            >
              {/* ★ `line-brand-10`/`ink-brand-6`, not `#c0392b` (2026-08-14
                  token-migration pass): border → `line-*`, text → `ink-*`, per
                  `tailwind.config.js`'s own role mapping. */}
              <span className="rounded-[6px] border border-line-brand-10 px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-ink-brand-6">
                {LABELS.nsfwBadge}
              </span>
              {nsfwPreference === 'show' ? null : (
                <>
                  <span>{LABELS.nsfwNote}</span>
                  <button
                    type="button"
                    onClick={() => setRevealed((value) => !value)}
                    className="font-medium text-ink-brand-6 underline-offset-2 hover:underline"
                    data-testid="medium-card-nsfw-toggle"
                  >
                    {revealed ? LABELS.nsfwHide : LABELS.nsfwReveal}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>

        {!nsfwShown ? (
          // Deliberately not the `<img>` below: a flagged image must not be
          // requested at all until the reader asks for it, or the picture has
          // already been fetched and painted by the time any overlay mounts.
          <div
            // `shrink-0` (flex-wrap fix, item 5): this box no longer sits in a
            // fixed 190px grid track, so without it a flex row would shrink it
            // like any other item. Colour (item 4): `#9aa1ab` measured 2.61:1
            // on this box's own `#f4f5f7` background; `#6f6963` is the
            // grey-ground replacement, 4.97:1 on `#f4f5f7`.
            className="flex h-[132px] w-[190px] shrink-0 items-center justify-center rounded-[14px] border border-dashed border-[#e0dcd4] bg-[#f4f5f7] font-sans text-[12px] font-medium uppercase tracking-wide text-[#6f6963]"
            data-testid="medium-card-nsfw-thumbnail-hidden"
          >
            {LABELS.nsfwBadge}
          </div>
        ) : thumbnail && thumbnailFailed ? (
          // ★ THE HONEST FALLBACK (2026-08-16, QA Low 9) — see the state/effect
          // above. Same box, same dashed-border language as the NSFW-hidden
          // placeholder just above (so a reader learns one shape for "nothing
          // to show here" instead of two), but its OWN copy and icon: this is
          // a failed load, not a flag the reader chose to hide.
          <Link
            href={href}
            className="shrink-0"
            data-testid="medium-card-thumbnail-failed"
            aria-label={displayTitle}
            tabIndex={-1}
          >
            <div
              className="flex h-[132px] w-[190px] flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-[#e0dcd4] bg-[#f4f5f7] font-sans text-[12px] font-medium text-[#6f6963]"
              aria-hidden="true"
            >
              <ImageOff className="h-5 w-5" strokeWidth={1.75} />
              {t('cards.post_card.thumbnail_unavailable')}
            </div>
          </Link>
        ) : thumbnail ? (
          // X-7: this link wrapped an image with an empty alt and nothing else, so it
          // announced itself as an unnamed link. The image stays decorative (the
          // headline beside it is the real label) and the LINK carries the name.
          <Link
            href={href}
            className="shrink-0"
            data-testid="medium-card-thumbnail"
            aria-label={displayTitle}
            // Same redundant-tab-stop removal as the dek link above — same
            // destination as the title link.
            tabIndex={-1}
          >
            <img
              ref={thumbnailImgRef}
              src={thumbnail}
              alt=""
              // ★ CONTAIN, NOT COVER (F6 item 23). `find_first_img` requests
              // `?width=256&height=512&mode=fit` from images.hive.blog, which
              // fits the SOURCE image inside that box preserving its own aspect
              // ratio — so what actually arrives is whatever shape the post's
              // image is (measured on the "Mischievous Mondays" card:
              // 256x144, a 16:9 shape, against this 190x132, a ~3:2 box).
              // `object-cover` fills the box by cropping the wider dimension
              // — for a photo that is usually invisible, but this feed also
              // carries text-as-image graphics (contest banners, memes,
              // quote cards) where the crop can land mid-word, exactly as it
              // did here: 22px sliced off each side, and the right-hand cut
              // happened to fall through a letter. `contain` always shows the
              // whole image — worst case it pillarboxes against the same
              // `bg-[#f4f5f7]` the box already carries for the pre-load
              // state, never slices content the post author chose to show.
              className="h-[132px] w-[190px] rounded-[14px] bg-[#f4f5f7] object-contain"
              loading="lazy"
              decoding="async"
              // ★ THE IMAGE PIPELINE IS HEALTHY — measured, 2026-08-08, after a
              // report that "no post on the feed has an image". It does not hold:
              // 20 of 20 sampled cards carry a real image (`json_metadata.image[0]`
              // or the first markdown image), correctly proxied through
              // images.hive.blog, every request 200 with valid bytes (curl- and
              // DOM-verified via `naturalWidth`). 12 of 20 paint within 3s with no
              // scrolling; 20 of 20 paint once actually scrolled near.
              //
              // Lazy loading stays. The cards below the fold that look empty are
              // simply not fetched yet, which is what lazy loading IS — and this
              // feed scrolls forever, so eager-loading every thumbnail would mean a
              // reader who scrolls a while pulls down every image they passed. The
              // apparent emptiness is mostly an OBSERVATION artifact: a full-page
              // screenshot captures layout without dispatching the scroll events
              // native lazy-loading waits for, so automation sees grey boxes a human
              // never does. If a real reader still sees an imageless feed, look at
              // WHICH posts are in it (QA/test posts genuinely have no image), not
              // at this element.
              onError={() => setThumbnailFailed(true)}
            />
          </Link>
        ) : null}
      </div>

      {/* Action bar — denser's own vote/reblog controls, restyled to the redesign.
          Vote arrows keep their real red-up / grey-down treatment (VotesComponent). */}
      {/* `flex-wrap` (2026-08-13, O5 a11y build map item 5, second half): the
          payout chip (`ml-auto`, below) was measured overflowing the
          viewport by 57px at 320px across 14 sampled cards — a separate
          element from the title-column collapse above, on this same
          non-wrapping row. Wrapping lets it drop to its own line instead of
          being pushed off-screen. Unlike the grid→flex change above, this one
          was not re-proven by CSS injection after the fix — flagging that
          honestly rather than claiming a measurement I didn't take. */}
      {/* ★ 15px/24px -> 14px/22px (2026-08-13, typography pass 2: font twins).
          The card's own byline row (above) is 14px/22px and the payout chip
          INSIDE this very row is `text-sm`, i.e. also 14px — so the row was
          rendering its own last child one step smaller than everything beside
          it, and the vote count / comment count / reblog count one step LARGER
          than the byline naming the author. That is drift, not hierarchy: an
          action bar is not more important than the byline it sits under. One
          step (14px/22px, the scale's UI default) for the whole row now. Icons
          are unaffected — they are pinned at 20px in px, not em. */}
      <div
        className="mt-[18px] flex flex-wrap items-center gap-2.5 font-sans text-[14px] leading-[22px]"
        data-testid="medium-card-footer"
      >
        {/* Vote pill. The arrows are denser's real VotesComponent, so their size is
            lifted here (20px) rather than in the shared component — the classic
            feed keeps its own scale. The count's chevron is suppressed: next to a
            live up/down pair a third arrow glyph is noise, not information.
            ★ 21px -> 20px (2026-08-13, typography audit item 1). An ODD icon
            height made this row 37px and its parent 49px, and `align-items:
            center` then put every text child in the row on a half pixel —
            `(49 - 36) / 2 = 6.5`. MEASURED: 120 of the 121 remaining
            fractional-Y text nodes on Home traced to exactly this row. 20px is
            also what the comment and reblog icons beside it already use
            (`iconClassName="h-[20px] w-[20px]"`), so this makes the row
            internally consistent as well as whole-pixel. */}
        {/* ★ NO PILL INSIDE THE CARD (2026-08-08). The vote controls sat in their
            own grey rounded box, which read as a card inside a card once each
            post got its own border. The vote count keeps its weight from type,
            not from a background. Hover still lights each control, matching the
            comment and reblog buttons beside it. */}
        {/* ★ THE `[&_svg]:h-[20px]` OVERRIDE IS GONE (2026-08-14) — it was DEAD,
            and dangerous while it looked alive. It compiles to
            `.\[\&_svg\]\:h-\[20px\] svg` (one class + one type = 0,1,1); the
            Blade's own rule is `.sm .btn svg` (two classes + type = 0,2,1) and
            wins, so the glyph has always rendered at the handoff's 22px, not
            the 20px this line asks for. Measured on :3000: box=22x22. Left in
            place it is a tripwire — the next person to notice the rule "not
            working" would raise its specificity and silently take the glyph to
            20px, which is the handoff's stated floor, below which the concave
            flanks fuse. The control sizes itself; the card does not get a
            vote. */}
        <div className="flex items-center gap-1 rounded-[10px] px-1 py-1.5">
          {/* ★ The tally lives INSIDE the vote control now (Blade redesign,
              2026-08-14). This sibling printed `total_votes` a second time, so every
              card read "759 759" — measured on the Blade build before removal. The
              control's own tally is the split up/down count Hive actually keeps; this
              one was a single netted number and could never show a downvote. */}
          <VotesComponentWrapper post={post} type="post" />
        </div>

        {/* ★ h-9 ON ALL THREE CHIPS IN THIS ROW (2026-08-15). Measured on the
            production build, one card, same footer row: the comment and reblog
            chips came out 34px and the payout 36px, all three with the same 6px
            vertical padding and the same rounded-[10px]. The 2px came entirely
            from type — the payout is deliberately `text-base` (owner, 2026-08-14:
            the money must not be the smallest number on the row), which is a
            24px line box against the chips' 22px.

            So the fix is NOT to touch the type, which is intentional, but to
            stop the box height being a by-product of it. A fixed 36px makes the
            three hover targets identical without shrinking anything — and these
            chips paint a hover background, so an uneven row is visible the
            moment a reader moves the mouse across it. The Blade vote control
            next to them is taller on purpose and is left alone. */}
        {/* Comments ghost button */}
        <span className="flex h-9 items-center gap-1 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]">
          {/* ★ 20px/1.75 -> 22px/2, TO MATCH THE BLADE (2026-08-14, owner:
              "the comment icon has thinner borders than the blade upvote").
              Measured on :3000, one card, same footer row:

                upvote / downvote (Blade)  stroke 2     22x22
                comment (post-children)    stroke 1.75  20x20
                reblog                     stroke 1.75  20x20

              The row is therefore drawn at two weights and two sizes, and the
              heavier, larger one is the vote control, so it reads as bolted on.

              THE NEIGHBOURS COME UP, THE BLADE DOES NOT COME DOWN. Three
              reasons, in order of force:
               1. The handoff pins the Blade — `stroke-width: 2`, 22px at feed
                  density, "never below 20px glyph — the concave flanks fuse",
                  never below a 38px target. Taking it to 20/1.75 would sit it
                  exactly on the floor it was warned about, to match icons that
                  have no such constraint.
               2. Lowering it is not even a local edit. 1.75 is the DEFAULT of
                  the whole house icon set — `make()` in
                  packages/ui/components/custom-icons.tsx sets `strokeWidth={1.75}`
                  once for ~80 icons. Matching downward means either a literal
                  on the Blade (drift by hand) or moving that default, which
                  repaints every icon in the app, most of them on surfaces
                  other people own this session.
               3. The vote control is the primary action on the card. Making
                  the primary action the lightest mark on its own row to settle
                  a consistency argument is the wrong trade.

              So the fix is scoped to THIS ROW, in the file that owns it, via
              className — `stroke-2` is a real Tailwind utility
              (`stroke-width: 2`) and a CSS declaration beats the `stroke-width`
              presentation attribute the factory sets, so no shared component
              is touched. The overflow "…" in the card HEADER is deliberately
              left alone: it is lucide, already stroke 2, and on a different
              row from the one the owner is looking at. */}
          <PostCardCommentTooltip
            comments={post.children}
            url={`${href}/#comments`}
            iconClassName="h-[22px] w-[22px] stroke-2"
            postTitle={displayTitle}
          />
        </span>

        {/* Reblogs ghost button */}
        {!isReshare ? (
          <div data-testid="medium-card-reblog">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ReblogDialog author={post.author} permlink={post.permlink} action={dialogAction}>
                    <button
                      disabled={reblogMutation.isLoading}
                      className={cn(
                        'flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]',
                        { 'cursor-not-allowed opacity-50': reblogMutation.isLoading }
                      )}
                      data-testid="medium-card-reblog-count"
                      aria-label={`${LABELS.reblog} ${displayTitle}`}
                    >
                      {/* 20px/1.75 -> 22px/2 — see the note on the comment icon above. */}
                      <Icons.reblog className="h-[22px] w-[22px] stroke-2" aria-hidden="true" />
                      {reblogCount}
                    </button>
                  </ReblogDialog>
                </TooltipTrigger>
                <TooltipContent data-testid="medium-card-reblog-tooltip">{LABELS.reblog}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : null}

        {/* Payout chip */}
        <DetailsCardHover post={post} decline={payoutDeclined}>
          <span
            className={cn(
              // Plain green figure, no chip — same reasoning as the vote group above.
              // ★ text-base, not text-sm (2026-08-14, owner-reported): the payout was 14px
              // against a 14.5px vote tally, so the money was the SMALLEST number on
              // the row. It is now 16px, one step above the 14px tally.
              'ml-auto flex h-9 items-center rounded-[10px] px-[6px] py-[6px] text-base font-bold text-[#2f7d4f] transition-colors hover:cursor-pointer',
              payoutDeclined && 'bg-transparent text-muted-foreground line-through'
            )}
            data-testid="medium-card-payout"
          >
            ${post.payout.toFixed(2)}
          </span>
        </DetailsCardHover>
      </div>
    </article>
  );
}
