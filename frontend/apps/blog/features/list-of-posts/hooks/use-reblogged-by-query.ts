import { useQuery } from '@tanstack/react-query';
import { fetchRebloggedBy } from '@/blog/lib/chain-fetch';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
 * `getRebloggedBy` directly, which downloads `wax.common.wasm`. See
 * `apps/blog/app/api/reblogged-by/route.ts`.
 */
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
    cacheTime: 1000 * 60 * 60 + 5000, // 1 hour 5 seconds
    staleTime: 1000 * 60 * 60 // 1 hour
  });
  // logger.info('Reblog data author: %s, permlink: %s, isReblogged: %o', author, permlink, isReblogged);
};
