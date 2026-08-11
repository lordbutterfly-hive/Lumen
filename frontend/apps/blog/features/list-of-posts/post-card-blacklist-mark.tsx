import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { useTranslation } from '@/blog/i18n/client';

interface PostCardUpvotesTooltipProps {
  blacklistCheck: boolean;
  blacklists?: string[];
}

const PostCardBlacklistMark = ({ blacklistCheck, blacklists }: PostCardUpvotesTooltipProps) => {
  const { t } = useTranslation('common_blog');
  // Both branches render a bare "(N)" — a screen reader would announce just the
  // digit, with nothing to say it means "blacklisted". The tooltip already carries
  // the real reason; it becomes the accessible name too, not just hover-only text.
  return blacklists && blacklists[0] ? (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger aria-label={`${t('post_content.blacklisted')}: ${blacklists[0]}`}>
          <span className="text-destructive" aria-hidden="true">
            ({blacklists.length})
          </span>
        </TooltipTrigger>
        <TooltipContent>{blacklists[0]}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : blacklistCheck ? (
    <span className="text-destructive" title="My blacklist" aria-label="My blacklist">
      (1)
    </span>
  ) : null;
};

export default PostCardBlacklistMark;
