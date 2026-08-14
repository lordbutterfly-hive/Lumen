import { Link } from '@hive/ui';
import parseDate from '@ui/lib/parse-date';
import { Badge } from '@ui/components/badge';
import { useTranslation } from '@/blog/i18n/client';

import ChangeTitleDialog from '../community-profile/change-title-dialog';
import TimeAgo from '@hive/ui/components/time-ago';
import { UserPopoverCard, UserPopoverCardProps } from './user-popover-card';
import TokenAuthorChip from '@/blog/features/creator-tokens/ui/token-author-chip';

interface UserInfoProps extends UserPopoverCardProps {
  permlink: string;
  moderateEnabled: boolean;
  authored?: string;
  community_title: string;
  community: string;
  category: string;
  created: string;
  author_title?: string;
  blacklist: string[];
}

/** Hive addresses a community by an id of this shape; a tag never looks like this. */
const isCommunityId = (value: string): boolean => /^hive-\d+$/i.test(value ?? '');

function UserInfo({
  permlink,
  moderateEnabled,
  authored,
  community,
  community_title,
  category,
  created,
  author,
  liteName,
  author_reputation,
  author_title,
  blacklist
}: UserInfoProps) {
  const { t } = useTranslation('common_blog');
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 py-2 text-sm" data-testid="author-data">
      <UserPopoverCard
        author={author}
        liteName={liteName}
        author_reputation={author_reputation}
        withImage
        blacklist={blacklist}
      />
      {author_title && (
        <Badge variant="outline" className="border-destructive text-ink-info-6" translate="no">
          <span className="mr-1">{author_title}</span>
          <ChangeTitleDialog
            permlink={permlink}
            community={community}
            moderateEnabled={moderateEnabled}
            userOnList={author}
            title={author_title ?? ''}
          />
        </Badge>
      )}
      {!author_title && (
        <ChangeTitleDialog
          permlink={permlink}
          community={community}
          moderateEnabled={moderateEnabled}
          userOnList={author}
          title=""
        />
      )}
      {authored && (
        <span className="text-muted-foreground">
          (authored by{' '}
          <Link className="hover:cursor-pointer hover:text-destructive" href={`/@${authored}`}>
            @{authored}
          </Link>
          )
        </span>
      )}
      <span className="text-muted-foreground">{t('post_content.in')}</span>
      <Link
        href={`/topics/${community_title ? community : category}`}
        className="font-medium text-destructive hover:cursor-pointer hover:underline"
        data-testid={community_title ? 'comment-community-title' : 'comment-category-title'}
        translate="no"
      >
        {/* ★ `#${category}` IS RIGHT FOR A TAG AND WRONG FOR A COMMUNITY.
            A post in a community carries the community's ID as its category —
            `hive-174301` — so when the community title has not resolved, this
            fallback printed "in #hive-174301" and styled it as a topic link.
            The very same post's card in the feed, one click earlier, correctly
            reads "in Sketchbook". A reader cannot interpret a numbered id and
            has no reason to trust a page that shows them one.

            The link itself still works (that URL is how communities are
            addressed), so only the LABEL is wrong. `hive-<digits>` is the
            community-id shape; anything else really is a tag and keeps its
            leading hash. */}
        {community_title || (isCommunityId(category) ? t('post_content.a_community') : `#${category}`)}
      </Link>
      <span className="text-muted-foreground">•</span>
      <span className="text-muted-foreground" title={String(parseDate(created))}>
        <TimeAgo date={created} />
      </span>

      {/* Creator-token chip (design brief §2, "and post pages") — same
          component and same render rule as the feed card's byline. */}
      <TokenAuthorChip handle={author} />
    </div>
  );
}

export default UserInfo;
