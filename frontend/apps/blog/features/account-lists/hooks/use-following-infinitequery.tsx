import { useInfiniteQuery } from '@tanstack/react-query';
import { IGetFollowParams, DEFAULT_PARAMS_FOR_FOLLOW } from '@transaction/lib/hive-api';
import { fetchFollowing } from '@/blog/lib/chain-fetch';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { liteFollowList } from '../lib/lite-follow-list';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
 * `getFollowing` directly, which downloads `wax.common.wasm` — and this hook
 * backs the author hover-card's Follow/Mute state (`popover-card-data.tsx`),
 * the redesigned profile page, and the Followed/Muted list pages, so it is
 * one of the most widely-reached reads in the app. See
 * `apps/blog/app/api/following/route.ts`.
 */
export const useFollowingInfiniteQuery = (
  account: IGetFollowParams['account'],
  limit: IGetFollowParams['limit'] = DEFAULT_PARAMS_FOR_FOLLOW.limit,
  type?: string,
  extendedKey?: string[],
  initialPages?: IFollow[] | null
) => {
  return useInfiniteQuery({
    queryKey: ['followingData', account, ...(extendedKey || [])],
    queryFn: async ({ pageParam: last_id }) => {
      // ★ `ignore` (MUTE) NEVER SWALLOWS A FAILURE (2026-08-12, defect fix).
      //
      // This queryFn used to wrap every call in `.catch(() => [])`, unconditionally,
      // for every `type`. That catch exists for a real reason on the FOLLOW path
      // (below): a Lumen account has no on-chain follow list, so `get_following`
      // throwing "Account X does not exist" is EXPECTED there, and the empty
      // catch is what lets the code fall through to `liteFollowList`. But the same
      // catch also ate every genuine RPC failure — a timed-out node, a dropped
      // connection — and turned it into an indistinguishable, silently
      // SUCCESSFUL empty page. React Query had no way to tell "nobody muted" from
      // "the node did not answer", so it never retried and never set `isError`.
      //
      // `ignore` has no such excuse: there is no Lumen mute list to fall back to
      // (see the comment below), so nothing here is ever "expected" to throw. Every
      // rejection on this path IS a real failure, and letting it propagate is what
      // gives React Query's default retry (3 attempts, exponential backoff) a
      // chance to recover before `use-moderation-status.ts` has to report the mute
      // status as unknown rather than silently reading it as "not muted" — see that
      // file, and `medium-post-card.tsx`, for the consumer side of this fix.
      if (type === 'ignore') {
        return await fetchFollowing({ account, start: last_id, type, limit });
      }

      const chain = await fetchFollowing({ account, start: last_id, type, limit }).catch(() => []);
      if (chain.length > 0 || last_id) return chain;
      // Empty first page: the account may be a Lumen one, whose follow graph
      // lives in our own store rather than on chain. Only the follow list falls
      // back — `ignore` returns above and never reaches here.
      return await liteFollowList(account, 'following', limit);
    },
    enabled: Boolean(account),
    initialData: initialPages ? { pages: [initialPages], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: initialPages ? Date.now() : undefined,
    staleTime: StaleTime.NONE,
    getNextPageParam: (lastPage) => {
      return lastPage.length >= limit ? lastPage[lastPage.length - 1].following : undefined;
    }
  });
};
