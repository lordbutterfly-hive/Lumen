import { useInfiniteQuery } from '@tanstack/react-query';
import { IGetFollowParams, DEFAULT_PARAMS_FOR_FOLLOW, getFollowing } from '@transaction/lib/hive-api';
import { IFollow } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';
import { liteFollowList } from '../lib/lite-follow-list';

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
      const chain = await getFollowing({ account, start: last_id, type, limit }).catch(() => []);
      if (chain.length > 0 || last_id) return chain;
      // Empty first page: the account may be a Lumen one, whose follow graph
      // lives in our own store rather than on chain. `ignore` (mute) has no
      // Lumen equivalent, so only the follow list falls back.
      if (type && type !== 'blog') return chain;
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
