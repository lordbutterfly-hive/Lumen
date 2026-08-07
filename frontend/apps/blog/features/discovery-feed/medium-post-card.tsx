'use client';

import { Link } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { Icons } from '@ui/components/icons';
import TimeAgo from '@ui/components/time-ago';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { cn } from '@ui/lib/utils';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getPostSummary } from '@/blog/lib/utils';
import { find_first_img } from '@/blog/features/list-of-posts/post-img';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';
import { ReblogDialog } from '@/blog/features/list-of-posts/reblog-dialog';
import { useReblogMutation } from '@/blog/features/list-of-posts/hooks/use-reblog-mutation';
import PostCardCommentTooltip from '@/blog/features/list-of-posts/post-card-comment-tooltip';
import PostCardUpvotesTooltip from '@/blog/features/list-of-posts/post-card-upvotes-tooltip';
import DetailsCardHover from '@/blog/features/list-of-posts/details-card-hover';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { LeagueByline } from '@/blog/features/retention/components/league-byline';
import { bylineTierFromReputation } from '@/blog/features/retention/lib/compute-league';

// TODO: move to i18n
const LABELS = {
  in: 'in',
  reblog: 'Reblog'
};

/**
 * Medium-style feed card for a single Hive post: a roomy text column with a
 * larger square thumbnail (only when the post actually has one), followed by
 * the FULL Hive controls row — real vote control (upvote/downvote + weight
 * slider), payout, upvote count, comments, and one-tap reblog. Medium's
 * cleanliness and spacing, Hive's actions. The controls are denser's own
 * components (`VotesComponentWrapper`, `ReblogDialog`, the card tooltips) so
 * voting/reblog behaviour stays identical to the classic feed.
 */
export default function MediumPostCard({ post }: { post: Entry }) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const reblogMutation = useReblogMutation();
  // A Lumen proxy post arrives from Hivemind authored by the shared publishing
  // account, so without this overlay a lite user's post shows the wrong name here.
  // No-op for ordinary Hive posts.
  const liteOverlay = useLiteOverlay(post);
  const displayAuthor = liteOverlay?.author ?? post.author;
  const displayTitle = liteOverlay?.title || post.title;

  const href = `/${post.category}/@${displayAuthor}/${post.permlink}`;
  const dek = getPostSummary(post.json_metadata, post.body);
  const reblogCount = post.reblogs ?? 0;
  const payoutDeclined = parseFloat(post.max_accepted_payout) === 0;
  const isReshare = post.title.includes('RE: ');

  // find_first_img falls back to the author's own avatar when no real post
  // image is found, so every card would always render "something". Medium's
  // card only shows a thumbnail when the post genuinely has one, so treat
  // that specific fallback value as "no image".
  const extractedImage = find_first_img(post);
  const authorAvatarFallback = getUserAvatarUrl(displayAuthor, 'large');
  const thumbnail = extractedImage && extractedImage !== authorAvatarFallback ? extractedImage : '';

  const handleReblog = async () => {
    try {
      await reblogMutation.mutateAsync({ author: post.author, permlink: post.permlink, username: user.username });
    } catch (error) {
      handleError(error, {
        method: 'reblog',
        params: { author: post.author, permlink: post.permlink, username: user.username }
      });
    }
  };

  const dialogAction = (dialogResponse: boolean): void => {
    if (dialogResponse) handleReblog();
  };

  return (
    <article className="mx-[-18px] rounded-2xl border-b border-[#ebebeb] p-[24px_18px] transition-colors hover:bg-[#faf9f6]">
      {/* Reblog provenance line — only present when the underlying query supplies
          it. `EntryFeed` in feed-tabs.tsx fetches the Following tab via
          `bridge.get_account_posts({ sort: 'feed' })` specifically because that
          endpoint (unlike `get_ranked_posts`) carries `reblogged_by`, live-verified
          against api.hive.blog 2026-08-06. Mirrors the classic feed's own marker
          (post-list-item.tsx: Icons.forward + t('cards.reblogged')) so a reblog
          reads the same way everywhere in the app. */}
      {post.reblogged_by && post.reblogged_by.length > 0 ? (
        <div
          className="mb-2.5 flex items-center gap-1.5 font-sans text-[12.5px] font-medium text-[#6b7280]"
          data-testid="medium-card-reblogged-by"
        >
          <Icons.forward className="h-3.5 w-3.5 shrink-0" />
          <Link
            href={`/@${post.reblogged_by[0]}`}
            className="hover:underline"
            data-testid="medium-card-reblogged-by-link"
          >
            {post.reblogged_by[0]}
          </Link>
          <span>{t('cards.reblogged')}</span>
        </div>
      ) : null}

      {/* Byline row */}
      <div className="flex flex-wrap items-center gap-2 font-sans text-[13.5px] text-[#6b7280]">
        <Link href={`/@${displayAuthor}`} className="shrink-0" data-testid="medium-card-avatar">
          <img
            src={getUserAvatarUrl(displayAuthor, 'small')}
            alt={displayAuthor}
            className="h-[26px] w-[26px] rounded-full object-cover"
          />
        </Link>
        <Link
          href={`/@${displayAuthor}`}
          className="font-semibold text-[#2a2822] hover:underline"
          data-testid="medium-card-author"
        >
          {displayAuthor}
        </Link>
        <LeagueByline tier={bylineTierFromReputation(post.author_reputation)} className="ml-0.5" />
        {post.community && post.community_title ? (
          <>
            <span>{LABELS.in}</span>
            <Link
              href={`/trending/${post.community}`}
              className="font-semibold text-[#c0392b] hover:underline"
            >
              {post.community_title}
            </Link>
          </>
        ) : null}
        <span aria-hidden="true" className="text-[#cbd0d6]">
          ·
        </span>
        <TimeAgo date={post.created} />
      </div>

      {/* Body grid — text column + fixed thumbnail column */}
      <div className="mt-[13px] grid grid-cols-[1fr_190px] items-start gap-[26px]">
        <div className="min-w-0">
          <Link href={href} className="block" data-testid="medium-card-title">
            <h2 className="line-clamp-2 font-sans text-[26px] font-semibold leading-[1.22] tracking-[-0.015em] text-[#161511]">
              {displayTitle}
            </h2>
          </Link>

          {dek ? (
            <Link href={href} className="mt-[10px] block" data-testid="medium-card-dek">
              <p className="line-clamp-2 font-serif text-[16.5px] leading-normal text-[#4b5563]">{dek}</p>
            </Link>
          ) : null}
        </div>

        {thumbnail ? (
          <Link href={href} className="shrink-0" data-testid="medium-card-thumbnail">
            <img
              src={thumbnail}
              alt=""
              className="h-[132px] w-[190px] rounded-[14px] object-cover"
              loading="lazy"
            />
          </Link>
        ) : (
          <div
            className="h-[132px] w-[190px] rounded-[14px] bg-[#f4f5f7]"
            aria-hidden="true"
            data-testid="medium-card-thumbnail-placeholder"
          />
        )}
      </div>

      {/* Action bar — denser's own vote/reblog controls, restyled to the redesign.
          Vote arrows keep their real red-up / grey-down treatment (VotesComponent). */}
      <div className="mt-[18px] flex items-center gap-2.5 font-sans text-[14.5px]" data-testid="medium-card-footer">
        {/* Vote pill. The arrows are denser's real VotesComponent, so their size is
            lifted here (21px) rather than in the shared component — the classic
            feed keeps its own scale. The count's chevron is suppressed: next to a
            live up/down pair a third arrow glyph is noise, not information. */}
        <div className="flex items-center gap-1 rounded-[11px] bg-[#f6f7f8] px-2.5 py-1.5 [&_svg]:h-[21px] [&_svg]:w-[21px]">
          <VotesComponentWrapper post={post} type="post" />
          {post.stats ? (
            <span className="flex items-center pl-1 font-bold tabular-nums text-[#2a2822]">
              <PostCardUpvotesTooltip votes={post.stats.total_votes} iconClassName="hidden" />
            </span>
          ) : null}
        </div>

        {/* Comments ghost button */}
        <span className="flex items-center gap-1 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]">
          <PostCardCommentTooltip
            comments={post.children}
            url={`${href}/#comments`}
            iconClassName="h-[20px] w-[20px]"
          />
        </span>

        {/* Reblogs ghost button */}
        {!isReshare ? (
          <div data-testid="medium-card-reblog">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ReblogDialog author={post.author} permlink={post.permlink} action={dialogAction}>
                    <button
                      disabled={reblogMutation.isLoading}
                      className={cn(
                        'flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 font-medium text-[#6b7280] transition-colors hover:bg-[#f4f5f7] hover:text-[#2a2822]',
                        { 'cursor-not-allowed opacity-50': reblogMutation.isLoading }
                      )}
                      data-testid="medium-card-reblog-count"
                    >
                      <Icons.reblog className="h-[20px] w-[20px]" />
                      {reblogCount}
                    </button>
                  </ReblogDialog>
                </TooltipTrigger>
                <TooltipContent data-testid="medium-card-reblog-tooltip">{LABELS.reblog}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : null}

        {/* Payout chip */}
        <DetailsCardHover post={post} decline={payoutDeclined}>
          <span
            className={cn(
              'ml-auto flex items-center rounded-[10px] bg-[#e9f5ee] px-[13px] py-[6px] text-sm font-bold text-[#2f7d4f] transition-colors hover:cursor-pointer',
              payoutDeclined && 'bg-transparent text-muted-foreground line-through'
            )}
            data-testid="medium-card-payout"
          >
            ${post.payout.toFixed(2)}
          </span>
        </DetailsCardHover>
      </div>
    </article>
  );
}
