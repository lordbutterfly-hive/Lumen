'use client';

import { Entry } from '@hive/common-hiveio-packages/wax';
import { LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import NoDataError from '@/blog/components/no-data-error';
import MediumPostCard from '@/blog/features/discovery-feed/medium-post-card';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import { useAccountEntries } from './hooks/use-account-entries';
import { useTokenPriceChips } from '@/blog/features/creator-tokens/live/use-token-price-chips';
import { useRankLuminosity } from '@/blog/features/retention/hooks/use-rank-marks';

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
  } = useAccountEntries(username, 'posts', observer, initialEntries, lite);
  // Same NSFW list-level filter as the feed (see lib/nsfw.ts): keeps
  // entries.length meaning "posts you will actually see".
  const nsfwPreference = useNsfwPreference();
  const entries = filterVisiblePosts(rawEntries, nsfwPreference);
  /* One market read for the whole page — see the same call in feed-tabs.tsx. */
  const { prices } = useTokenPriceChips(entries.map((e) => e.author));
  /* §2 rank luminosity for the avatar glow — shares `useRankMarks`' request. */
  const luminosity = useRankLuminosity(entries.map((e) => e.author));

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
  // ★ LOADER ONLY WHEN THERE IS GENUINELY NOTHING TO SHOW (2026-09-03). Gating on
  // `isLoading` alone hid the SSR seed: with `initialData` + `initialDataUpdatedAt: 0`
  // (see use-account-entries.ts, seeded stale so the client revalidates), React
  // Query v4 reports `isLoading: true` for the seeded query, so this returned the
  // loader on the server even though `entries` already held 20 seeded posts - the
  // profile's posts never server-rendered. Show what we have; only fall to the
  // loader when the list is actually empty and still loading/fetching.
  if (entries.length === 0 && (isLoading || isFetching))
    return <LumenLoader size="lg" label={t('global.loading_posts')} />;

  if (entries.length === 0) {
    return (
      <p className="py-12 text-center font-sans text-sm italic text-muted-foreground">
        {t('user_profile.no_blogging_yet', { username })}
      </p>
    );
  }

  return (
    <div>
      {entries.map((entry) => (
        <MediumPostCard
            key={`${entry.author}-${entry.permlink}`}
            post={entry}
            price={prices.get(entry.author)}
              luminosity={luminosity.get((entry.author ?? '').toLowerCase())}
          />
      ))}
      {/* ★ THE PAGE CAP (2026-08-13) — same control, same reasoning, as the
          Comments tab beside it. See
          features/discovery-feed/hooks/use-infinite-scroll-sentinel.ts. */}
      <div className="flex items-center justify-center gap-3 py-6">
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
            data-testid="profile-posts-back-to-top"
            className="font-sans text-sm min-h-[24px] text-muted-foreground hover:text-foreground"
          >
            Back to top
          </button>
        ) : null}
      </div>
    </div>
  );
}
