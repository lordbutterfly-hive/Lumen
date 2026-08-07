'use client';

import { Link } from '@hive/ui';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { cn, numberWithCommas } from '@ui/lib/utils';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useTranslation } from '@/blog/i18n/client';
import { getPostSummary } from '@/blog/lib/utils';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import PostCardUpvotesTooltip from '@/blog/features/list-of-posts/post-card-upvotes-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';

/**
 * Reply/comment card for the redesigned profile's "Comments" tab
 * (design-handoff-v2, Profile.dc.html). Same footer grammar as
 * MediumPostCard (real vote control, payout chip) but the header reads
 * "replying to @parent in community" instead of a byline, and the body is
 * the comment's own text rather than a post excerpt+thumbnail.
 */
export default function ProfileCommentCard({ post }: { post: Entry }) {
  const { t } = useTranslation('common_blog');
  // Lumen proxy comments are authored on chain by the shared publishing account.
  // The permlink identifies the post on its own, so the author segment is free to
  // carry the lite identity and the link still resolves.
  const liteOverlay = useLiteOverlay(post);
  const href = `/${post.category}/@${liteOverlay?.author ?? post.author}/${post.permlink}`;
  const body = getPostSummary(post.json_metadata, post.body);
  const payoutDeclined = parseFloat(post.max_accepted_payout) === 0;

  return (
    <article className="rounded-2xl border border-[#ebebeb] bg-white p-[20px_22px] transition-colors hover:border-[#e0ddd6]">
      {/* "replying to @x in community" header */}
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5 font-sans text-[13px] text-[#9ca3af]">
        <Icons.arrowBigUp className="h-[14px] w-[14px] -rotate-90 text-[#c8ccd2]" aria-hidden="true" />
        {post.parent_author ? (
          <>
            <span>{t('profile.comment.replying_to_prefix')}</span>
            <Link href={`/@${post.parent_author}`} className="font-semibold text-[#6b7280] hover:underline">
              @{post.parent_author}
            </Link>
          </>
        ) : null}
        {post.community && post.community_title ? (
          <>
            <span>{t('profile.comment.in_community_prefix')}</span>
            <Link href={`/trending/${post.community}`} className="font-semibold hover:underline">
              {post.community_title}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true" className="text-[#cbd0d6]">
          ·
        </span>
        <TimeAgo date={post.created} />
      </div>

      {post.title ? (
        <Link href={href} className="block">
          <h3 className="mb-1.5 font-sans text-[18px] font-semibold text-[#161511]">{post.title}</h3>
        </Link>
      ) : null}

      {body ? (
        <Link href={href} className="block">
          <p className="line-clamp-3 font-serif text-[15.5px] leading-normal text-[#4b5563]">{body}</p>
        </Link>
      ) : null}

      {/* Footer — same control grammar as MediumPostCard's action bar, minus reblog. */}
      <div className="mt-3.5 flex items-center gap-2 font-sans text-[13.5px]">
        <div className="flex items-center gap-1 rounded-[11px] bg-[#f6f7f8] px-2 py-1.5 [&_svg]:h-[16px] [&_svg]:w-[16px]">
          <VotesComponentWrapper post={post} type="comment" />
          {post.stats ? (
            <span className="flex items-center pl-1 font-bold tabular-nums text-[#2a2822]">
              <PostCardUpvotesTooltip votes={post.stats.total_votes} iconClassName="hidden" />
            </span>
          ) : null}
        </div>

        <span className="flex items-center gap-1 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]">
          <PostCardCommentTooltip comments={post.children} url={`${href}/#comments`} iconClassName="h-4 w-4" />
        </span>

        <DetailsCardHover post={post} decline={payoutDeclined}>
          <span
            className={cn(
              'ml-auto flex items-center rounded-[10px] bg-[#f4f5f7] px-[13px] py-[6px] text-[13.5px] font-bold tabular-nums text-[#6b7280] transition-colors hover:cursor-pointer',
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
