'use client';

import { LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import NoDataError from '@/blog/components/no-data-error';
import ProfileCommentCard from './profile-comment-card';
import { useAccountEntries } from './hooks/use-account-entries';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';

/** Comments tab body — reply cards, no SSR-prefetched initial page (see use-account-entries TODO). */
export default function ProfileCommentsList({
  username,
  observer,
  lite = false
}: {
  username: string;
  observer: string;
  lite?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const {
    entries: rawEntries,
    isError,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    loadMoreRef,
    sentinel
  } = useAccountEntries(username, 'comments', observer, undefined, lite);
  // ★ THE SAME `hide` PROMISE AS THE POSTS TAB (2026-08-09). The Posts tab has
  // filtered since the NSFW work landed and this one never did, so a reader on
  // `hide` still saw the same author's replies under an `nsfw` category listed
  // here. Lower stakes than the image surfaces — a comment card renders a
  // text excerpt and no thumbnail — but it is the same setting, and a promise
  // that holds on one tab and not its neighbour is the bug class this whole
  // pass exists to close. Same hook, same function, no new machinery.
  const nsfwPreference = useNsfwPreference();
  const entries = filterVisiblePosts(rawEntries, nsfwPreference);

  // ★★★ AN ERROR ON PAGE 2 MUST NOT DELETE PAGE 1.
  //
  // `isError` on an infinite query goes true when ANY page fails — including a
  // `fetchNextPage` the scroll observer fired on its own, seconds after the
  // first page rendered fine. Returning the error component here threw away
  // content the reader was already looking at and replaced it with "There was a
  // problem fetching the data. Please check if permlink is correct or the node
  // is running properly."
  //
  // That is how a UX tester saw this tab fail while simultaneously capturing a
  // HTTP 200 carrying twenty real comments: both were true. The first page had
  // loaded; a later one had not.
  //
  // Show what we have. Only surrender the whole surface when there is genuinely
  // nothing to show.
  if (isError && entries.length === 0) return <NoDataError />;
  if (isLoading || (isFetching && entries.length === 0))
    return <LumenLoader size="lg" label={t('global.loading_comments')} />;

  if (entries.length === 0) {
    return (
      <p className="py-12 text-center font-sans text-sm italic text-muted-foreground">
        {t('profile.comment.empty', { username })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      {entries.map((entry) => (
        <ProfileCommentCard key={`${entry.author}-${entry.permlink}`} post={entry} />
      ))}
      {/* ★ THE PAGE CAP (2026-08-13). The sentinel below stops paging by itself
          once FEED_AUTO_PAGE_CAP pages are held, so passive scrolling can no
          longer grow this tab without limit — measured before the change:
          `/@lordbutterfly/comments` went from 1,177 to 9,712 DOM elements and
          25MB to 173MB of heap under forty scroll gestures. `loadMore()` grants
          another window and hands paging back to the sentinel; it deliberately
          does NOT fetch, or the reader's click and the sentinel would both fire.
          See features/discovery-feed/hooks/use-infinite-scroll-sentinel.ts. */}
      <div className="flex items-center justify-center gap-3 py-4">
        <button
          ref={loadMoreRef}
          type="button"
          onClick={() => (sentinel.atPageCap ? sentinel.loadMore() : fetchNextPage())}
          disabled={isFetchingNextPage || (!hasNextPage && !isError)}
          className="font-sans text-sm min-h-[24px] text-muted-foreground hover:text-foreground disabled:cursor-default"
        >
          {/* ★ "Loading" while a fetch is FAILING is a lie the reader cannot
              act on. With the retry storm stopped, this is the only remaining
              signal — so it has to say what happened and let them try again. */}
          {isFetchingNextPage
            ? t('global.loading')
            : isError
              ? t('user_profile.load_failed_retry')
              : sentinel.atPageCap
                ? t('cards.comment_card.load_more')
                : hasNextPage
                  ? t('user_profile.load_newer')
                  : t('user_profile.nothing_more_to_load')}
        </button>
        {sentinel.atPageCap ? (
          <button
            type="button"
            onClick={sentinel.backToTop}
            data-testid="profile-comments-back-to-top"
            className="font-sans text-sm min-h-[24px] text-muted-foreground hover:text-foreground"
          >
            Back to top
          </button>
        ) : null}
      </div>
    </div>
  );
}
