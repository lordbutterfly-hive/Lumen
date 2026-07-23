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
}

const PostCardCommentTooltip = ({
  comments,
  url,
  iconClassName = 'h-4 w-4'
}: PostCardCommentTooltipProps) => {
  const { t } = useTranslation('common_blog');
  return (
    <div className="flex items-center" data-testid="post-children">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger className="flex items-center">
            <>
              <Link href={url} className="flex cursor-pointer items-center">
                {comments > 1 ? (
                  <Icons.messagesSquare className={cn(iconClassName, 'sm:mr-1')} />
                ) : (
                  <Icons.comment className={cn(iconClassName, 'sm:mr-1')} />
                )}
              </Link>
              <Link
                href={url}
                className="flex cursor-pointer items-center pl-1 hover:text-destructive"
                data-testid="post-card-response-link"
              >
                {comments}
              </Link>
            </>
          </TooltipTrigger>
          <TooltipContent data-testid="post-card-responses">
            <p>
              {`${
                comments === 0
                  ? t('cards.post_card.no_responses')
                  : comments === 1
                    ? t('cards.post_card.response')
                    : t('cards.post_card.responses', { responses: comments })
              }`}
              {t('cards.post_card.click_to_respond')}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};
export default PostCardCommentTooltip;
