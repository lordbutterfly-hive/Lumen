'use client';

import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { cn, numberWithCommas } from '@ui/lib/utils';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useTranslation } from '@/blog/i18n/client';
import { getPostSummary, normalizeTitle } from '@/blog/lib/utils';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import IdentityPill from '@/blog/features/discovery-feed/identity-pill';
import cardStyles from '@/blog/features/discovery-feed/post-card.module.css';
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
        {post.community && post.community_title ? (
          <Link
            href={`/topics/${post.community}`}
            className={cn(cardStyles.rubric, 'min-w-0 truncate')}
            data-testid="profile-comment-rubric"
          >
            {post.community_title}
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
          <h3 className="mb-1.5 font-sans text-[18px] leading-[28px] font-semibold text-ink-2">{normalizeTitle(post.title)}</h3>
        </Link>
      ) : null}

      {body ? (
        <Link href={href} className="block">
          <p className="line-clamp-3 font-serif text-[16px] leading-[24px] text-ink-8">{body}</p>
        </Link>
      ) : null}

      {/* Footer — same control grammar as MediumPostCard's action bar, minus reblog. */}
      <div className="mt-3.5 flex items-center gap-2 font-sans text-[14px] leading-[22px]">
        {/* ★ NO PILL INSIDE THE CARD (2026-08-08). Same fix the feed card got:
            a grey capsule sitting on a white card reads as a second, nested
            surface — the owner's words were "a grey pill inside the window", and
            it looked weird. The count keeps its weight from type, not from a
            background. This variant was missed the first time round, so the
            Comments tab kept the pill everywhere else had lost it. */}
        <div className="flex items-center gap-1 py-1.5 [&_svg]:h-[16px] [&_svg]:w-[16px]">
          {/* Same duplicate tally as medium-post-card — see that file's note. */}
          <VotesComponentWrapper post={post} type="comment" />
        </div>

        <span className="flex items-center gap-1 rounded-control px-2.5 py-1.5 font-medium text-ink-10 transition-colors hover:bg-surface-21 hover:text-ink-4">
          <PostCardCommentTooltip comments={post.children} url={`${href}/#comments`} iconClassName="h-4 w-4" />
        </span>

        {/* ★ ml-auto ON THE COMPONENT — its `decline` and `payout <= 0` branches
            return their own div and discard `children`, so the span's margin below
            never applied and $0.00 printed against the comment count. Same fix as
            the feed card. */}
        <DetailsCardHover post={post} decline={payoutDeclined} className="ml-auto">
          <span
            className={cn(
              // Payout is flat too — same reason as the vote group above.
              'ml-auto flex items-center px-[3px] py-[6px] text-[14px] leading-[22px] font-bold tabular-nums text-ink-10 transition-colors hover:cursor-pointer hover:text-ink-4',
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
