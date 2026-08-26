'use client';

import { useEffect, useRef, useState } from 'react';
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
import { QuillMark } from '@/blog/features/post-rendering/quill-mark';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import { LeagueByline } from '@/blog/features/retention/components/league-byline';
import type { RankMark } from '@/blog/features/retention/hooks/use-rank-marks';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { isNsfwPost, useNsfwPreference } from '@/blog/lib/nsfw';
import { isNotePost } from '@/blog/lib/short-post-note';
import { useModerationStatus } from '@/blog/features/mute-follow/hooks/use-moderation-status';
import { classifyBlacklist } from '@/blog/lib/moderation/blacklist-reason';
import { isOwnModerationHide } from '@/blog/lib/muted-reasons';
import cardStyles from './post-card.module.css';
import TopCommentDrawer from './top-comment-drawer';
import IdentityPill from './identity-pill';
import type { MarketPrice } from '@/blog/features/creator-tokens/types';
import { useVisibleDiscussion } from './lib/use-visible-discussion';
import { claimOpen, lastInputWasKeyboard, releaseOpen } from './lib/card-expansion';
import { getPostRubric } from './lib/post-rubric';

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
 * ★ THE FEED CARD'S "···" IS HIDDEN (owner, 2026-08-26): *"remove the ... for now.
 * they already exist on the post page. remove for now. hide it. dont delete the
 * code, just hide it."*
 *
 * The card's overflow menu duplicated actions the post page already offers, and it
 * cost the byline: the identity pill had to stop 32px short of the header rule's
 * right edge to leave the trigger room, while the owner's reference draws the pill
 * flush — and the profile COMMENT cards, which never had a menu, already sat flush.
 * Hiding the trigger closes that mismatch as a side effect.
 *
 * HIDDEN, NOT DELETED, and deliberately behind one flag rather than a `display:none`:
 * a CSS-hidden trigger is still a real button that focus, `closest()` guards and the
 * QA probes all have to keep reasoning about. Not rendering it removes the question.
 * Everything the menu owns below — the Block item, the downvote popover and its
 * sibling-anchor ruling, `overflowTriggerRef`, the focus-restoration handling — is
 * untouched and comes back exactly as it was by flipping this to `true`.
 *
 * Typed `boolean`, not left to infer `false`: the literal type would mark every
 * guarded branch unreachable and invite a "dead code" cleanup of the very code this
 * flag exists to preserve.
 */
const SHOW_CARD_OVERFLOW_MENU: boolean = false;

/**
 * Medium-style feed card for a single Hive post: a roomy text column with a
 * larger square thumbnail (only when the post actually has one), followed by
 * the FULL Hive controls row — real vote control (upvote/downvote + weight
 * slider), payout, upvote count, comments, and one-tap reblog. Medium's
 * cleanliness and spacing, Hive's actions. The controls are denser's own
 * components (`VotesComponentWrapper`, `ReblogDialog`, the card tooltips) so
 * voting/reblog behaviour stays identical to the classic feed.
 */
export default function MediumPostCard({
  post,
  mark,
  price,
  luminosity
}: {
  post: Entry;
  mark?: RankMark;
  /*
   * This author's creator-token market, read ONCE PER PAGE by whichever list
   * mounts these cards — exactly like `mark` above, and for the same reason.
   * `useTokenPriceChips(authors)` asks the chain for the whole page in one
   * request; a card that fetched its own would restore the N+1 that cost this
   * feed 30 seconds a load in August. Optional so a list that has not wired it
   * yet still renders (handle-only pill), rather than failing to compile.
   */
  price?: MarketPrice;
  /*
   * This author's §2 rank luminosity, read once per page alongside `mark` and
   * `price`. Drives the glow on the identity cluster's face — see
   * `useRankLuminosity`, which shares `useRankMarks`' request rather than making
   * a second one.
   */
  luminosity?: number;
}) {
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
  /**
   * ★★★ THE DRAWER'S FETCH GATE (2026-08-19, top-comment drawer).
   *
   * `engaged` flips once and never back. It is the FETCH gate only — the open
   * state moved into JS on 2026-08-20 and lives in `open` just below, with the
   * spec §8 rules that go with it. The comment inside has to be fetched, and the
   * feed payload does not carry one:
   * `Entry` has `children` (a count) and no bodies. So a drawer on every card
   * would be one extra request per card, 20 per feed page, added to the most
   * visited screen in the product. This app has already paid for that exact
   * mistake: `/topics/photography` went 5.5-14.7s -> 0.38-0.68s in August purely
   * by deleting serial trips.
   *
   * 140ms of intent before it fires, so brushing the cursor down a feed costs
   * nothing. That is not a new number — it is the `delayDuration` this same file
   * already uses for the lite-account quill tooltip, i.e. the app's existing
   * answer to "did they mean to hover this".
   *
   * One-way on purpose: once a reader has looked at a card, moving away and back
   * must not re-request. React Query caches the thread for the session on top of
   * that.
   */
  const [engaged, setEngaged] = useState(false);
  const engageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engage = () => {
    if (engaged || engageTimer.current) return;
    engageTimer.current = setTimeout(() => {
      engageTimer.current = null;
      setEngaged(true);
    }, 140);
  };
  const cancelEngage = () => {
    if (!engageTimer.current) return;
    clearTimeout(engageTimer.current);
    engageTimer.current = null;
  };

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * THE DRAWER'S OPEN STATE, moved into JS by the 2026-08-20 card-expansion
   * spec (§1 "Dwell replaces instant fire", §8 "Motion and triggers").
   *
   * It used to be `.card:hover .drawer { height: auto }` — no JS, no state. That
   * was the right shape for "open on hover" and the wrong one for every rule §8
   * adds, none of which CSS can express: a 350ms dwell, a scroll flag, a
   * viewport-bottom guard, and "opening a card closes any other". So the trigger
   * is here and the three cross-card rules are in `lib/card-expansion.ts`.
   *
   * ★★ THE FETCH GATE AND THE OPEN GATE ARE DIFFERENT CLOCKS, ON PURPOSE.
   * `engage` above still fires at 140ms and still only starts the REQUEST; the
   * drawer opens at 350ms. Collapsing them to one 350ms timer would be tidier
   * and would mean the comment arrives 350ms after the pointer lands rather than
   * 140ms, so the drawer would slide open onto an empty box and reflow when the
   * thread resolved. Two clocks buys the fetch a 210ms head start inside the
   * dwell the reader is already spending.
   *
   * ★ `engaged` STAYS ONE-WAY. Once a reader has looked at a card, moving away
   * and back must not re-request. `open` is the one that goes both ways.
   * ═════════════════════════════════════════════════════════════════════════
   */
  /*
   * ★★ THE COMMENT COUNT, CORRECTED ONCE THE THREAD IS KNOWN (2026-08-20, owner
   * report: "the comments are hidden but under the card it says 2").
   *
   * `post.children` is Hivemind's raw count and is blind to BOTH of this
   * product's block mechanisms — the post owner's (server-side, global) and this
   * reader's own (client-side, personal). The hook returns the thread as this
   * reader would actually see it, so its count is the one that matches the page
   * they land on.
   *
   * Same query as the drawer's, same key, deduped by React Query: this adds no
   * request. It is `engaged`-gated for the same reason the drawer is — fetching
   * every thread on feed paint is the regression this screen has already paid
   * for once. So the number self-corrects on hover rather than on paint, which
   * is the accepted trade recorded in the hook's header.
   */
  const { count: visibleComments } = useVisibleDiscussion(post.author, post.permlink, engaged);

  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);

  /*
   * ★ ONE STABLE IDENTITY FOR THE WHOLE MOUNT. `claimOpen`/`releaseOpen` hold
   * this function in a module-level Set, so it has to be the SAME function
   * object every render — a `useCallback` that ever re-created it would leave a
   * stale closer registered and that card could never be closed by another
   * card's claim. Built once in a ref and self-referencing through that ref.
   */
  const closeSelf = useRef<() => void>();
  if (!closeSelf.current) {
    closeSelf.current = () => {
      setOpen(false);
      releaseOpen(closeSelf.current!);
    };
  }

  /* ★ THE DWELL AND CLOSE TIMERS ARE GONE (2026-08-25). Their refs survived the
     hover-to-click rewrite as write-only leftovers — assigned `null` in four
     places and never once armed with a `setTimeout` — which reads to the next
     person as if timing still exists here. It does not: a click opens, a second
     click closes, and nothing is scheduled. Removed rather than left as
     defensive noise. */

  const openNow = () => {
    // §8 "One at a time. Opening a card closes any other."
    claimOpen(closeSelf.current!);
    setOpen(true);
  };

  /*
   * ★ `open` MIRRORED INTO A REF so handlers registered once on mount do not
   * read the first render's permanently-false closure.
   */
  const openRef = useRef(false);
  openRef.current = open;

  /*
   * ★★★ HOVER NO LONGER OPENS ANYTHING (owner, 2026-08-25: "the hover over
   * doesnt work well its annoying. only on clicking empty card it should show
   * drop down").
   *
   * Pointer entry is now nothing but an INTENT HINT. `engage()` still arms the
   * 140ms discussion prefetch, which is why the click feels instant rather than
   * starting a fetch — the data is usually already in flight by the time the
   * reader decides. It no longer arms a dwell and it no longer opens.
   */
  const onCardEnter = () => {
    engage();
  };

  /*
   * ★ LEAVING NO LONGER CLOSES. Under hover-to-open, the pointer leaving meant
   * the reader had stopped reading, so a 200ms grace then close was right. Under
   * click-to-open the drawer is there because the reader ASKED for it, and
   * taking it away because the mouse wandered is the same class of mistake the
   * hover trigger was. It closes on a second click, on another card opening, or
   * on focus leaving — never on the pointer moving.
   */
  const onCardLeave = () => {
    cancelEngage();
  };

  /*
   * ★ FOCUS OPENS WITHOUT A DWELL, and that is a deliberate reading of §10
   * ("Keyboard opening is not specified ... come back for it rather than
   * inventing one"). This is not an invention, it is the behaviour ALREADY
   * SHIPPED — `.card:focus-within` opened the drawer — preserved through the
   * move to JS. Dropping it would be the change, and a regression: the drawer's
   * markup stays in the DOM at `height: 0; overflow: hidden`, so a reader
   * tabbing into the comment's own link would land focus inside a clipped box
   * with nothing visible. A dwell makes no sense here either; focus has no
   * pointer travel to disambiguate.
   */
  const onCardFocus = (e: React.FocusEvent<HTMLElement>) => {
    engage();
    if (open) return;
    /* ★★★ THE PORTAL GUARD AGAIN — FOCUS EDITION (measured 2026-08-25).
       The click handler already rejects events whose target is not a DOM
       descendant of the card, because React bubbles synthetic events along the
       COMPONENT tree. FOCUS is the same story and I missed it first time round:
       opening the overflow menu makes Radix programmatically focus its portaled
       content, that content is a React child of this card, so `onFocus` fired
       here with a target sitting on `document.body`.

       Instrumented proof, not a theory — a document-level `focusin` probe logged
       `{tag:'DIV', inCard:false, focusVisible:true}` at the moment the drawer
       opened. `:focus-visible` was TRUE for it (programmatic focus on a freshly
       opened menu qualifies), so the keyboard test below could never have caught
       it. Every portaled overlay this card owns — menu, popover, hover card,
       dialog — would have opened the drawer behind itself. */
    const focusCard = cardRef.current;
    if (!focusCard || !focusCard.contains(e.target as Node)) return;
    /* ★★★ KEYBOARD FOCUS ONLY — NOT THE FOCUS A CLICK LEAVES BEHIND.
       (Found by testing this change, 2026-08-25, not by reading it.)

       Clicking ANY control in the card focuses it, and focus bubbles, so this
       handler fired on every click of the upvote button, the title, the menu —
       and opened the drawer. Measured before the guard: clicking upvote took the
       drawer false -> true. That is precisely the "clicking other stuff must not
       open it" the owner asked for, and the old hover trigger hid it completely,
       because hover had already opened the card before any click landed.

       `:focus-visible` is the browser's own answer to "did this focus come from
       the keyboard": it is set for tab/arrow focus and NOT for a plain mouse
       click on a button. Using it keeps the keyboard path — a reader tabbing to
       the comment link still gets the drawer opened rather than landing in a
       clipped box — while a pointer user gets nothing they did not ask for.

       Wrapped because `:focus-visible` throws on very old engines rather than
       returning false; a browser that cannot answer must not open the drawer. */
    /* ★ MODALITY, NOT `:focus-visible` — see `lastInputWasKeyboard`'s doc. The
       deciding case is focus RESTORATION: closing the overflow menu hands focus
       back to its trigger inside this card, and that restoration is
       focus-visible, so the element-level test opened the drawer on the way out
       of every menu. What actually distinguishes the two is whether the reader's
       last input was a key or a pointer, which only the event stream knows. */
    if (!lastInputWasKeyboard()) return;
    openNow();
  };
  const onCardBlur = (e: React.FocusEvent<HTMLElement>) => {
    // Focus moving BETWEEN children of the card is not a blur of the card.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    closeSelf.current!();
  };

  /**
   * ★★★ THE ONLY POINTER WAY IN: A CLICK ON THE CARD'S EMPTY SPACE
   * (owner, 2026-08-25).
   *
   * Four guards, and the FIRST is the one that is not obvious:
   *
   * 1. ★★ NOT-IN-CARD. React dispatches synthetic events along the COMPONENT
   *    tree, not the DOM tree. Every Radix overlay this card mounts — the
   *    overflow dropdown, the downvote popover, the payout hover card, the
   *    reblog dialog, the tooltips — portals its content to `document.body`,
   *    and a click inside ANY of them still arrives here. Without this line,
   *    "Copy link", "Block" and the downvote confirm would each toggle the
   *    drawer behind them. The portaled node is not a DOM descendant of the
   *    card, so one `contains` check rejects the whole class at once.
   *
   * 2. Any real control keeps its own behaviour. A link navigates, a button
   *    fires, and neither also opens the drawer.
   *
   * 3. Clicks inside the drawer belong to the drawer — it has its own stretched
   *    link to the comment and its own vote control. Toggling shut underneath
   *    someone reaching for those is exactly the "nothing broken" this must not
   *    do.
   *
   * 4. A click that ends a text selection is not a click on empty space.
   *    Without this, selecting the excerpt and releasing toggles the card.
   */
  const onCardClick = (e: React.MouseEvent<HTMLElement>) => {
    const card = cardRef.current;
    const target = e.target as HTMLElement | null;
    if (!card || !target) return;
    if (!card.contains(target)) return;
    if (
      target.closest(
        'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="dialog"], [contenteditable="true"]'
      )
    ) {
      return;
    }
    if (target.closest('[data-testid="post-card-drawer"]')) return;
    if (window.getSelection()?.toString()) return;
    /* ★ ONLY THE FIRST CLICK OF A MULTI-CLICK COUNTS. A double-click near the
       excerpt opens on click 1, then the browser's own word-selection runs
       before click 2, so the selection guard above blocks the close and the card
       is left open with a stray highlighted word. Ignoring `detail > 1` makes a
       double-click deterministic — it opens, once — instead of depending on
       whether the second click happened to land on selectable text. */
    if (e.detail > 1) return;
    if (openRef.current) closeSelf.current!();
    else openNow();
  };

  // A card unmounted mid-intent (infinite feed recycling a row) must not leave a
  // timer to fire into a dead component, nor a closer registered in the shared
  // Set — a stale entry there would be called on the next card's claim and set
  // state on something that no longer exists.
  useEffect(
    () => () => {
      cancelEngage();
      releaseOpen(closeSelf.current!);
    },
    []
  );

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

  /* ★ MOVED OUT (2026-08-26) to `./lib/post-rubric`, so the profile COMMENT card
     can use the identical rule instead of having no fallback at all. The spec,
     both owner rulings and the reason for the `hive-\d+` shape test all moved
     with it — read them there, not here. */
  const rubric = getPostRubric(post);
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
    const el = thumbnailImgRef.current;
    if (!el) return;

    /**
     * ★★★ THIS TIMER WAS FAILING 80% OF THE FEED (measured 2026-08-18).
     *
     * Fresh browser context, home feed: **24 of 30 thumbnails** rendered
     * "Image unavailable". They had not failed — they had never been REQUESTED.
     * The network log showed exactly 6 image requests, all 200 OK in 89-133ms,
     * matching the 6 cards that survived. The other 24 issued no request at all.
     *
     * The `<img>` is `loading="lazy"`, so the browser correctly defers anything
     * below the fold. But this timer started on MOUNT and fired 2.5s later
     * regardless of whether the browser had begun loading, found
     * `complete === false` — which is simply true of a not-yet-started lazy
     * image — and latched `thumbnailFailed` permanently. Scrolling the card
     * into view afterwards could not clear it: there was no re-arm.
     *
     * So the check was measuring "has this loaded yet", 2.5s after mount, on an
     * element deliberately designed not to load until it is scrolled to. It was
     * guaranteed to fail for every card below the fold on a cold visit, which is
     * most of them — and it looked exactly like a flaky image host, which is why
     * it was blamed on the proxy and then on the API node. It is neither: same
     * measurement, zero requests, zero console errors.
     *
     * The fix is to start counting when the browser starts LOADING, not when
     * React mounts. `loadstart` is the honest signal for that; `complete` covers
     * an image already served from cache before this effect ran. Anything that
     * never starts loading is not failing — it is off-screen, and untouched.
     */
    if (el.complete && el.naturalWidth > 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      if (timer) return;
      timer = setTimeout(() => {
        const current = thumbnailImgRef.current;
        if (!current || (current.complete && current.naturalWidth > 0)) return;
        setThumbnailFailed(true);
      }, DIRECT_TIMEOUT_MS);
    };

    /**
     * ★ `complete === false` DOES NOT MEAN "LOADING" — it is equally true of a
     * lazy image the browser has not touched yet, which is the whole bug above.
     * The two signals that DO separate them:
     *   · `currentSrc` is empty until the browser selects and begins a resource,
     *     so a non-empty one means loading genuinely started (or finished).
     *   · `loadstart` fires at the moment it begins, covering everything that
     *     starts later — i.e. when the reader scrolls it into view.
     * Anything that never starts never arms, and an off-screen card is left
     * alone instead of being declared broken.
     */
    if (el.currentSrc) armTimer();
    el.addEventListener('loadstart', armTimer);
    return () => {
      el.removeEventListener('loadstart', armTimer);
      if (timer) clearTimeout(timer);
    };
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
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-dashed border-[#e0dcd4] bg-[#f9f7f5] p-[18px] font-sans text-[14px] leading-[22px] text-[#6b7280]"
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
      // ★ Drawer intent. `onFocus` as well as pointer, because `:focus-within`
      // opens the drawer for a keyboard reader too and an empty drawer opening
      // under the keyboard would be worse than none. `onFocus` bubbles (unlike
      // `focus` in the DOM), so this catches focus landing on any child.
      ref={cardRef}
      onPointerEnter={onCardEnter}
      onPointerLeave={onCardLeave}
      onFocus={onCardFocus}
      onBlur={onCardBlur}
      onClick={onCardClick}
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
      // same `rounded-panel border-[#ebebeb]` card the rest of Lumen already
      // uses, so this borrows the existing language rather than inventing a
      // second one. Borders only: type, spacing and colour are untouched.
      /*
        ★ `lm-card lm-enter` (2026-08-18) — the card now rises 2px toward the
        cursor and the feed staggers in, using the same easing the vote control
        already used. The product had 31 keyframes defined and zero running on
        this screen; this is the first of them to reach the feed. Both are off
        under prefers-reduced-motion. The flat 0.03-alpha shadow stays as the
        resting state and `--lift-2` takes over on hover.
      */
      className={cn(
        cardStyles.card,
        // `lm-card` / `lm-enter` are the app's own entrance animation and are kept.
        // Everything the old string hardcoded — #ebebeb, white, #fdfcfb and a raw
        // rgba shadow — now lives in `post-card.module.css` as `--pc-*` tokens that
        // resolve to Lumen tokens, so this card follows dark mode for the first time.
        'lm-card lm-enter mb-4'
      )}
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
          className="mb-2.5 flex items-center gap-1.5 text-caption font-medium text-ink-10"
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

      {/* Byline row.

          ★★★ NO-WRAP, AND THE COMMUNITY IS THE PART THAT GIVES (2026-08-25, owner:
          "adjust it so all fit nice").

          This row was `flex-wrap`. With the identity pill moved to the right it has
          two rigid objects in it — the pill (up to 271px on a creator, because it
          carries handle + price + Buy) and the 24px overflow button — and on a
          narrow card there is not enough left for a long community name. Measured
          at 390px: 11 of 30 feed cards broke the byline onto TWO rows, 66-72px tall
          against a normal 40px, dropping the pill below the community. Nothing
          overflowed, so an overflow-only check would have called it clean; it just
          looked loose and unfinished, which is exactly what was reported.

          `flex-nowrap` plus a truncating community is the fix: one row at every
          width, the pill and the menu always intact and always at the right edge,
          and the only thing that degrades is the one element that can degrade
          legibly — a community name shortened with an ellipsis. The right-hand
          group carries `shrink-0` so flex takes the space from the community and
          never from the pill. */}
      <div className="flex flex-nowrap items-center gap-2 text-body-sm text-ink-action">
        {/*
          ★★★ THE QUILL BELONGS IN THE BYLINE (2026-08-18, owner-reported: "no
          feather quill on my profile feed").

          The mark was built to the spec sheet and then wired into exactly ONE
          place — `user-popover-card.tsx`, which only appears once you hover or
          focus a handle. The spec says "18px in bylines", and a feed card IS the
          byline a reader actually sees, so on every card — the home feed, the
          profile Posts tab, anywhere `MediumPostCard` renders — a lite account
          looked identical to a Hive one unless you went hunting with a mouse.

          `liteOverlay` is the same signal the popover's `liteName` uses, and it
          is already resolved above for the display name, so this needs no new
          data. Rules kept verbatim from the spec: 18px, `currentColor` so it
          tracks the handle, no motion, glyph aria-hidden with the accessible
          name on the wrapper.
        */}
        {liteOverlay ? (
          <TooltipProvider delayDuration={140} disableHoverableContent>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  data-testid="lite-account-mark"
                  className="inline-flex items-center text-muted-foreground"
                >
                  <QuillMark size={18} />
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('lite_account.mark_tooltip')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
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
                <Icons.warning className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
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
        {/* ★ THE RUBRIC. Spec: the community name, and where a post has no community
            "the rubric slot shows the post's first tag instead, capitalized, no `#`
            prefix. If there is no tag either, the rubric is omitted (do not leave an
            empty styled slot)."

            It still links to the community's TAG FEED rather than a community page —
            Lumen has no community pages (owner ruling 2026-08-07) and this spec does
            not change that. The tag fallback links to its own topic feed for the same
            reason: same browse surface, filtered.

            ★ THE DATE HAS LEFT THIS ROW. It now sits inline after the title, which is
            where the spec puts it and why it is not here any more. */}
        {rubric ? (
          <Link
            href={`/topics/${rubric.tag}`}
            /* `min-w-0` is what actually allows the shrink — a flex item defaults to
               `min-width:auto`, so without it the name refuses to go below its
               intrinsic width and the row would overflow instead of truncating. */
            className={cn(cardStyles.rubric, 'min-w-0 truncate')}
            data-testid="medium-card-rubric"
          >
            {rubric.label}
          </Link>
        ) : null}

        {/* Creator-token chip (design brief §2) — owner ruling: a token price
            indicator belongs next to every post and every name. Renders
            nothing when the author has no token, or the answer isn't known
            yet; see the component's own doc. */}

        {/* ★★★ THE AUTHOR SIDE SITS RIGHT, THE COMMUNITY SITS LEFT (owner ruling,
            2026-08-25, with a marked-up screenshot: "the pill and the profile pic
            on the side").

            This row used to open with the identity cluster and put the community
            after it — measured on the live card, the pill sat at x=309 against a
            card starting at x=288, i.e. hard left, with the community to its
            RIGHT and 618px of empty row between the pill and the card's right
            edge. The design inverts that: the community label is the first thing
            read, and the author cluster is an object anchored to the opposite
            edge.

            `ml-auto` on this group is what pushes it; the overflow menu that
            follows no longer carries its own `ml-auto`, because two auto margins
            in one flex row would strand the menu away from the pill with a gap
            between them instead of keeping the two together at the edge.

            The rank mark travels WITH the author, not with the community — it is
            a fact about the person, and leaving it behind next to the community
            name would read as a property of the community. */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {mark ? <LeagueByline tier={mark.tier} rankNumber={mark.rankNumber} /> : null}
        {/* ★★★ THE IDENTITY CLUSTER (handoff_identity_pill/SPEC.md, option N1, the
            owner's choice). Face, handle, price and Buy are ONE object now — this
            replaces the separate 26px avatar and handle link that sat here AND the
            `TokenAuthorChip` further along this row. Two components each deciding
            "does this author have a token" was the real duplication; the visual
            doubling was only the symptom. See `identity-pill.tsx` for the click
            model, the 16px overlap arithmetic and the tab-stop ruling. */}
        <IdentityPill handle={displayAuthor} price={price} luminosity={luminosity} />
        </span>

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
        {SHOW_CARD_OVERFLOW_MENU && (block.available || block.unknown) ? (
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
          <div className="relative flex shrink-0">
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
                      /* ★ 40x40 OF REACHABLE AREA, 24x24 OF PAINT (2026-08-23, journey run:
                         "my first click landed 20px off and produced NOTHING - no menu, no
                         feedback"). A near-miss on the only overflow control on an 831px card
                         was silent. The button stays visually 24px so the action row's
                         rhythm is unchanged; `before:-inset-2` adds 8px of invisible,
                         clickable padding on every side, which is 24+16 = 40 exactly. Done
                         with a pseudo-element rather than `h-10 w-10` because the latter also
                         inflates the hover circle to 40px, which reads as a different, heavier
                         control. */
                      'relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
                      "before:absolute before:-inset-2 before:content-['']",
                      'hover:bg-[#f4f5f7] hover:text-[#4b5563]',
                      vote_downvoted ? 'text-[#5b6470] dark:text-[#a3adba]' : 'text-ink-action'
                    )}
                    data-testid="medium-card-overflow-trigger"
                  >
                    <Icons.moreHorizontal className="h-4 w-4" />
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
                {/* ★ A MENU OF TWO HOSTILE ACTIONS IS NOT A MENU (2026-08-23, journey run:
                    "no Mute, no Report, no Copy link, no Share, no Hide ... Downvote sitting
                    directly above Block, which is styled destructive - two adjacent items,
                    both hostile, one mis-click apart"). Copy link is the cheapest honest
                    non-hostile entry: it needs no new endpoint, no new state and no
                    permission, and it is the thing readers most often open this menu for.
                    It sits ABOVE the separator so the destructive half stays visually its
                    own group. */}
                <DropdownMenuItem
                  onSelect={() => {
                    void navigator.clipboard
                      ?.writeText(`${window.location.origin}${href}`)
                      .catch(() => {});
                  }}
                  data-testid="medium-card-copy-link-menu-item"
                >
                  {t('cards.post_card.copy_link')}
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
              className="z-50 max-w-xs rounded-card border border-line-9 bg-popover p-4 shadow-[var(--lift-3)]"
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

      {/* The header rule — see `.bylineRule`. Decorative: the community name and
          the headline carry the structure, so this is hidden from assistive tech
          rather than announced as a separator between them. */}
      <span className={cardStyles.bylineRule} aria-hidden="true" />

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
              <p className="line-clamp-4 text-lede text-ink-4">{displayTitle}</p>
            </Link>
          ) : isNote ? null : (
            <Link href={href} className="block" data-testid="medium-card-title">
              <h2 className={cn(cardStyles.titleRow, 'text-title font-semibold tracking-title text-ink-2')}>
                {/* ★★ THE CLAMP IS ON THE TITLE TEXT, NOT ON THE BOX THAT ALSO HOLDS THE DATE.
                     Measured 2026-08-20: with `line-clamp-2` on the h2 and the date inline
                     inside it, 6 of 20 two-line headlines on the live feed had the date CLIPPED
                     AWAY — the clamp truncates whatever reaches the end of line two, and the
                     date is the last thing there. A date nobody can see is not "next to the
                     title", which is the one thing the spec is emphatic about.
                
                     Clamping an inline-block span instead means the ellipsis lands on the title
                     and the date is a sibling AFTER that box, so it can never be the thing that
                     gets truncated. `align-bottom` keeps it on the last line rather than
                     floating beside a two-line block, which is what "immediately after the
                     title text" means. */}
                <span className={cn(cardStyles.titleText, 'align-bottom')}>{displayTitle}</span>
                {/* ★ THE DATE, INLINE AFTER THE HEADLINE (handoff_identity_pill/SPEC.md).
                    The spec is emphatic about this one: "immediately after the title text,
                    10px gap — NOT pinned to a corner. It must sit next to the headline ...
                    do not float or absolutely-position it, that reads as the date having run
                    away from the title."
                
                    So it is a real inline sibling of the title text INSIDE the h2, which is
                    what makes it wrap with the headline instead of escaping it. It used to
                    live in the byline row beside the community name.
                
                    ★ `font-normal` because the h2 is 600 and a bold date would read as part
                    of the headline. This is the date's only weight, not a size step. */}
                <span className={cardStyles.titleDate}>
                  <TimeAgo date={post.created} />
                </span>
              </h2>
            </Link>
          )}

          {isNote && dek ? (
            <Link href={href} className="block" data-testid="medium-card-note">
              <p className="line-clamp-4 text-lede text-ink-4">{dek}</p>
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
              <p className="line-clamp-2 text-read text-ink-action">{dek}</p>
            </Link>
          ) : null}

          {/* The flag and the way back out. Rendered in the text column rather
              than over the thumbnail so it is still there for a flagged post
              that has no image at all. */}
          {isNsfw ? (
            <div
              className="mt-[10px] flex flex-wrap items-center gap-2 text-caption text-ink-10"
              data-testid="medium-card-nsfw-notice"
            >
              {/* ★ `line-brand-10`/`ink-brand-6`, not `#c0392b` (2026-08-14
                  token-migration pass): border → `line-*`, text → `ink-*`, per
                  `tailwind.config.js`'s own role mapping. */}
              <span className="rounded-control border border-line-brand-10 px-1.5 py-0.5 text-label font-bold uppercase tracking-label text-ink-brand-6">
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
            className="flex h-[132px] w-[190px] shrink-0 items-center justify-center rounded-card border border-dashed border-line-18 bg-surface-16 text-label font-bold uppercase tracking-label text-ink-9"
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
              className="flex h-[132px] w-[190px] flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-[#ded2c2] bg-[#f6efe6] text-label font-bold uppercase tracking-label text-ink-12"
              aria-hidden="true"
            >
              {/*
                ★★★ TF9, THE DESIGNED FALLBACK (2026-08-18). This was a generic
                broken-image glyph, which reads "this app is broken" rather than
                "this one picture did not load" — and roughly half the feed's
                thumbnails reach this state, so it was a large share of what the
                product actually looked like. TF9 is a tinted paper block with a
                dashed trim and the COMMUNITY's initial (the designer's answer to
                which letter: communities repeat down a feed, so the block reads
                as a category rather than noise). Falls back to the title's first
                letter when a post has no community, per the same note.
              */}
              <span
                className="text-title leading-none text-ink-12"
                data-testid="thumbnail-fallback-initial"
              >
                {(post.community_title || post.category || displayTitle || '?').trim().charAt(0).toUpperCase()}
              </span>
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
              className="h-[132px] w-[190px] rounded-card bg-[#f4f5f7] object-contain"
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
        /* ★ 14px, not 18px (2026-08-20, owner-reported: "too much space between the
           text image in the card and the icons and payout below"). 14px is the
           handoff's own number — `handoff_post_card/SPEC.md`'s box model reads
           `.pc__actions flex, align center, gap 24, padding-top 14`. The 18px
           shipped here was never the spec's; it was 4px of drift. */
        className="mt-[14px] flex flex-wrap items-center gap-2.5 text-body-sm"
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
        <div className="flex items-center gap-1 rounded-control px-1 py-1.5">
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
            vertical padding and the same rounded-control. The 2px came entirely
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
        <span className="flex h-9 items-center gap-1 rounded-control px-2.5 py-1.5 font-medium text-ink-action transition-colors hover:bg-[#f4f5f7] hover:text-brand">
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
            /* Hivemind's number until the thread is in hand, this reader's real
               number after. See `useVisibleDiscussion`. */
            comments={visibleComments ?? post.children}
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
                        'flex h-9 items-center gap-1.5 rounded-control px-2.5 py-1.5 font-medium text-ink-action transition-colors hover:bg-[#f4f5f7] hover:text-brand',
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
        {/* ★★★ `ml-auto` ALSO GOES ON THE COMPONENT, NOT ONLY ON THE CHILD
            (2026-08-25). `DetailsCardHover` has two branches — `decline` and
            `payout <= 0` — that return their OWN div and DISCARD `children`, which
            its own header comment warns about. Both accept `className`. So the
            `ml-auto` on the span below is applied ONLY on the normal path, and a
            card whose payout is exactly $0.00, or whose rewards are declined,
            silently lost the auto margin and printed its payout hard against the
            reblog count instead of on the card's right edge.
            ★ THE DECLINE BRANCH IS NOT AN EDGE CASE: every Lumen lite post
            declines rewards by design, so this was the normal rendering for the
            product's own posts. Passing it here fixes all three paths at once. */}
        <DetailsCardHover post={post} decline={payoutDeclined} className="ml-auto">
          <span
            className={cn(
              // Plain green figure, no chip — same reasoning as the vote group above.
              // ★ text-base, not text-sm (2026-08-14, owner-reported): the payout was 14px
              // against a 14.5px vote tally, so the money was the SMALLEST number on
              // the row. It is now 17px (`text-body-lg`), still one step above the
              // 15px tally after the all-Lora bump, so that ruling survives intact.
              //
              // ★ `min-w-[88px] justify-end`, NOT the handoff's fixed `width: 88px`
              // (2026-08-19). The redesign wants money to read as one column down the
              // feed, and a right-aligned minimum width delivers exactly that — while a
              // HARD 88px clips the moment a payout needs more room. Measured: `$1234.56`
              // is ~80px at Lora 17/700 and fits; `$12345.67` does not, and a truncated
              // payout figure is a worse failure than a slightly wide column.
              //
              // ★ `tabular-nums` so a payout ticking up does not reflow the row it is
              // the right-hand end of. Lora has a real `tnum` table (verified), so this
              // selects a genuine cut rather than synthesising one.
              //
              // ★ `--pc-payout` (#2a6b44) replaces the literal #2f7d4f: the redesign
              // deepens the payout green so it sits inside the paper palette instead of
              // glowing out of it. Measured 6.4:1 on the card surface — AA at any size.
              'ml-auto flex h-9 min-w-[88px] items-center justify-end rounded-control px-[6px] py-[6px] text-body-lg font-bold tabular-nums text-[color:var(--pc-payout)] transition-colors hover:cursor-pointer',
              payoutDeclined && 'bg-transparent text-muted-foreground line-through'
            )}
            data-testid="medium-card-payout"
          >
            ${post.payout.toFixed(2)}
          </span>
        </DetailsCardHover>
      </div>

      {/* ★ THE DRAWER, AND THE ONE CONDITION IT DEPENDS ON.
          "No comments: do not expand" is rule 4 of the handoff's selection rule,
          and `post.children` answers it for free from the feed payload we
          already have — so a post nobody has replied to never mounts a drawer,
          never fires a request, and stays a card. No empty state, no disabled
          affordance, no placeholder.

          `children` is the whole subtree rather than direct replies, which makes
          it wrong for RANKING comments (see `lib/top-comment.ts`) but exactly
          right for this gate: any non-zero value means at least one comment
          exists somewhere in the thread. */}
      {post.children > 0 ? (
        <TopCommentDrawer
              author={post.author}
              permlink={post.permlink}
              engaged={engaged}
              open={open}
              postHref={href}
            />
      ) : null}
    </article>
  );
}
