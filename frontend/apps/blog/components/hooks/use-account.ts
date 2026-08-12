import { useQuery } from '@tanstack/react-query';
import { fetchAccount } from '@/blog/lib/chain-fetch';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
 * `getAccount` here in the browser, which reaches `getChain()` and downloads
 * `wax.common.wasm` (2.34 MB). This hook backs the author hover-card on every
 * post list (`post-rendering/popover-card-data.tsx`) plus several profile
 * surfaces, so it is one of the highest-traffic reads in the app. See
 * `apps/blog/app/api/account/route.ts` for the full rule; `fetchAccount` uses
 * `getAccountFull` server-side, a strict superset of the old `getAccount`
 * response, so nothing this hook's consumers read is missing.
 */
export const useAccountQuery = (username: string) => {
  return useQuery({
    queryKey: ['accountData', username],
    queryFn: () => fetchAccount(username),
    enabled: Boolean(username)
  });
};
