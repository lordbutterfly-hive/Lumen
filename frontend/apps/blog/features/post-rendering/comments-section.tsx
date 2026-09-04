'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/blog/i18n/client';
import { commentsSectionClasses } from '@/blog/lib/post-layout-classes';
import CommentList from './comment-list';
import CommentSelectFilter from './comment-select-filter';
import { Button } from '@ui/components/button';
import { Switch } from '@ui/components/switch';
import { Label } from '@ui/components/label';
import type { Entry, IFollowList } from '@hive/common-hiveio-packages/wax';
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
    /**
     * `author/permlink` -> 1-based page. Built in `content.tsx` from the same
     * `pages` array the list renders, for the jump in `useCommentHashArrival`
     * below. Optional so an older caller cannot break the build.
     */
    pageOfKey?: Map<string, number>;
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

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * ARRIVING ON A SINGLE COMMENT (`#@author/permlink`).
     * Card-expansion SPEC.md §9, "Jump to comment".
     *
     * The post card's drawer links straight at one comment. Four rules from §9,
     * and each one is a thing that goes wrong without it:
     *
     * ★★★ 1. RESOLVE THE PAGE FIRST. §9 calls this a blocker in its own right,
     * and it is real here: this list IS paginated (50 main comments a page —
     * `paginatedDiscussionState` in `content.tsx`). A bare hash lands on nothing
     * for any comment past page 1, and "nothing" means the browser leaves the
     * reader at the top of the post with no error. So the page is switched
     * FIRST and the scroll happens on the next pass, once the target exists.
     *
     * ★★ 2. JUMP, DO NOT SMOOTH-SCROLL. §9: "On a long post, animating thousands
     * of pixels is slow and disorienting. Land directly on the comment." Hence
     * `behavior: 'auto'`, deliberately unlike the page-change scroll above,
     * which is a short move the reader asked for.
     *
     * ★★ 3. HEADROOM, NOT PINNED TO THE TOP. §9: "Scroll it into view with
     * headroom above it." A comment flush against the viewport top reads as the
     * start of the page rather than as a place inside a conversation.
     *
     * ★★★ 4. RE-PIN WHILE THE PAGE IS STILL SETTLING. This is §9's OTHER named
     * blocker, handled rather than waited on: "30 of 38 images on post pages
     * ship with no width/height and no aspect-ratio. If the jump happens before
     * the article's images resolve, every image that loads afterwards pushes the
     * anchor down, and the reader lands hundreds or thousands of pixels from the
     * comment they clicked." Giving every image intrinsic dimensions is the
     * right fix and is still worth doing; until then, re-running the scroll
     * while the layout is still moving gets the reader there anyway.
     *
     * The re-pin STOPS the instant the reader scrolls themselves. A jump that
     * keeps yanking the page back is worse than one that lands slightly off,
     * and a wheel/touch/key event is unambiguous intent.
     *
     * ★ NEVER DO NOTHING. §9's fallback: if the comment cannot be resolved — it
     * was deleted, or blocked out of the thread — land at the top of the comment
     * section rather than leaving the reader wherever they happened to be.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const jumpedFor = useRef<string | null>(null);
  /*
   * ★★★ THE RE-PIN OUTLIVES THE EFFECT, AND IT HAS TO. Measured 2026-08-20 on a
   * 9,914px post: scrollY went 183 -> 383 -> 0 and stayed 0 forever, with the
   * target's highlight flashing 9,269px below the reader.
   *
   * The landing worked. What killed it was this effect's own CLEANUP.
   * `paginatedDiscussionState` is a fresh object on every memo pass, so the
   * effect re-runs on ordinary re-renders; React ran the cleanup, the cleanup
   * cleared the re-pin interval, and the re-run returned immediately because
   * `jumpedFor` said the jump was already done. So the ONE thing that could have
   * recovered from the reset had just been switched off by a re-render.
   *
   * Holding the controller in a ref decouples it: a re-render cannot cancel a
   * landing in progress, and only unmount can.
   */
  const repin = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => repin.current?.stop(), []);
    /*
     * ★ A HASH CHANGE ON THE PAGE YOU ARE ALREADY ON is a same-document
     * navigation: nothing remounts and no prop changes, so the effect below
     * would never re-run. That is the case where someone follows a second
     * comment link while already reading the post. Bumping this counter is what
     * makes the effect fire again; `jumpedFor` still guards against re-jumping
     * the SAME fragment, so this cannot loop.
     */
    const [hashTick, setHashTick] = useState(0);
    useEffect(() => {
      const onHash = () => setHashTick((n) => n + 1);
      window.addEventListener("hashchange", onHash);
      return () => window.removeEventListener("hashchange", onHash);
    }, []);
    useEffect(() => {
      const raw = typeof window === 'undefined' ? '' : window.location.hash;
      if (!raw.startsWith('#@')) return;
      const domId = decodeURIComponent(raw.slice(1)); // "@author/permlink"
      const key = domId.slice(1); // "author/permlink", the pagination's own key
      if (jumpedFor.current === domId) return;

      /*
       * ★★★ DO NOT DECLARE THE JUMP DONE BEFORE THE THREAD HAS LOADED. This was a
       * REAL BUG, caught 2026-08-20 by `qa-comment-jump-paged.mjs` against a live
       * 177-comment thread, and it is worth spelling out because it defeated the
       * whole page-resolution step while looking like it worked.
       *
       * This effect first runs on the pass where the post is on screen and the
       * comments are still in flight. `pageOfKey` is empty then, so `wanted` was
       * undefined, `getElementById` found nothing, and the old code took the
       * "cannot resolve" fallback AND set `jumpedFor`. Every later pass — the ones
       * that actually HAD the thread and the page map — then returned early on that
       * flag. The reader was left at the top of the post: exactly the silent
       * failure §9 names, reintroduced by the code meant to prevent it.
       *
       * The fix is to treat "no data yet" as NOT AN ANSWER. It is not a failed
       * lookup, it is an absent one, and that difference is the whole bug.
       */
      const pageOfKey = paginatedDiscussionState.pageOfKey;
      if (!pageOfKey || pageOfKey.size === 0) return;

      const wanted = pageOfKey.get(key);
      if (wanted && wanted !== paginatedDiscussionState.currentPage) {
        /*
         * ★★ SUPPRESS THE PAGE-CHANGE SCROLL, or it fights this one. The effect
         * above scrolls to the TOP of the comments section whenever the page
         * changes — correct when a reader clicks "2", wrong here, where the page
         * change is a means to an end. Both run in the same commit, and that one is
         * `behavior: 'smooth'`, so its animation continues after this one's instant
         * jump and quietly drags the reader back up.
         *
         * Moving the ref forward makes that effect see no change at all — cheaper
         * and less fragile than a second "was this a jump" flag.
         */
        prevCommentsPageRef.current = wanted;
        // Deliberately NOT marked as jumped: this pass only changed the page. The
        // effect runs again when the new page renders, and that pass scrolls.
        setCommentsPage(wanted);
        return;
      }

      const target = document.getElementById(domId);
      if (!target) {
        // The thread IS loaded and the comment still is not in it — deleted, or
        // blocked out of the thread. That is a real answer, so mark it and take
        // §9's fallback rather than leaving the reader where they were.
        jumpedFor.current = domId;
        sectionRef.current?.scrollIntoView({ block: 'start' });
        return;
      }

      // Resolved: the comment is on screen. Mark it so a later re-render does not
      // re-jump under a reader who has since scrolled away.
      jumpedFor.current = domId;

      const HEADROOM_PX = 96;
      const land = () =>
        window.scrollTo({
          top: window.scrollY + target.getBoundingClientRect().top - HEADROOM_PX,
          behavior: 'auto'
        });
      land();

      // Any landing already in flight loses to this one.
      repin.current?.stop();
      let ticks = 0;
      const stop = () => {
        window.clearInterval(timer);
        window.clearTimeout(flash);
        for (const evt of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(evt, stop);
        if (repin.current === controller) repin.current = null;
      };
      const controller = { stop };
      /* 24 ticks, not 12: the reset this recovers from lands at ~700ms, and the
         images that move the anchor keep loading well past three seconds on an
         image-heavy post — which §9 notes are exactly the posts with the longest
         threads. Six seconds of settling, abandoned the instant the reader
         touches the page. */
      const timer = window.setInterval(() => {
        if (++ticks > 24) return stop();
        land();
      }, 250);
      for (const evt of ['wheel', 'touchstart', 'keydown']) {
        window.addEventListener(evt, stop, { passive: true });
      }
      repin.current = controller;

      // §9: "flash a --brand-tint highlight on the target comment for about
      // 600ms, then fade out." One shared global class — `lm-comment-flash` in
      // globals.css, beside the `lm-enter` this list already uses.
      target.classList.add('lm-comment-flash');
      const flash = window.setTimeout(() => target.classList.remove('lm-comment-flash'), 900);
      // Deliberately NO cleanup returned: see the `repin` note above. A re-render
      // must not cancel a landing that is still fighting the page's own layout.
    }, [paginatedDiscussionState, setCommentsPage, hashTick]);


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
          <p className="font-sans text-caption italic text-muted-foreground">
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
