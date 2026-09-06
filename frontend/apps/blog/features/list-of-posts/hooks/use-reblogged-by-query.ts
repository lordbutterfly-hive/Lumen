import { useQuery, isServer } from '@tanstack/react-query';
import { fetchRebloggedBy } from '@/blog/lib/chain-fetch';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
 * `getRebloggedBy` directly, which downloads `wax.common.wasm`. See
 * `apps/blog/app/api/reblogged-by/route.ts`.
 */

/**
 * ★★ CACHE TIME MUST BE INFINITE ON THE SERVER (2026-09-06, worker-memory
 * build map R1). Pulled out as a pure function of `isServer` so it can be
 * unit-tested without a browser (see the .test.ts next to this file); the
 * hook below is the only caller.
 *
 * The mechanism, in plain words: React Query v4's `Query` constructor ends
 * by arming a garbage-collection timer, `setTimeout(gc, cacheTime)`, and only
 * skips it when `cacheTime` is `Infinity`. This hook is called (via
 * `ReblogDialog`) from inside every post card and the post page, so every
 * server-rendered page that shows a post builds one of these queries, even
 * while the dialog is closed (`useQuery` still builds a `Query` when
 * `enabled` is false). With the old finite `cacheTime` (1 hour 5 seconds)
 * that armed a real ref'd timer on the server. Each SSR render gets its own
 * `QueryClient` (`lib/react-query.ts`'s `getQueryClient()` calls `new
 * QueryClient()` per render on the server), and that timer's closure keeps
 * the whole client reachable, including every `initialData` payload it was
 * seeded with (profile posts, home feed, the full post + discussion tree).
 * So the timer didn't just leak itself, it pinned an entire render's worth
 * of SSR payloads in memory for an hour. Measured on prod tonight: 1,652
 * live `QueryClient`s on one worker at 54 minutes' uptime, ~2,900 queries
 * with an armed GC timer, and roughly 1 GB of RSS per worker from this alone.
 * On the client this same finite `cacheTime` is correct and unchanged: the
 * browser's `QueryClient` is a long-lived singleton, so a 1-hour cache is
 * exactly the intended "remember the answer for a while" behaviour.
 */
export function rebloggedByCacheTimeMs(isServerFlag: boolean): number {
  return isServerFlag ? Infinity : 1000 * 60 * 60 + 5000;
}

export const useRebloggedByQuery = (author: string = '', permlink: string = '', username: string = '') => {
  const { user } = useUserClient();
  const isLite = user?.account_tier === 'lite';

  return useQuery({
    queryKey: ['PostRebloggedBy', author, permlink, username],
    queryFn: async () => {
      // A lite reblog is Lumen-local and never broadcast, so `getRebloggedBy` returns
      // a list this user can never be in. Asking the chain is what switched the reblog
      // button back off ~4 seconds after it was pressed — the mutation's own
      // invalidation was enough to trigger it.
      if (isLite) {
        const engagement = await fetchLiteEngagement(author, permlink);
        return engagement.reblogged;
      }
      const data = await fetchRebloggedBy(author, permlink);
      return data.includes(username);
    },

    enabled: !!(username && author && permlink),

    // See https://www.codemzy.com/blog/react-query-cachetime-staletime
    // isServer branch: see rebloggedByCacheTimeMs's doc comment above.
    cacheTime: rebloggedByCacheTimeMs(isServer), // 1 hour 5 seconds on the client, Infinity on the server
    staleTime: 1000 * 60 * 60 // 1 hour
  });
  // logger.info('Reblog data author: %s, permlink: %s, isReblogged: %o', author, permlink, isReblogged);
};
