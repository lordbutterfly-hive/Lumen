'use client';

import { useEffect, useState } from 'react';
import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { getUserAvatarDirectUrl, getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { cn } from '@ui/lib/utils';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getPostSummary } from '@/blog/lib/utils';
import { find_first_img } from '@/blog/features/list-of-posts/post-img';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { ReblogDialog } from '@/blog/features/list-of-posts/reblog-dialog';
import { useReblogMutation } from '@/blog/features/list-of-posts/hooks/use-reblog-mutation';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import PostCardUpvotesTooltip from '@/blog/features/list-of-posts/post-card-upvotes-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import { LeagueByline } from '@/blog/features/retention/components/league-byline';
import type { RankMark } from '@/blog/features/retention/hooks/use-rank-marks';
import TokenAuthorChip from '@/blog/features/creator-tokens/ui/token-author-chip';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { isNsfwPost, useNsfwPreference } from '@/blog/lib/nsfw';

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
  const reblogMutation = useReblogMutation();
  // A Lumen proxy post arrives from Hivemind authored by the shared publishing
  // account, so without this overlay a lite user's post shows the wrong name here.
  // No-op for ordinary Hive posts.
  const liteOverlay = useLiteOverlay(post);
  const displayAuthor = liteOverlay?.author ?? post.author;
  const displayTitle = liteOverlay?.title || post.title;

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
          className="mb-2.5 flex items-center gap-1.5 font-sans text-[12.5px] font-medium text-[#6b7280]"
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
      <div className="flex flex-wrap items-center gap-2 font-sans text-[13.5px] text-[#6b7280]">
        <Link href={`/@${displayAuthor}`} className="shrink-0" data-testid="medium-card-avatar">
          {/* ★ STRAIGHT TO THE IMAGE HOST (2026-08-10). This one line was 29 requests
              to our own `/api/avatar` per feed page, 6.0-6.3s each on a warm server,
              19 of them still unreturned 45s in — see the long note on
              `getUserAvatarDirectUrl`. The proxy stays as the error path, which is
              what keeps lite accounts and dead profile images working. */}
          <img
            src={getUserAvatarDirectUrl(displayAuthor, 'small')}
            alt={displayAuthor}
            className="h-[26px] w-[26px] rounded-full object-cover"
            loading="lazy"
            decoding="async"
            onError={(e) => {
              // A flag, not a src comparison: `img.src` reads back ABSOLUTE, and the
              // proxy URL is relative, so comparing them would never match and the
              // failing proxy would re-trigger this handler forever.
              const img = e.currentTarget;
              if (img.dataset.fellBack === '1') return;
              img.dataset.fellBack = '1';
              img.src = getUserAvatarUrl(displayAuthor, 'small');
            }}
          />
        </Link>
        <Link
          href={`/@${displayAuthor}`}
          className="font-semibold text-[#2a2822] hover:underline"
          data-testid="medium-card-author"
        >
          {displayAuthor}
        </Link>
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
      <div
        className={cn(
          'mt-[13px] grid items-start gap-[26px]',
          !nsfwShown || thumbnail ? 'grid-cols-[1fr_190px]' : 'grid-cols-1'
        )}
      >
        <div className="min-w-0">
          <Link href={href} className="block" data-testid="medium-card-title">
            <h2 className="line-clamp-2 font-sans text-[26px] font-semibold leading-[1.22] tracking-[-0.015em] text-[#161511]">
              {displayTitle}
            </h2>
          </Link>

          {dek ? (
            <Link href={href} className="mt-[10px] block" data-testid="medium-card-dek">
              <p className="line-clamp-2 font-serif text-[16.5px] leading-normal text-[#4b5563]">{dek}</p>
            </Link>
          ) : null}

          {/* The flag and the way back out. Rendered in the text column rather
              than over the thumbnail so it is still there for a flagged post
              that has no image at all. */}
          {isNsfw ? (
            <div
              className="mt-[10px] flex flex-wrap items-center gap-2 font-sans text-[13px] text-[#6b7280]"
              data-testid="medium-card-nsfw-notice"
            >
              <span className="rounded-[6px] border border-[#c0392b] px-1.5 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide text-[#c0392b]">
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
            className="flex h-[132px] w-[190px] items-center justify-center rounded-[14px] border border-dashed border-[#e0dcd4] bg-[#f4f5f7] font-sans text-[12px] font-medium uppercase tracking-wide text-[#9aa1ab]"
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
          >
            <img
              src={thumbnail}
              alt=""
              className="h-[132px] w-[190px] rounded-[14px] bg-[#f4f5f7] object-cover"
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
      <div className="mt-[18px] flex items-center gap-2.5 font-sans text-[14.5px]" data-testid="medium-card-footer">
        {/* Vote pill. The arrows are denser's real VotesComponent, so their size is
            lifted here (21px) rather than in the shared component — the classic
            feed keeps its own scale. The count's chevron is suppressed: next to a
            live up/down pair a third arrow glyph is noise, not information. */}
        {/* ★ NO PILL INSIDE THE CARD (2026-08-08). The vote controls sat in their
            own grey rounded box, which read as a card inside a card once each
            post got its own border. The vote count keeps its weight from type,
            not from a background. Hover still lights each control, matching the
            comment and reblog buttons beside it. */}
        <div className="flex items-center gap-1 rounded-[10px] px-1 py-1.5 [&_svg]:h-[21px] [&_svg]:w-[21px]">
          <VotesComponentWrapper post={post} type="post" />
          {post.stats ? (
            <span className="flex items-center pl-1 font-bold tabular-nums text-[#2a2822]">
              <PostCardUpvotesTooltip votes={post.stats.total_votes} iconClassName="hidden" />
            </span>
          ) : null}
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
              'ml-auto flex items-center rounded-[10px] px-[6px] py-[6px] text-sm font-bold text-[#2f7d4f] transition-colors hover:cursor-pointer',
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
