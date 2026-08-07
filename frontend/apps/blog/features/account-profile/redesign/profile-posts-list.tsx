'use client';

import { Entry } from '@hive/common-hiveio-packages/wax';
import { PostListSkeleton } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import NoDataError from '@/blog/components/no-data-error';
import MediumPostCard from '@/blog/features/discovery-feed/medium-post-card';
import { useAccountEntries } from './hooks/use-account-entries';

/**
 * Posts tab body — reuses the discovery-feed MediumPostCard (the "if it
 * fits" reuse the task asked for: same card grammar as the redesigned
 * homepage feed, just fed the profile's own "blog" entries instead of a
 * ranked feed).
 */
export default function ProfilePostsList({
  username,
  observer,
  initialEntries,
  lite = false
}: {
  username: string;
  observer: string;
  initialEntries?: Entry[] | null;
  lite?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const { entries, isError, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, loadMoreRef } =
    useAccountEntries(username, 'posts', observer, initialEntries, lite);

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
        {t('user_profile.no_blogging_yet', { username })}
      </p>
    );
  }

  return (
    <div>
      {entries.map((entry) => (
        <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
      ))}
      <div className="flex justify-center py-6">
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
