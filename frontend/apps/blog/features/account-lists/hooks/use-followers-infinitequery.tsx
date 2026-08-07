import { getFollowers } from '@transaction/lib/hive-api';
import { useInfiniteQuery } from '@tanstack/react-query';
import { DEFAULT_PARAMS_FOR_FOLLOW, IGetFollowParams } from '@transaction/lib/hive-api';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { liteFollowList } from '../lib/lite-follow-list';

export const useFollowersInfiniteQuery = (
  account: IGetFollowParams['account'],
  limit: IGetFollowParams['limit'] = DEFAULT_PARAMS_FOR_FOLLOW.limit,
  initialPages?: IFollow[] | null
) => {
  return useInfiniteQuery({
    queryKey: ['followersData', account],
    queryFn: async ({ pageParam: last_id }) => {
      const chain = await getFollowers({ account, start: last_id, limit }).catch(() => []);
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
