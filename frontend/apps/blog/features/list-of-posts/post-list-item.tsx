'use client';

import { memo, useEffect, useState } from 'react';
import { Link } from '@hive/ui';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { Card, CardFooter, CardHeader } from '@ui/components/card';
import { Icons } from '@ui/components/icons';
import { Separator } from '@ui/components/separator';
import { Badge } from '@ui/components/badge';
import dmcaUserList from '@ui/config/lists/dmca-user-list';
import imageUserBlocklist from '@ui/config/lists/image-user-blocklist';
import userIllegalContent from '@ui/config/lists/user-illegal-content';
import gdprUserList from '@ui/config/lists/gdpr-user-list';
import TimeAgo from '@ui/components/time-ago';
import { getUserAvatarUrl } from '@ui/lib/avatar-utils';
import { accountReputation } from '@hive/ui';
import { IFollowList, Entry } from '@hive/common-hiveio-packages/wax';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { cn } from '@ui/lib/utils';
import { handleError } from '@ui/lib/handle-error';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import DetailsCardHover from './details-card-hover';
import PostImage from './post-img';
import { ReblogDialog } from './reblog-dialog';
import { useReblogMutation } from './hooks/use-reblog-mutation';
import PostCardCommentTooltip from './post-card-comment-tooltip';
import PostCardUpvotesTooltip from './post-card-upvotes-tooltip';
import PostCardBlacklistMark from './post-card-blacklist-mark';
import PostSummary from './summary';
import { Preferences } from '@/blog/lib/utils';
import { isNsfwPost } from '@/blog/lib/nsfw';
import { useTranslation } from '@/blog/i18n/client';
import VotesComponentWrapper from '@/blog/features/votes/votes-component-wrapper';

interface PostListItemProps {
  post: Entry;
  isCommunityPage: boolean | undefined;
  blacklist: IFollowList[] | undefined;
  nsfwPreferences: Preferences['nsfw'];
}

function arePostListItemPropsEqual(prev: PostListItemProps, next: PostListItemProps): boolean {
  // Check primitive props first (fast)
  if (prev.isCommunityPage !== next.isCommunityPage) return false;
  if (prev.nsfwPreferences !== next.nsfwPreferences) return false;
  if (prev.blacklist !== next.blacklist) return false;

  // Check post identity and changing fields
  const prevPost = prev.post;
  const nextPost = next.post;

  return (
    prevPost.author === nextPost.author &&
    prevPost.permlink === nextPost.permlink &&
    prevPost.pending_payout_value === nextPost.pending_payout_value &&
    prevPost.payout === nextPost.payout &&
    prevPost.children === nextPost.children &&
    prevPost.reblogs === nextPost.reblogs &&
    prevPost.stats?.total_votes === nextPost.stats?.total_votes &&
    prevPost.stats?.gray === nextPost.stats?.gray &&
    prevPost.stats?.is_pinned === nextPost.stats?.is_pinned &&
    prevPost.blacklists === nextPost.blacklists &&
    prevPost.author_reputation === nextPost.author_reputation &&
    // The cross-post source drives the whole identity block (author, avatar,
    // reputation, community) and the lite overlay lookup, so a card whose
    // `original_entry` arrives or changes later must re-render.
    prevPost.original_entry === nextPost.original_entry
  );
}

const PostListItem = memo(
  function PostListItem({ post, isCommunityPage, blacklist, nsfwPreferences }: PostListItemProps) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  const reblogMutation = useReblogMutation();
  // ★ Shared with the redesigned MediumPostCard (2026-08-09). Was an exact-case
  // `tags.includes('nsfw')`, which let an `NSFW`/`Nsfw` tag through and ignored
  // the category — the field that puts a post in `/topics/nsfw`. See lib/nsfw.ts.
  const tagExists = isNsfwPost(post);
  const [nsfw, setNSFW] = useState<Preferences['nsfw']>(tagExists ? 'warn' : 'show');
  const reblogCount = post.reblogs ?? 0;

  // A Lumen proxy post arrives from Hivemind authored by the shared publishing
  // account, so without this overlay a lite user's post shows the wrong person's
  // name. Applied to whichever entry we credit, so a cross-post of a lite post still
  // credits the lite author. No-op for ordinary Hive posts.
  //
  // MUST stay above the GDPR early-return below — a hook after a conditional return
  // corrupts hook order for every later render of this list.
  const identityEntry = post.original_entry ?? post;
  const liteOverlay = useLiteOverlay(identityEntry);

  const handleReblog = async () => {
    try {
      await reblogMutation.mutateAsync({ author: post.author, permlink: post.permlink, username: user.username });
    } catch (error) {
      handleError(error, { method: 'reblog', params: { author: post.author, permlink: post.permlink, username: user.username } });
    }
  };

  const dialogAction = (dialogResponse: boolean): void => {
    if (dialogResponse) {
      handleReblog();
    }
  };

  useEffect(() => {
    if (tagExists) {
      setNSFW(nsfwPreferences);
    }
  }, [nsfwPreferences, tagExists]);

  const blacklistCheck = blacklist ? blacklist.some((e) => e.name === post.author) : false;
  const userFromDMCA = dmcaUserList.includes(post.author);
  const userFromImageBlockList = imageUserBlocklist.includes(post.author);
  const legalBlockedUser = userIllegalContent.includes(post.author);

  if (gdprUserList.includes(post.author)) return null;

  // For cross-posts, source identity fields (author name, avatar, reputation,
  // origin community) from the original post. Engagement fields (payout, vote
  // count, comment count, timestamp, clicked URL) remain from this cross-post
  // entry since they describe this specific on-chain object, not the original.
  // Matches the convention used by hive.blog and aligns with peakd / ecency
  // crediting the original content creator.
  //
  // DISPLAY ONLY. Everything that touches the chain or moderation — the reblog
  // mutation, the blacklist/DMCA/GDPR checks above — keeps using `post.author`,
  // which is the account that actually signed the post.
  const displayAuthor = liteOverlay?.author ?? identityEntry.author;
  // Same convention as MediumPostCard's `displayTitle` — used only to build
  // accessible names below (the comment-count link), never rendered as the
  // visible headline, which stays owned by `summary.tsx`.
  const displayTitle = liteOverlay?.title || post.title;
  const displayReputation = post.original_entry?.author_reputation ?? post.author_reputation;
  const displayCommunity = post.original_entry?.community ?? post.community;
  const displayCommunityTitle = post.original_entry?.community_title ?? post.community_title;
  const displayCategory = post.original_entry?.category ?? post.category;

  return (
    <li data-testid="post-list-item" className={post.stats?.gray ? 'opacity-50 hover:opacity-100' : ''}>
      {nsfw === 'hide' ? null : (
        <Card
          // ★ SAME CARD AS THE FEED (owner direction, 2026-08-08). Profile,
          // tag and search lists used a full-bleed row with only a bottom
          // rule (`rounded-none border-0 border-b`), so the same post looked
          // like two different products depending on which page you found it
          // on. Borders only — nothing else about these rows changes.
          className="mb-4 rounded-[18px] border border-[#ebebeb] bg-white px-[22px] py-[22px] text-primary shadow-[0_1px_2px_rgba(20,18,10,0.03)] transition-colors hover:bg-[#fdfcfb]"
        >
          {post.original_entry ? (
            <div className="mt-2 rounded-sm bg-background-secondary px-2 py-1 text-sm" data-testid="cross-post-banner">
              <p className="flex items-center gap-1 text-xs md:text-sm">
                <Icons.crossPost className="h-4 w-4 text-slate-500" />{' '}
                <Link className="hover:cursor-pointer hover:text-destructive" href={`/@${post.author}`} data-testid="cross-post-author-link">
                  {post.author}
                </Link>{' '}
                cross-posted{' '}
                <Link
                  href={`/${post.original_entry.community}/@${displayAuthor}/${post.original_entry.permlink}`}
                  className="text-destructive hover:cursor-pointer"
                  data-testid="cross-post-original-link"
                >
                  @{displayAuthor}/{post.original_entry.permlink}
                </Link>
              </p>
            </div>
          ) : null}
          {post.reblogged_by ? (
            <div className="flex items-center gap-2 py-1 text-sm">
              <Icons.forward className="h-4 w-4" />
              <span data-testid="reblogged-label">
                <Link
                  href={`/@${post.reblogged_by[0]}`}
                  className="cursor-pointer hover:text-destructive"
                  data-testid="reblogged-author-link"
                >
                  {post.reblogged_by[0]}
                </Link>{' '}
                {t('cards.reblogged')}
              </span>
            </div>
          ) : null}
          <CardHeader className="px-0 py-1">
            <div className="md:text-md flex items-center text-sm">
              {nsfw === 'show' && post.blacklists.length < 1 && !blacklistCheck ? (
                // The avatar is a CSS background-image on a plain <div> — unlike
                // MediumPostCard's avatar, there is no <img alt> here for the link to
                // pick up as its name, so without this it was announced as an
                // unnamed link.
                <Link
                  href={`/@${displayAuthor}`}
                  data-testid="post-card-avatar"
                  aria-label={t('cards.post_card.author_profile', { author: displayAuthor })}
                >
                  <div
                    className="mr-3 h-[24px] w-[24px] rounded-3xl bg-cover bg-no-repeat"
                    style={{
                      backgroundImage: `url(${getUserAvatarUrl(displayAuthor, 'small')})`
                    }}
                  />
                </Link>
              ) : null}
              <div className="flex flex-wrap items-center gap-0.5 md:flex-nowrap">
                <Link
                  href={`/@${displayAuthor}`}
                  className="font-medium text-primary hover:cursor-pointer hover:text-destructive"
                  data-testid="post-author"
                >
                  {displayAuthor}
                </Link>{' '}
                <span
                  title={t('post_content.reputation_title')}
                  aria-label={`${t('post_content.reputation_title')} ${accountReputation(displayReputation)}`}
                  className="mr-1 block font-normal"
                  data-testid="post-author-reputation"
                >
                  ({accountReputation(displayReputation)})
                </span>
                <PostCardBlacklistMark blacklistCheck={blacklistCheck} blacklists={post.blacklists} />
                {post.author_role && post.author_role !== 'guest' && isCommunityPage ? (
                  <span className="text-xs md:text-sm">&nbsp;{post.author_role.toUpperCase()}&nbsp;</span>
                ) : null}
                {post.author_title ? (
                  <Badge variant="outline" className="mr-1 border-destructive px-1 py-0 font-thin">
                    {post.author_title}
                  </Badge>
                ) : null}
                <span className="flex items-center text-xs md:text-sm">
                  {!isCommunityPage ? (
                    <>
                      &nbsp;{t('cards.post_card.in')}&nbsp;
                      {displayCommunity ? (
                        <Link
                          href={`/topics/${displayCommunity}`}
                          className="hover:cursor-pointer hover:text-destructive"
                          data-testid="post-card-community"
                        >
                          {displayCommunityTitle}
                        </Link>
                      ) : (
                        <Link
                          href={`/topics/${displayCategory}`}
                          className="hover:cursor-pointer hover:text-destructive"
                          data-testid="post-card-category"
                        >
                          #{displayCategory}
                        </Link>
                      )}
                      <span className="mx-1">•</span>
                    </>
                  ) : null}
                  <Link
                    href={`/${post.category}/@${displayAuthor}/${post.permlink}`}
                    className="hover:cursor-pointer hover:text-destructive"
                    data-testid="post-card-timestamp"
                  >
                    <TimeAgo date={post.created} />
                  </Link>
                  {post.percent_hbd === 0 ? (
                    <span className="ml-1 flex items-center">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger data-testid="powered-up-100-trigger">
                            <Link
                              href={`/${post.category}/@${displayAuthor}/${post.permlink}`}
                              aria-label={t('cards.post_card.powered_up_100')}
                            >
                              <Icons.hive className="h-4 w-4" aria-hidden="true" />
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent data-testid="powered-up-100-tooltip">
                            {t('cards.post_card.powered_up_100')}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                  ) : null}
                  {post.stats && post.stats.is_pinned && isCommunityPage ? (
                    <Badge className="ml-1 bg-destructive text-white hover:bg-destructive">
                      <Link
                        href={`/${post.category}/@${displayAuthor}/${post.permlink}`}
                        data-testid="post-pinned-tag"
                      >
                        {t('cards.badges.pinned')}
                      </Link>
                    </Badge>
                  ) : null}
                </span>
              </div>
            </div>
          </CardHeader>
          <div className="flex w-full flex-col md:flex-row ">
            <div>
              {nsfw === 'show' &&
              post.blacklists.length < 1 &&
              !blacklistCheck &&
              !userFromDMCA &&
              !userFromImageBlockList &&
              !legalBlockedUser ? (
                <>
                  <PostImage post={post} />
                </>
              ) : null}
            </div>
            <div className="w-full md:overflow-hidden">
              <PostSummary
                post={post}
                displayAuthor={displayAuthor}
                nsfw={nsfw}
                setNSFW={setNSFW}
                userFromDMCA={userFromDMCA}
                legalBlockedUser={legalBlockedUser}
              />
              <CardFooter className="pb-2">
                <div className="flex h-5 items-center space-x-2 text-sm" data-testid="post-card-footer">
                  <VotesComponentWrapper post={post} type="post" />

                  <DetailsCardHover post={post} decline={parseFloat(post.max_accepted_payout) === 0}>
                    <div
                      className={`flex items-center hover:cursor-pointer hover:text-destructive ${
                        parseFloat(post.max_accepted_payout) === 0 ? 'text-gray-600 line-through' : ''
                      }`}
                      data-testid="post-payout"
                    >
                      ${post.payout.toFixed(2)}
                    </div>
                  </DetailsCardHover>

                  <Separator orientation="vertical" />
                  {post.stats ? <PostCardUpvotesTooltip votes={post.stats.total_votes} /> : null}
                  <Separator orientation="vertical" />
                  <PostCardCommentTooltip
                    comments={post.children}
                    url={`/${post.category}/@${displayAuthor}/${post.permlink}/#comments`}
                    postTitle={displayTitle}
                  />
                  <Separator orientation="vertical" />
                  {!post.title.includes('RE: ') ? (
                    <div className="flex items-center" data-testid="post-card-reblog">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center">
                              <ReblogDialog author={post.author} permlink={post.permlink} action={dialogAction}>
                                <button
                                  disabled={reblogMutation.isLoading}
                                  className={cn(
                                    'flex items-center cursor-pointer hover:text-destructive',
                                    { 'cursor-not-allowed opacity-50': reblogMutation.isLoading }
                                  )}
                                  data-testid="post-card-reblog-count"
                                  aria-label={`${t('cards.post_card.reblog')} ${displayTitle}`}
                                >
                                  <Icons.forward className="h-4 w-4 sm:mr-1" aria-hidden="true" />
                                  {reblogCount}
                                </button>
                              </ReblogDialog>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent data-testid="post-card-reblog-count-tooltip">
                            <p>{t('cards.post_card.reblog')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  ) : null}
                </div>
              </CardFooter>
            </div>
          </div>
        </Card>
      )}
    </li>
  );
  },
  arePostListItemPropsEqual
);

export default PostListItem;
