import UserAvatar from '@/blog/features/post-rendering/user-avatar';
import { accountReputation } from '@hive/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/components/popover';
import PopoverCardData from './popover-card-data';
import { useTranslation } from '@/blog/i18n/client';
import { AlertTriangle } from 'lucide-react';

export interface UserPopoverCardProps {
  /**
   * The account that actually signed this post on chain. Every ACTION in the card —
   * follow, mute, the profile lookup — uses this, never the name on screen.
   */
  author: string;
  /**
   * Set only for a Lumen lite author, whose words are published on chain by a shared
   * account. It is what the reader sees, and it is NOT a Hive account: there is no
   * profile to fetch and nothing to follow or mute there, so the card shows the name
   * alone. Passing it as the `author` instead would point Mute at the wrong account
   * (or at an unrelated real Hive user who happens to share the handle).
   */
  liteName?: string;
  author_reputation: number;
  blacklist: string[];
  withImage?: boolean;
}

export function UserPopoverCard({
  author,
  liteName,
  author_reputation,
  blacklist,
  withImage = false
}: UserPopoverCardProps) {
  const { t } = useTranslation('common_blog');
  const shownName = liteName || author;

  return (
    <Popover>
      <PopoverTrigger data-testid="author-name-link" asChild>
        <button className="flex items-center gap-1 hover:cursor-pointer">
          {withImage && <UserAvatar username={shownName} size="normal" />}
          <span className="font-semibold text-foreground hover:text-destructive">{shownName}</span>
          <span
            title={t('post_content.reputation_title')}
            className="text-muted-foreground"
            data-testid="author-reputation"
          >
            ({accountReputation(author_reputation)})
          </span>
          {blacklist && blacklist[0] ? (
            <span title={blacklist[0]}>
              <AlertTriangle className="ml-1 h-4 w-4 text-destructive" />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 border border-border bg-background p-0 shadow-lg" data-testid="user-popover-card-content">
        <PopoverCardData author={author} liteName={liteName} blacklist={blacklist} authorReputation={author_reputation} />
      </PopoverContent>
    </Popover>
  );
}
