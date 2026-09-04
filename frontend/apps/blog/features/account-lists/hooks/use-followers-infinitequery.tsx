import { useInfiniteQuery } from '@tanstack/react-query';
import { DEFAULT_PARAMS_FOR_FOLLOW, IGetFollowParams } from '@transaction/lib/hive-api';
import { fetchFollowers } from '@/blog/lib/chain-fetch';
import type { IFollow } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { liteFollowList } from '../lib/lite-follow-list';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
 * `getFollowers` directly, which downloads `wax.common.wasm`. See
 * `apps/blog/app/api/followers/route.ts`.
 */
export const useFollowersInfiniteQuery = (
  account: IGetFollowParams['account'],
  limit: IGetFollowParams['limit'] = DEFAULT_PARAMS_FOR_FOLLOW.limit,
  initialPages?: IFollow[] | null
) => {
  return useInfiniteQuery({
    queryKey: ['followersData', account],
    queryFn: async ({ pageParam: last_id }) => {
      // ★ ONLY THE EXPECTED FAILURE IS SWALLOWED (2026-08-12).
      //
      // This was a bare `.catch(() => [])`, the same defect fixed in the sibling
      // `use-following-infinitequery.tsx` in this same pass and never mirrored
      // here. The catch exists for a real reason: a Lumen account has no on-chain
      // follower list, so `get_followers` throwing "Account X does not exist" is
      // EXPECTED, and swallowing it is what lets the code fall through to
      // `liteFollowList` below.
      //
      // But it also ate every genuine RPC failure — a timed-out node, a dropped
      // connection — and handed React Query a SUCCESSFUL empty page, so it never
      // retried and never set `isError`. Reproduced live with a forced 500: the
      // page rendered "Followers page 1 from 54" above a completely empty,
      // unrecoverable list. The count came from the profile stats; the list came
      // from a failure pretending to be an answer.
      //
      // Narrowing to the expected error is stronger than the sibling's fix, which
      // still swallows everything on its follow path. A real failure now
      // propagates, React Query's default retry gets its chance, and a terminal
      // failure surfaces as `isError` instead of as "nobody follows this person".
      const chain = await fetchFollowers({ account, start: last_id, limit }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (/does not exist|unknown account|missing account/i.test(message)) return [];
        throw error;
      });
      if (chain.length > 0 || last_id) return chain;
      // See lib/lite-follow-list.ts: an empty first page may mean the account
      // simply has no CHAIN identity, not that nobody follows it.
      return await liteFollowList(account, 'followers', limit);
    },
    enabled: Boolean(account),
    initialData: initialPages ? { pages: [initialPages], pageParams: [undefined] } : undefined,
    initialDataUpdatedAt: initialPages ? Date.now() : undefined,
    staleTime: StaleTime.NONE,
    getNextPageParam: (lastPage) => {
      return lastPage.length >= limit ? lastPage[lastPage.length - 1].follower : undefined;
    }
  });
};
