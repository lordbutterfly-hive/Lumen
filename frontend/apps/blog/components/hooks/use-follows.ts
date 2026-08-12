import { useQuery } from '@tanstack/react-query';
import { fetchFollowCount } from '@/blog/lib/chain-fetch';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Same rule as
 * `use-account.ts` — `getFollowCount` reached `getChain()` in the browser.
 * See `apps/blog/app/api/follow-count/route.ts`.
 */
export const useFollowsQuery = (username: string) => {
  return useQuery({
    queryKey: ['followCountData', username],
    queryFn: () => fetchFollowCount(username),
    enabled: Boolean(username)
  });
};
