'use client';

import { Icons } from '@ui/components/icons';
import { cn } from '@ui/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { useTranslation } from '@/blog/i18n/client';
import { Link } from '@hive/ui';

interface PostCardCommentTooltipProps {
  comments: number;
  url: string;
  /** Icon sizing override — the redesign's feed card runs larger glyphs than the classic list. */
  iconClassName?: string;
  /**
   * The post's title, so the accessible name says what the count belongs to
   * ("12 responses on <title>") instead of a screen reader announcing a bare
   * icon-only "link" and then a second link with no context beyond a digit.
   * Optional only for the rare caller with no title in scope, where the count
   * alone is still better than silence.
   */
  postTitle?: string;
}

const PostCardCommentTooltip = ({
  comments,
  url,
  iconClassName = 'h-4 w-4',
  postTitle
}: PostCardCommentTooltipProps) => {
  const { t } = useTranslation('common_blog');
  // Unchanged from before — still exactly what the tooltip shows on hover.
  const commentsLabel =
    comments === 0
      ? t('cards.post_card.no_responses')
      : comments === 1
        ? t('cards.post_card.response')
        : t('cards.post_card.responses', { responses: comments });
  // ★ A11Y FIX: both links below used to expose no accessible name at all (the
  // icon-only one) or just a bare digit (the count-only one), so a screen
  // reader announced "link" and then "12, link" with no idea what the 12 was
  // counting. Same value on both, so either one a reader lands on says the
  // whole thing.
  const accessibleLabel = postTitle
    ? comments === 0
      ? t('cards.post_card.no_responses_on', { title: postTitle })
      : comments === 1
        ? t('cards.post_card.response_on', { title: postTitle })
        : t('cards.post_card.responses_on', { responses: comments, title: postTitle })
    : commentsLabel.trim();

  return (
    <div className="flex items-center" data-testid="post-children">
      <TooltipProvider>
        <Tooltip>
          {/* ★ `min-h-[24px]` FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA 2.5.8).
              A control sweep across 29 routes found ~150 controls under the 24x24
              minimum, and they were all this one: the comment count rendered
              40x22 with a single-digit count and 50x22 with two. The 22 came from
              two directions at once - the icon's own `h-[22px]` passed in from
              `medium-post-card.tsx`, and the count link inheriting the footer
              row's `text-body-sm` line-height of 22px - so nothing here ever set
              a height at all. Its neighbours did: the reblog button and payout
              chip were both bumped to `h-9` on 2026-08-15; this control was
              missed.

              ★ THE 2px COSTS NOTHING, AND THAT WAS MEASURED, NOT ASSUMED. The
              footer row's height is set by its tallest child, the vote pill at
              50px (a 38px blade plus 6+6 padding), so a 22->24 change never
              approaches the ceiling. Overriding these three elements to 24px in
              the live DOM and re-measuring five cards: footer row 50px -> 50px
              and card height unchanged on every one, with no overlap against the
              element below. `min-height` rather than a fixed height so the icon
              and the digits keep their own sizes and flex centring absorbs the
              difference invisibly. */}
          {/* ★★ ONE CONTROL, ONE TAB STOP, ONE NAME (2026-08-21, keyboard-only pass).

              This was a `TooltipTrigger` WITHOUT `asChild` wrapping a fragment of TWO
              Links — the icon and the count, each its own anchor to the same url. Radix
              renders its own <button> when not given `asChild`, so the shipped DOM was
              `<button><a/><a/></button>`: interactive content nested in interactive
              content, invalid HTML, and THREE tab stops for one destination. Measured
              live on four cards.

              `asChild` makes the Link itself the trigger, and the icon and count live
              inside that one anchor. The hover colour moved from the count to the whole
              control: with one element there is one hover, and lighting the number while
              its icon stayed dark would advertise two controls again. */}
          <TooltipTrigger asChild>
            <Link
              href={url}
              className="flex min-h-[24px] cursor-pointer items-center hover:text-destructive"
              data-testid="post-card-response-link"
              aria-label={accessibleLabel}
            >
              <Icons.comment className={cn(iconClassName, 'sm:mr-1')} aria-hidden="true" />
              <span className="pl-1 font-num font-medium">{comments}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent data-testid="post-card-responses">
            <p>
              {commentsLabel}
              {t('cards.post_card.click_to_respond')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};
export default PostCardCommentTooltip;
