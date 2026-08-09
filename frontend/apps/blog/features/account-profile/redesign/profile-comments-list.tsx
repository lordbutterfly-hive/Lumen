'use client';

import { PostListSkeleton } from '@hive/ui';
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
    loadMoreRef
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
  if (isLoading || (isFetching && entries.length === 0)) return <PostListSkeleton count={4} />;

  if (entries.length === 0) {
    return (
      <p className="py-12 text-center font-sans text-sm text-muted-foreground">
        {t('profile.comment.empty', { username })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      {entries.map((entry) => (
        <ProfileCommentCard key={`${entry.author}-${entry.permlink}`} post={entry} />
      ))}
      <div className="flex justify-center py-4">
        <button
          ref={loadMoreRef}
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage || (!hasNextPage && !isError)}
          className="font-sans text-sm text-muted-foreground hover:text-foreground disabled:cursor-default"
        >
          {/* ★ "Loading" while a fetch is FAILING is a lie the reader cannot
              act on. With the retry storm stopped, this is the only remaining
              signal — so it has to say what happened and let them try again. */}
          {isFetchingNextPage
            ? t('global.loading')
            : isError
              ? t('user_profile.load_failed_retry')
              : hasNextPage
                ? t('user_profile.load_newer')
                : t('user_profile.nothing_more_to_load')}
        </button>
      </div>
    </div>
  );
}
