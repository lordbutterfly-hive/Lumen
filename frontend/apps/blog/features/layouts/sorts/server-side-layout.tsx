import { getObserverFromCookies } from '@/blog/lib/auth-utils';
import { getCommunities, getSubscriptions } from '@transaction/lib/bridge-api';
import { ReactNode } from 'react';
import { getLogger } from '@ui/lib/logging';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import {
  ObserverProvider,
  InitialCommunitiesProvider,
  InitialSubscriptionsProvider
} from '@/blog/components/observer-provider';

const sort = 'rank';
const query = null;

const logger = getLogger('app');

/**
 * ★★ THE COMMUNITY LIST IS THE OTHER 600ms (measured 2026-08-15).
 *
 * This layout wraps the sorted-feed routes, so `getCommunities` runs on each of
 * them. Timed from this box, `bridge.list_communities` answers in **629ms**, and
 * `/communities` measured 990ms cold / 335ms warm TTFB — the second-slowest
 * server route after the profile page, for the same reason: one slow upstream
 * read with no cross-request memory.
 *
 * A ranked list of communities is about as static as anything this app fetches —
 * names, titles and rank order, changing over hours. Five minutes of staleness
 * is invisible to a reader and removes the call from almost every page view.
 *
 * ★ KEYED ON THE OBSERVER, not global. `getCommunities` takes the observer, and
 * the response can carry viewer-dependent context; sharing one entry across
 * accounts would leak one reader's view of the list to another. Signed-out
 * readers all share `DEFAULT_OBSERVER`, which is where the bulk of cold traffic
 * is anyway, so they get the benefit with no cross-account risk. 200 entries
 * bounds it, and a failed read is never stored (see `server-ttl-cache.ts` — a
 * cached failure would blank the community rail for everyone for five minutes).
 *
 * Subscriptions are deliberately NOT cached: they change the moment a reader
 * joins or leaves a community, and that has to be visible immediately.
 */
const getCommunitiesCached = withTtlCache(
  getCommunities,
  (_sort: string, _query: string | null, observer?: string) => `${_sort}|${_query ?? ''}|${observer ?? ''}`,
  { ttlMs: 300_000, max: 200 }
);

const ServerSideLayout = async ({ children }: { children: ReactNode }) => {
  const observer = await getObserverFromCookies();
  const isLoggedIn = observer !== DEFAULT_OBSERVER;
  // Fetch communities (always) and subscriptions (logged-in) in parallel
  const [communitiesResult, subscriptionsResult] = await Promise.allSettled([
    getCommunitiesCached(sort, query, observer),
    isLoggedIn ? getSubscriptions(observer) : Promise.resolve(null)
  ]);
  const communitiesData =
    communitiesResult.status === 'fulfilled' ? (communitiesResult.value ?? null) : null;
  if (communitiesResult.status === 'rejected') {
    logger.error(communitiesResult.reason, 'Error fetching communities in ServerSideLayout:');
  }
  const subscriptionsData: string[][] | null =
    subscriptionsResult.status === 'fulfilled' ? (subscriptionsResult.value ?? null) : null;
  if (subscriptionsResult.status === 'rejected') {
    logger.error(subscriptionsResult.reason, 'Error fetching subscriptions in ServerSideLayout:');
  }
  return (
    <ObserverProvider value={observer}>
      <InitialCommunitiesProvider value={communitiesData}>
        <InitialSubscriptionsProvider value={subscriptionsData}>
          {children}
        </InitialSubscriptionsProvider>
      </InitialCommunitiesProvider>
    </ObserverProvider>
  );
};

export default ServerSideLayout;
