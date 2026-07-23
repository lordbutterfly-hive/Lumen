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
  initialEntries
}: {
  username: string;
  observer: string;
  initialEntries?: Entry[] | null;
}) {
  const { t } = useTranslation('common_blog');
  const { entries, isError, isLoading, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, loadMoreRef } =
    useAccountEntries(username, 'blog', observer, initialEntries);

  if (isError) return <NoDataError />;
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
