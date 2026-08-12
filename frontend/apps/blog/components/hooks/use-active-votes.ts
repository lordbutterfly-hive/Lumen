import { useQuery } from '@tanstack/react-query';
import { fetchActiveVotes } from '@/blog/lib/chain-fetch';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Same rule as
 * `use-account.ts` — `getActiveVotes` reached `getChain()` in the browser.
 * See `apps/blog/app/api/active-votes/route.ts`.
 */
export const useActiveVotesQuery = (username: string, permlink: string) => {
  return useQuery({
    queryKey: [permlink, username, 'ActiveVotes'],
    queryFn: () => fetchActiveVotes(username, permlink),
    enabled: Boolean(username) && Boolean(permlink)
  });
};
