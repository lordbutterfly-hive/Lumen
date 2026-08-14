'use client';

import { useEffect, useState } from 'react';
import { MoreHorizontal, AlertTriangle } from 'lucide-react';
import { Link, UserAvatarImg } from '@hive/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@hive/ui/components/dropdown-menu';
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
  const { user } = useUserClient();
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
            <Link href={`/topics/${post.community}`} className="font-semibold text-[#c0392b] hover:underline">
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('profile.overflow_menu_label')}
                // ★ Contrast fix (2026-08-13, O5 a11y build map item 4). `#9aa1ab`
                // measured 2.61:1 on this button's default white background —
                // `#7a7268` (4.74:1 on white) is the plain-white replacement;
                // the hover state already swaps to the higher-contrast
                // `#4b5563` so the grey-ground variant isn't needed here.
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[#7a7268] transition-colors hover:bg-[#f4f5f7] hover:text-[#4b5563]"
                data-testid="medium-card-overflow-trigger"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
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
          {isNote ? null : (
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
              <span className="rounded-[6px] border border-[#c0392b] px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-[#c0392b]">
                {LABELS.nsfwBadge}
              </span>
              {nsfwPreference === 'show' ? null : (
                <>
                  <span>{LABELS.nsfwNote}</span>
                  <button
                    type="button"
                    onClick={() => setRevealed((value) => !value)}
                    className="font-medium text-[#c0392b] underline-offset-2 hover:underline"
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
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden';
              }}
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
        <div className="flex items-center gap-1 rounded-[10px] px-1 py-1.5 [&_svg]:h-[20px] [&_svg]:w-[20px]">
          {/* ★ The tally lives INSIDE the vote control now (Blade redesign,
              2026-08-14). This sibling printed `total_votes` a second time, so every
              card read "759 759" — measured on the Blade build before removal. The
              control's own tally is the split up/down count Hive actually keeps; this
              one was a single netted number and could never show a downvote. */}
          <VotesComponentWrapper post={post} type="post" />
        </div>

        {/* Comments ghost button */}
        <span className="flex items-center gap-1 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]">
          <PostCardCommentTooltip
            comments={post.children}
            url={`${href}/#comments`}
            iconClassName="h-[20px] w-[20px]"
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
                        'flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]',
                        { 'cursor-not-allowed opacity-50': reblogMutation.isLoading }
                      )}
                      data-testid="medium-card-reblog-count"
                      aria-label={`${LABELS.reblog} ${displayTitle}`}
                    >
                      <Icons.reblog className="h-[20px] w-[20px]" aria-hidden="true" />
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
              'ml-auto flex items-center rounded-[10px] px-[6px] py-[6px] text-base font-bold text-[#2f7d4f] transition-colors hover:cursor-pointer',
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
