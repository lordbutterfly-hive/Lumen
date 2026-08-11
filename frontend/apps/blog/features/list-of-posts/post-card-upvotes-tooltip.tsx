import { Icons } from '@ui/components/icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';

/** `iconClassName` lets the redesign's feed card run a larger glyph than the classic list. */
const PostCardUpvotesTooltip = ({ votes, iconClassName = 'h-4 w-4' }: { votes: number; iconClassName?: string }) => {
  const { t } = useTranslation('common_blog');
  // Same branching as the tooltip content below, reused as the accessible name so
  // this control (an icon plus a bare digit) says what the digit is, not just its
  // value — a screen reader used to get only the number, with no word "votes" at all.
  const votesLabel =
    votes === 0 ? t('cards.post_card.no_votes') : votes === 1 ? t('cards.post_card.vote') : t('cards.post_card.votes', { votes });
  return (
    <div className="flex items-center">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger className="flex items-center" data-testid="post-total-votes" aria-label={votesLabel}>
            <Icons.chevronUp className={cn(iconClassName, 'sm:mr-1')} aria-hidden="true" />
            {votes}
          </TooltipTrigger>
          <TooltipContent data-testid="post-card-votes-tooltip">
            <p>
              {votes === 0
                ? t('cards.post_card.no_votes')
                : votes > 1
                  ? t('cards.post_card.votes', { votes: votes })
                  : t('cards.post_card.vote')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

export default PostCardUpvotesTooltip;
