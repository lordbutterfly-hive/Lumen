'use client';

import PostCardHidden from '@/blog/features/list-of-posts/post-card-hidden';
import { getPostSummary, Preferences } from '@/blog/lib/utils';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { Badge } from '@ui/components/badge';
import { CardContent, CardDescription, CardTitle } from '@ui/components/card';
import { Separator } from '@ui/components/separator';
import { useTranslation } from '@/blog/i18n/client';
import { Link } from '@hive/ui';

const PostSummary = ({
  post,
  nsfw,
  setNSFW,
  userFromDMCA,
  legalBlockedUser,
  displayAuthor
}: {
  post: Entry;
  nsfw: Preferences['nsfw'];
  setNSFW: (nsfw: Preferences['nsfw']) => void;
  userFromDMCA: boolean;
  legalBlockedUser: boolean;
  /**
   * The name the card's byline is showing. The title and the description are the
   * biggest click targets on a card, so if they routed through the raw chain author
   * while the byline linked to the lite identity, one post would have two different
   * URLs depending on where you clicked.
   */
  displayAuthor?: string;
}) => {
  const { t } = useTranslation('common_blog');
  const revealPost = () => setNSFW(nsfw === 'warn' ? 'show' : 'warn');
  const { user } = useUserClient();
  return (
    <CardContent>
      {nsfw === 'show' ? (
        <>
          <CardTitle data-testid="post-title" className="font-text text-lede">
            {Array.isArray(post.json_metadata?.tags) && post.json_metadata.tags.includes('nsfw') ? (
              <Badge variant="outline" className="mx-1 border-destructive text-destructive">
                nsfw
              </Badge>
            ) : null}
            <Link
              href={`/${post.category}/@${displayAuthor ?? post.author}/${post.permlink}`}
              className="whitespace-normal break-words visited:text-ink-10"
            >
              {post.title}
            </Link>
          </CardTitle>
          <CardDescription className="block w-auto whitespace-pre-wrap break-words font-text md:overflow-hidden md:overflow-ellipsis md:whitespace-nowrap">
            <Link href={`/${post.category}/@${displayAuthor ?? post.author}/${post.permlink}`} data-testid="post-description">
              {userFromDMCA
                ? t('cards.content_removed')
                : legalBlockedUser
                  ? t('global.unavailable_for_legal_reasons')
                  : getPostSummary(post.json_metadata, post.body)}
            </Link>
          </CardDescription>
          <Separator orientation="horizontal" className="my-1" />
        </>
      ) : (
        <PostCardHidden user={user} revealPost={revealPost} />
      )}
    </CardContent>
  );
};

export default PostSummary;
