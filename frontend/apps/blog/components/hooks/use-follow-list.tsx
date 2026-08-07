import { getFollowList } from '@transaction/lib/bridge-api';
import { useQuery } from '@tanstack/react-query';
import { IFollowList, FollowListType } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';

/**
 * ★ A LITE HANDLE HAS NO CHAIN MUTE LIST, SO DO NOT ASK FOR ONE.
 *
 * `bridge.get_follow_list` is keyed on a real Hive account. Called with a Lumen
 * handle it answers `Account <name> does not exist` — three retries, on every
 * post page, for every lite reader. It is the last of the calls that were
 * sending a lite account into the chain (see `chainObserver` in lib/utils.ts
 * for the twelve that fed it an `observer`); this one takes the username
 * directly, so the helper alone did not cover it.
 *
 * `chainAccount` defaults to true so existing callers are unchanged.
 */
export const useFollowListQuery = (
  username: string,
  type: FollowListType,
  serverData?: IFollowList[] | null,
  chainAccount = true
) => {
  return useQuery({
    queryKey: [type, username],
    queryFn: () => getFollowList(username, type),
    initialData: serverData ?? undefined,
    initialDataUpdatedAt: serverData ? Date.now() : undefined,
    staleTime: StaleTime.MEDIUM,
    enabled: Boolean(username) && chainAccount
  });
};
