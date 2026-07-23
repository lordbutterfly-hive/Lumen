'use client';

import { PostListSkeleton } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import NoDataError from '@/blog/components/no-data-error';
import ProfileCommentCard from './profile-comment-card';
import { useAccountEntries } from './hooks/use-account-entries';

/** Comments tab body — reply cards, no SSR-prefetched initial page (see use-account-entries TODO). */
export default function ProfileCommentsList({ username, observer }: { username: string; observer: string }) {
  const { t } = useTranslation('common_blog');
  const { entries, isError, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, loadMoreRef } =
    useAccountEntries(username, 'comments', observer);

  if (isError) return <NoDataError />;
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
          disabled={!hasNextPage || isFetchingNextPage}
          className="font-sans text-sm text-muted-foreground hover:text-foreground disabled:cursor-default"
        >
          {isFetchingNextPage
            ? t('global.loading')
            : hasNextPage
              ? t('user_profile.load_newer')
              : t('user_profile.nothing_more_to_load')}
        </button>
      </div>
    </div>
  );
}
