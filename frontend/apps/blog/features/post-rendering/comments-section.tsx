'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { commentsSectionClasses } from '@/blog/lib/post-layout-classes';
import CommentList from './comment-list';
import CommentSelectFilter from './comment-select-filter';
import { Button } from '@ui/components/button';
import { Switch } from '@ui/components/switch';
import { Label } from '@ui/components/label';
import { Entry, IFollowList } from '@hive/common-hiveio-packages/wax';
// ★ 2026-08-17 — the empty-state composer below (see `replyCount === 0`) reuses
// the SAME composer/gate pieces `content.tsx` already wires up for the post's
// own "Reply" action row, rather than inventing a second one:
//  - `ReplyTextbox` is the one reply/edit composer in the app.
//  - `DialogLogin` is the house pattern for gating a signed-out trigger (used
//    ~24 places, including this exact "Reply" button one scroll up the page).
//  - `useSessionIdentity` answers "is this reader logged in" correctly from
//    the first paint (SSR cookie), unlike raw `useUserClient()` — see that
//    file's own doc comment, and `left-rail.tsx`'s identical import.
//  - `useLiteOverlay` resolves the REAL on-chain author for a Lumen-native
//    post. `postData.author` alone is the wrong value there: it has already
//    been rewritten to the lite display identity, and a reply addressed to
//    it names a chain parent that does not exist (see `content.tsx`'s own
//    `litePost?.chainAuthor || postData.author`, used at every one of its
//    reply/vote/mute call sites for exactly this reason).
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useLiteOverlay } from '@/blog/lib/lite/client/use-lite-overlay';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import DialogLogin from '@/blog/components/dialog-login';
import { ReplyTextbox } from '@/blog/features/post-editor/reply-textbox';
import { EmptyStateIllustration } from '@/blog/components/empty-state-illustration';

interface CommentsSectionProps {
  postData: Entry;
  paginatedDiscussionState: {
    comments: Entry[];
    totalPages: number;
    currentPage: number;
    totalMainComments: number;
  };
  userCanModerate: boolean;
  mutedList: IFollowList[];
  /** True when the viewer's mute-list read failed (retries exhausted) — see
   *  `content.tsx`'s own doc comment on `mutedListUnknown`. Threaded through
   *  to `CommentList` -> `CommentListItem` alongside `mutedList` itself. */
  mutedListUnknown?: boolean;
  flagText: string | undefined;
  discussionAuthor: string;
  discussionPermlink: string;
  observer: string;
  commentsPage: number;
  setCommentsPage: (page: number | ((prev: number) => number)) => void;
}

const CommentsSection = memo(function CommentsSection({
  postData,
  paginatedDiscussionState,
  userCanModerate,
  mutedList,
  mutedListUnknown,
  flagText,
  discussionAuthor,
  discussionPermlink,
  observer,
  commentsPage,
  setCommentsPage
}: CommentsSectionProps) {
  const { t } = useTranslation('common_blog');
  const sectionRef = useRef<HTMLDivElement>(null);
  const prevCommentsPageRef = useRef(commentsPage);
  const [filteringEnabled, setFilteringEnabled] = useState(true);

  /**
   * ★ 2026-08-17 — "Be the first to reply." had no composer anywhere near it:
   * the empty state invited a reply and the only way to act on it was to
   * scroll back up to the post's own Reply button. This wires the SAME
   * composer in, right where the invitation is.
   *
   * `identity`/`user` double-gate matches `content.tsx`'s own mount gate for
   * this exact composer (`{reply && postData && user.isLoggedIn ? ... }`,
   * `content.tsx:2007`): `identity.isLoggedIn` answers instantly from the SSR
   * session cookie and is what the trigger button itself is gated on, but
   * `ReplyTextbox` calls `useUserClient()` internally for the draft storage
   * key, the lite-vs-chain posting branch and the RC gauge — all of which
   * need the real, HYDRATED client user, not the optimistic SSR guess. Only
   * `user.isLoggedIn` proves that has landed.
   */
  const identity = useSessionIdentity();
  const { user } = useUserClient();
  const litePost = useLiteOverlay(postData);
  // Own storage key, deliberately NOT `replybox-/${author}/${permlink}-...` —
  // that is `content.tsx`'s key for the post-header Reply box. Sharing it
  // would let this instance and that one silently fight over one persisted
  // flag; two independent boxes (this one only ever mounts while there are
  // zero replies) is the simpler, safer failure mode than a shared one this
  // file cannot coordinate with `content.tsx` about.
  const replyBoxStorageId = identity.username
    ? `replybox-comments-empty-/${discussionAuthor}/${discussionPermlink}-${identity.username}`
    : '';
  const [replyBoxOpen, storeReplyBoxOpen, removeReplyBoxOpen] = useStorageWithTTL<boolean>(
    replyBoxStorageId,
    false,
    StorageTTL.UI_STATE
  );
  const setReplyBoxOpen = useCallback(
    (open: boolean) => {
      if (open) storeReplyBoxOpen(true);
      else removeReplyBoxOpen();
    },
    [storeReplyBoxOpen, removeReplyBoxOpen]
  );

  // ★ ZERO REPLIES USED TO RENDER "Sort: Trending" AND THEN NOTHING (2026-08-08).
  //
  // `CommentList` maps over the replies whose parent is this post and returns an
  // empty <ul> when there are none, so a post with no comments ended in a sort
  // control governing nothing, followed by blank space — indistinguishable from
  // a feed that failed to load, and inconsistent with the rest of the site,
  // which writes explicit empty-state copy for search, tags, profiles and the
  // witness table.
  //
  // Derived from the SAME predicate `CommentList` filters on (parent author +
  // parent permlink), not from `totalMainComments`, which additionally requires
  // `depth === parent.depth + 1`. Using the looser count would let the two
  // disagree and print "No comments yet" above a rendered comment.
  const replyCount = useMemo(
    () =>
      paginatedDiscussionState.comments.filter(
        (comment) =>
          comment.parent_author === postData.author && comment.parent_permlink === postData.permlink
      ).length,
    [paginatedDiscussionState.comments, postData.author, postData.permlink]
  );

  // ★ MUTED-BY-VIEWER DROPPED FROM THIS COUNT (owner ruling, 2026-08-12). This
  // switch controls `filteringEnabled`, which now only ever reveals the chain-wide
  // low-reputation collapse (`comment.stats?.gray`) — a comment from someone the
  // viewer personally muted or blacklisted is hard-hidden by `comment-list-item.tsx`
  // before this list ever sees it, with no toggle able to bring it back (see
  // `isOwnModerationHide`). Counting it here would advertise a "Reveal" the switch
  // no longer performs.
  const hiddenCount = useMemo(() => {
    return paginatedDiscussionState.comments.filter((comment) => {
      // Skip the post itself (only count its replies)
      if (comment.author === postData.author && comment.permlink === postData.permlink) return false;
      return Boolean(comment.stats?.gray);
    }).length;
  }, [paginatedDiscussionState.comments, postData.author, postData.permlink]);

  useEffect(() => {
    if (prevCommentsPageRef.current !== commentsPage) {
      prevCommentsPageRef.current = commentsPage;
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [commentsPage]);

  const handlePrevPage = useCallback(() => {
    setCommentsPage((prev: number) => Math.max(1, prev - 1));
  }, [setCommentsPage]);

  const handleNextPage = useCallback(() => {
    setCommentsPage((prev: number) => Math.min(paginatedDiscussionState.totalPages, prev + 1));
  }, [setCommentsPage, paginatedDiscussionState.totalPages]);

  const handlePageClick = useCallback(
    (pageNum: number) => {
      setCommentsPage(pageNum);
    },
    [setCommentsPage]
  );

  return (
    <div ref={sectionRef} className={commentsSectionClasses}>
      {replyCount === 0 ? (
        <div className="flex flex-col items-center gap-1.5 py-12 text-center" data-testid="comments-empty">
          {/* ★ Drawn empty state (2026-08-18). A post with no replies was two
              grey lines, which reads as "failed to load" rather than "be the
              first". The drawing carries no meaning the text does not — it is
              aria-hidden. */}
          <EmptyStateIllustration name="empty-comments" size={112} className="mb-1.5" />
          <p className="font-sans text-sm font-semibold text-foreground">
            {t('select_sort.sort_comments.no_comments_title')}
          </p>
          <p className="font-sans text-caption text-muted-foreground">
            {t('select_sort.sort_comments.no_comments_body')}
          </p>
          {/* Same trigger, same copy, same signed-out gate as the post's own
              Reply button (`content.tsx`, "Actions Row") — collapses once the
              box is open rather than sitting there as a second, redundant
              toggle, since `ReplyTextbox` already has its own cancel control. */}
          {!replyBoxOpen ? (
            identity.isLoggedIn ? (
              <button
                type="button"
                onClick={() => setReplyBoxOpen(true)}
                className="mt-2 flex items-center font-medium text-destructive transition-colors hover:text-destructive/80"
                data-testid="comments-empty-reply"
              >
                {t('post_content.footer.reply')}
              </button>
            ) : (
              <DialogLogin>
                <button
                  type="button"
                  className="mt-2 flex items-center font-medium text-destructive transition-colors hover:text-destructive/80"
                  data-testid="comments-empty-reply"
                >
                  {t('post_content.footer.reply')}
                </button>
              </DialogLogin>
            )
          ) : null}
          {replyBoxOpen && user.isLoggedIn ? (
            <div className="mt-4 w-full text-left">
              <ReplyTextbox
                editMode={false}
                onSetReply={setReplyBoxOpen}
                // The real on-chain author, never the (possibly lite-rewritten)
                // display name — see the import comment above.
                username={litePost?.chainAuthor || postData.author}
                permlink={postData.permlink}
                storageId={replyBoxStorageId}
                comment={postData}
                discussionAuthor={discussionAuthor}
                discussionPermlink={discussionPermlink}
                observer={observer}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="my-1 flex items-center justify-between" translate="no">
            {hiddenCount > 0 ? (
              <div className="flex items-center gap-2">
                <Switch
                  id="comment-filter"
                  checked={filteringEnabled}
                  onCheckedChange={setFilteringEnabled}
                  className="h-[20px] w-[36px] data-[state=checked]:bg-destructive data-[state=unchecked]:bg-muted [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4"
                  aria-label={t('select_sort.sort_comments.filter_label')}
                />
                <Label htmlFor="comment-filter" className="cursor-pointer text-caption text-muted-foreground">
                  {t('select_sort.sort_comments.filtered_count', { count: hiddenCount })}
                </Label>
              </div>
            ) : (
              <div />
            )}
            <div className="flex items-center">
              <span className="pr-1">{t('select_sort.sort_comments.sort')}</span>
              <CommentSelectFilter />
            </div>
          </div>
          <CommentList
            highestAuthor={postData.author}
            highestPermlink={postData.permlink}
            permissionToMute={userCanModerate}
            mutedList={mutedList}
            mutedListUnknown={mutedListUnknown}
            data={paginatedDiscussionState.comments}
            flagText={flagText}
            filteringEnabled={filteringEnabled}
            parent={postData}
            parent_depth={postData.depth}
            discussionAuthor={discussionAuthor}
            discussionPermlink={discussionPermlink}
            observer={observer}
          />
          {paginatedDiscussionState.totalPages > 1 && (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handlePrevPage}
                disabled={paginatedDiscussionState.currentPage === 1}
              >
                {t('user_profile.lists.list.previous_button')}
              </Button>
              {Array.from({ length: paginatedDiscussionState.totalPages }, (_, i) => i + 1).map((pageNum) => {
                const showPage =
                  pageNum === 1 ||
                  pageNum === paginatedDiscussionState.totalPages ||
                  (pageNum >= paginatedDiscussionState.currentPage - 2 &&
                    pageNum <= paginatedDiscussionState.currentPage + 2);

                if (!showPage) {
                  if (
                    pageNum === paginatedDiscussionState.currentPage - 3 ||
                    pageNum === paginatedDiscussionState.currentPage + 3
                  ) {
                    return (
                      <span key={pageNum} className="px-2">
                        ...
                      </span>
                    );
                  }
                  return null;
                }

                return (
                  <Button
                    key={pageNum}
                    variant={pageNum === paginatedDiscussionState.currentPage ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => handlePageClick(pageNum)}
                  >
                    {pageNum}
                  </Button>
                );
              })}
              <Button
                variant="outline"
                size="sm"
                onClick={handleNextPage}
                disabled={paginatedDiscussionState.currentPage === paginatedDiscussionState.totalPages}
              >
                {t('user_profile.lists.list.next_button')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default CommentsSection;
