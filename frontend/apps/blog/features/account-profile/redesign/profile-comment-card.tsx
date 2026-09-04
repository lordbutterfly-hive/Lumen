'use client';

import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { cn, numberWithCommas } from '@ui/lib/utils';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useTranslation } from '@/blog/i18n/client';
import { getPostSummary, normalizeTitle } from '@/blog/lib/utils';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import IdentityPill from '@/blog/features/discovery-feed/identity-pill';
import cardStyles from '@/blog/features/discovery-feed/post-card.module.css';
import { getPostRubric } from '@/blog/features/discovery-feed/lib/post-rubric';
import type { MarketPrice } from '@/blog/features/creator-tokens/types';

/**
 * Reply/comment card for the redesigned profile's "Comments" tab
 * (design-handoff-v2, Profile.dc.html). Same footer grammar as
 * MediumPostCard (real vote control, payout chip) but the header reads
 * "replying to @parent in community" instead of a byline, and the body is
 * the comment's own text rather than a post excerpt+thumbnail.
 */
export default function ProfileCommentCard({
  post,
  price,
  luminosity
}: {
  post: Entry;
  /** Read ONCE for the whole tab by `profile-comments-list`, never here — same
   *  contract as `MediumPostCard`. See `IdentityPill`'s own doc for why a pill
   *  that fetched its own price re-creates the N+1 this feature already paid for. */
  price?: MarketPrice;
  luminosity?: number;
}) {
  const { t } = useTranslation('common_blog');
  // Lumen proxy comments are authored on chain by the shared publishing account.
  // The permlink identifies the post on its own, so the author segment is free to
  // carry the lite identity and the link still resolves.
  const liteOverlay = useLiteOverlay(post);
  const href = `/${post.category}/@${liteOverlay?.author ?? post.author}/${post.permlink}`;
  const body = getPostSummary(post.json_metadata, post.body);
  const payoutDeclined = parseFloat(post.max_accepted_payout) === 0;

  /* ★★ THE TAG FALLBACK (owner, 2026-08-26). This card printed the rubric ONLY
     when `community && community_title`, so a reply under a post with no
     community rendered an EMPTY styled slot — 5 of @gtg's 20 most recent
     comments, raised twice before it was actioned. The feed card has had a
     fallback all along; the two just never shared it. Now they do:
     `getPostRubric` is the single implementation of the rule, including the
     `hive-\d+` shape test that stops a raw community id printing as a tag.

     A reply carries no `tags` of its own, so this resolves through `category` —
     which on a comment is the ROOT post's, i.e. exactly "the topic this reply
     sits under". Measured before building it: all 5 of those comments have a
     real category (`pypt`, `v4vapp`, `blog`, `polish`, `v4vapp`), none a
     `hive-\d+` id, so every previously-empty slot fills and nothing is invented. */
  const rubric = getPostRubric(post);

  return (
    /* ★ THE POST CARD'S OWN SHELL (owner ruling 2026-08-25: the profile cards
       "have to be the same as feed"). This was `rounded-panel border p-[22px]`,
       a second card treatment that only ever appeared on this tab. `mb-4` is
       deliberately NOT copied from the feed card: `profile-comments-list`
       already spaces these with `gap-4`, and both would double it. */
    <article className={cn(cardStyles.card, 'lm-card')}>
      {/* ★★★ THE SAME HEADER AS THE FEED CARD (owner ruling 2026-08-25).
          Community tag left, identity pill right, 1px rule closing the row —
          `flex-nowrap` with a truncating tag for the same reason as the feed
          card: the pill is rigid and the community name is the only thing that
          can degrade legibly. See `medium-post-card.tsx`'s byline note.

          The pill names the COMMENT'S AUTHOR, which is what the posts tab beside
          this one already does — the pill is "who made this", on every surface. */}
      <div className="flex flex-nowrap items-center gap-2 text-body-sm text-ink-action">
        {rubric ? (
          <Link
            href={`/topics/${rubric.tag}`}
            className={cn(cardStyles.rubric, 'min-w-0 truncate')}
            data-testid="profile-comment-rubric"
          >
            {rubric.label}
          </Link>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <IdentityPill handle={post.author} price={price} luminosity={luminosity} />
        </span>
      </div>

      <span className={cardStyles.bylineRule} aria-hidden="true" />

      {/* ★ THE REPLY TARGET SITS UNDER THE RULE (owner's choice, 2026-08-25),
          so the header above stays byte-identical to the feed card and this line
          never competes with the tag or the pill for width. The community moved
          UP into the rubric, so it is deliberately not repeated here. */}
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5 font-sans text-caption text-ink-14">
        <Icons.arrowBigUp className="h-[14px] w-[14px] -rotate-90 text-ink-21" aria-hidden="true" />
        {post.parent_author ? (
          <>
            <span>{t('profile.comment.replying_to_prefix')}</span>
            <Link href={`/@${post.parent_author}`} className="font-semibold text-ink-10 hover:underline">
              @{post.parent_author}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true" className="text-ink-21">
          ·
        </span>
        <TimeAgo date={post.created} />
      </div>

      {post.title ? (
        <Link href={href} className="block">
          {/* Decoded for the same reason as the feed card — see medium-post-card.tsx. */}
          <h3 className="mb-1.5 font-lora text-[18px] leading-[28px] font-semibold text-ink-2">{normalizeTitle(post.title)}</h3>
        </Link>
      ) : null}

      {body ? (
        <Link href={href} className="block">
          <p className="line-clamp-3 font-lora text-[16px] leading-[24px] text-ink-8">{body}</p>
        </Link>
      ) : null}

      {/* Footer — the SAME action bar as MediumPostCard (owner ruling 2026-08-25:
          "the profile cards have to be the same as feed"), minus reblog. This row
          had drifted to its own smaller scale — 14px type, 16px icons, a grey
          font-bold payout — so the owner reported the comment icon "does not match
          the shape/visual of the comments on the post" and payouts that were grey
          (with a hover breakdown) on live comments while $0.00 comments were green
          (no hover). Both were this footer rendering at a scale and colour the feed
          card never uses. It now mirrors `medium-post-card.tsx`'s action bar
          verbatim: `text-[17px]`, 22px icons, and the payout on the shared payout
          green. `flex-wrap` matches the feed too, so the payout drops to its own
          line at narrow widths instead of overflowing. */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2.5 text-[17px]">
        {/* ★ NO PILL INSIDE THE CARD (2026-08-08). Same fix the feed card got:
            a grey capsule sitting on a white card reads as a second, nested
            surface — the owner's words were "a grey pill inside the window", and
            it looked weird. The count keeps its weight from type, not from a
            background. This variant was missed the first time round, so the
            Comments tab kept the pill everywhere else had lost it.
            ★ THE `[&_svg]:h-[16px]` OVERRIDE IS GONE (2026-09-02). The Blade sizes
            itself — `size="sm"` is 22px at feed density (see votes-component.tsx) —
            and this line forced it down to 16px, so the vote arrows AND the comment
            icon beside them were a step smaller than every other card in the app.
            Removing it lets the row render at feed scale, matching the feed card's
            own `-ml-2` vote group. */}
        <div className="flex items-center gap-1 rounded-control -ml-2 py-1.5">
          {/* Same duplicate tally as medium-post-card — see that file's note. */}
          <VotesComponentWrapper post={post} type="comment" />
        </div>

        {/* ★ THE FEED CARD'S COMMENT GLYPH, VERBATIM (2026-09-02, owner issue #2).
            This shipped at `h-4 w-4` (16px) while the feed card renders the SAME
            `Icons.comment` (pressComment) at `h-[22px] w-[22px] stroke-2`, so the
            profile tab's comment icon looked smaller and thinner than everywhere
            else. Same component, same size, same stroke as the feed now. */}
        <span className="flex h-9 items-center gap-1 rounded-control px-2.5 py-1.5 font-medium text-ink-action transition-colors hover:bg-[#f4f5f7] hover:text-brand">
          <PostCardCommentTooltip comments={post.children} url={`${href}/#comments`} iconClassName="h-[22px] w-[22px] stroke-2" />
        </span>

        {/* ★ ml-auto ON THE COMPONENT — its `decline` and `payout <= 0` branches
            return their own div and discard `children`, so the span's margin below
            never applied and $0.00 printed against the comment count. Same fix as
            the feed card. */}
        <DetailsCardHover post={post} decline={payoutDeclined} className="ml-auto">
          <span
            className={cn(
              // ★ THE FEED CARD'S PAYOUT CHIP, VERBATIM (2026-09-02, owner issue #3).
              // This was `text-ink-10` (grey) + `font-bold` + `tabular-nums` (no
              // `font-num`), so a live comment's payout rendered grey, in Merriweather,
              // faux-bolded — WITH a hover breakdown — while a $0.00 comment took
              // DetailsCardHover's `payout <= 0` branch and rendered GREEN, in Fira,
              // no hover. Same money, two colours and two faces, decided by whether the
              // value was zero: exactly the class of bug details-card-hover.tsx's own
              // header comment describes. Now green (`--pc-payout`), `font-num` (Fira),
              // `font-medium`, `text-[17px]` — identical to `medium-post-card.tsx`. All
              // three states agree: >0 is green + hover, $0.00 is green + no hover, and
              // declined is muted + struck (the decline branch below), money one colour.
              'ml-auto flex h-9 min-w-[88px] items-center justify-end rounded-control px-[6px] py-[6px] text-[17px] font-medium font-num text-[color:var(--pc-payout)] transition-colors hover:cursor-pointer',
              payoutDeclined && 'bg-transparent text-muted-foreground line-through'
            )}
          >
            ${numberWithCommas(post.payout.toFixed(2))}
          </span>
        </DetailsCardHover>
      </div>
    </article>
  );
}
