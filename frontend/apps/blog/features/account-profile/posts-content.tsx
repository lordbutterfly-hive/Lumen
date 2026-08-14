'use client';

import NoDataError from '@/blog/components/no-data-error';
import PostList from '@/blog/features/list-of-posts/posts-loader';
import { PER_PAGE } from '@/blog/features/search/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { DEFAULT_OBSERVER, DEFAULT_PREFERENCES, Preferences, chainObserver } from '@/blog/lib/utils';
import { StaleTime } from '@/blog/lib/react-query';
import { useSSRObserver, useInitialPosts } from '@/blog/components/observer-provider';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchAccountPosts } from '@/blog/lib/lite/client/account-posts-fetch';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { LumenLoader } from '@hive/ui';
import userIllegalContent from '@ui/config/lists/user-illegal-content';
import { useParams } from 'next/navigation';
import {
  FEED_AUTO_PAGE_CAP,
  useInfiniteScrollSentinel
} from '@/blog/features/discovery-feed/hooks/use-infinite-scroll-sentinel';
import { useStorageWithTTL } from '@ui/hooks/useStorageWithTTL';
import { StorageTTL } from '@ui/lib/storage-with-ttl';
import { QueryTypes } from './lib/utils';

const PostsContent = ({ query }: { query: QueryTypes }) => {
  const params = useParams<{ param: string }>();
  const username = params?.param.replace('%40', '') ?? '';
  const legalBlockedUser = userIllegalContent.includes(username);
  const ssrObserver = useSSRObserver();
  const initialPosts = useInitialPosts();
  const { t } = useTranslation('common_blog');
  const { user, isHydrated } = useUserClient();
  // Use SSR observer before hydration to match prefetched cache keys,
  // then switch to client observer (which should be the same value for logged-in users)
  const clientObserver = chainObserver(user);
  const observer = isHydrated ? clientObserver : ssrObserver;
  const [preferences] = useStorageWithTTL<Preferences>(
    user.username ? `user-preferences-${user.username}` : '',
    DEFAULT_PREFERENCES,
    StorageTTL.PERMANENT
  );

  const { data, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage, isError, isLoading } = useInfiniteQuery({
    queryKey: ['accountEntriesInfinite', username, query, observer],
    // ★ SERVER-SIDE, NOT A DIRECT CHAIN READ. See `fetchAccountPosts` for why:
    // the Comments tab can carry this account's replies under someone ELSE's
    // post, and a post owner's block on this author has to remove those from
    // every reader here, not just the blocker's own browser (effect B, see
    // `lib/lite/social/block-filter.ts`). The Posts/Feed tabs never carry a
    // reply (a root post has no parent to block against), so routing them
    // through the same call costs nothing and keeps this component simple.
    queryFn: async ({ pageParam }: { pageParam?: Entry }) => {
      return await fetchAccountPosts(query, username, observer, pageParam?.author, pageParam?.permlink);
    },
    getNextPageParam: (lastPage) => {
      if (lastPage && lastPage.length === PER_PAGE) {
        return {
          author: lastPage[lastPage.length - 1].author,
          permlink: lastPage[lastPage.length - 1].permlink
        };
      }
    },
    enabled: Boolean(username),
    // Server-fetched data passed directly via context, bypassing Hydrate/dehydrate
    initialData: initialPosts ? { pages: [initialPosts], pageParams: [undefined] } : undefined,
    // ★ SEED IT STALE, NOT FRESH (2026-08-13). `Date.now()` here told React Query the
    // server-rendered page was freshly fetched, so the `staleTime` window blocked the
    // `queryFn` — and the queryFn is where Lumen's own engagement (a lite reader's
    // votes and reblogs, which never touch the chain) gets merged in. The SSR seed is
    // a raw chain read with no merge, so a vote a reader had just cast vanished on
    // every reload until the window expired. Verified in a browser: the count reverted
    // 2/2 on this surface while the API itself returned the correct number.
    //
    // 0 means "paint this instantly, then revalidate" — the seed still avoids a
    // loading flash, it just no longer suppresses the merge. Same two-token change
    // already applied to the post page's `postData` query for the same reason; this
    // surface was its twin and was missed.
    initialDataUpdatedAt: initialPosts ? 0 : undefined,
    // ★ A FAILED READ MUST SURFACE FAST (2026-08-13). `/api/account-posts` now
    // THROWS on a degraded upstream read instead of answering `{entries: null}`,
    // which is correct — but this query never overrode React Query's default
    // `retry: 3`, so the honest error it now produces would sit behind three
    // attempts and ~7s of backoff before the reader is told anything. That is the
    // exact "spreads the wait to two more profile tabs" regression the sequencing
    // note warned about. One retry absorbs a genuine blip; three only delays bad news.
    retry: 1,
    staleTime: StaleTime.MEDIUM
  });

  // ★★★ TWO OBSERVERS, ONE EFFECT, TWO FETCHES PER GESTURE (2026-08-13).
  //
  // This ran a 1500px "prefetch" observer AND a 0px observer on the load-more
  // button through a single effect guarded on `!isFetching`. Neither guard was
  // wrong; the input was. `inView` is delivered by IntersectionObserver in a
  // later task, so when the page that just landed pushed both sentinels far
  // below the viewport, the effect re-ran on `isFetching: false` while both
  // booleans still read true and fired again. Measured on :3000 against
  // `/@lordbutterfly/comments`: one scroll to the bottom, then twenty seconds
  // of stillness, produced requests at t+21259ms AND t+21790ms.
  //
  // One sentinel now, at the same 1500px lead — the 0px observer was strictly
  // redundant, since anything visible at 0px is visible at 1500px — and the
  // decision reads the sentinel's live geometry instead of a boolean that is a
  // task behind. The hook also caps how far passive scrolling grows this list.
  // See features/discovery-feed/hooks/use-infinite-scroll-sentinel.ts.
  const sentinel = useInfiniteScrollSentinel({
    hasNextPage,
    isFetching,
    // ★ This list never had the "do not refire into a failure" guard its two
    // siblings got; the shared hook applies the same one here.
    isError,
    fetchNextPage,
    rootMarginPx: 1500,
    pagesLoaded: data?.pages?.length ?? 0,
    autoPageCap: FEED_AUTO_PAGE_CAP
  });

  const getNoContentMessage = () => {
    if (query === 'posts' || query === 'comments')
      return t('user_profile.no_posts_yet', { username: username });
    if (query === 'payout') return t('user_profile.no_pending_payouts');
    if (query === 'replies') return t('user_profile.no_replies_yet', { username: username });
    if (query === 'feed') return t('user_profile.empty_feed_not_following');
    return t('user_profile.no_blogging_yet', { username: username });
  };

  // ★ ONLY WHEN THERE IS NOTHING TO LOSE (2026-08-13). This was an unconditional
  // `if (isError)`, which is safe for a single query and wrong for an INFINITE one:
  // `isError` here covers the LATEST page fetch, including the page-2 request that
  // fires by itself on scroll. `/api/account-posts` now throws honestly on a
  // degraded upstream read instead of returning a silent empty list, and `retry` is
  // 1 rather than 3 — both correct on their own, but together they mean a single
  // hiccup while a reader is 20 comments deep would REPLACE those 20 comments with
  // "nothing to see", destroying content already on screen to report a failure to
  // fetch more of it.
  //
  // The three sibling lists (`profile-posts-list`, `profile-comments-list`,
  // `feed-tabs`) already guard on `entries.length === 0` for exactly this reason;
  // this file got the retry half of the change and not the guard half. Show the
  // error only when the reader would otherwise be left with a blank page.
  if (isError && !data?.pages?.some((page) => (page?.length ?? 0) > 0)) return <NoDataError />;

  if (isLoading || (isFetching && !data?.pages?.[0]?.length)) {
    return <LumenLoader size="lg" label={t('global.loading_posts')} />;
  }

  return !legalBlockedUser ? (
    <>
      {data && data.pages ? (
        <>
          {data.pages[0]?.length !== 0 ? (
            data.pages.map((page, pageIndex) => {
              return page ? (
                <div key={`page-${pageIndex}`}>
                  <PostList
                    data={page}
                    key={`x-${pageIndex}`}
                    nsfwPreferences={preferences.nsfw}
                    testFilter="profile-blog-list"
                  />
                  {/* The separate 1px prefetch trigger that used to sit here is
                      gone: it was the second of the two observers described
                      above, and it only ever rendered when `totalPosts > 10`,
                      so a short list had no prefetch lead at all. The single
                      sentinel on the button below carries the 1500px lead
                      unconditionally. */}
                </div>
              ) : null;
            })
          ) : (
            <div
              className="border-card-empty-border mt-12 border-2 border-solid bg-card-noContent px-4 py-6 text-sm"
              data-testid="user-has-not-started-blogging-yet"
            >
              {getNoContentMessage()}
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              ref={sentinel.ref}
              onClick={() => (sentinel.atPageCap ? sentinel.loadMore() : fetchNextPage())}
              disabled={!hasNextPage || isFetchingNextPage}
            >
              {isFetchingNextPage && data.pages.length > 0 ? (
                <div>Loading...</div>
              ) : sentinel.atPageCap ? (
                t('cards.comment_card.load_more')
              ) : hasNextPage ? (
                t('user_profile.load_newer')
              ) : data.pages[0] && data.pages[0].length > 0 ? (
                t('user_profile.nothing_more_to_load')
              ) : null}
            </button>
            {sentinel.atPageCap ? (
              <button type="button" onClick={sentinel.backToTop} data-testid="posts-content-back-to-top">
                Back to top
              </button>
            ) : null}
          </div>
          <div>{isFetching && !isFetchingNextPage ? 'Background Updating...' : null}</div>
        </>
      ) : null}
    </>
  ) : (
    <div className="p-10">{t('global.unavailable_for_legal_reasons')}</div>
  );
};

export default PostsContent;
