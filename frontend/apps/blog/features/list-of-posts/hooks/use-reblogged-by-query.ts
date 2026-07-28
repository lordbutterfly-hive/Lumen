import { useQuery } from '@tanstack/react-query';
import { getRebloggedBy } from '@transaction/lib/hive-api';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { fetchLiteEngagement } from '@/blog/lib/lite/client/lite-engagement';

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
      const data = await getRebloggedBy(author, permlink);
      return data.includes(username);
    },

    enabled: !!(username && author && permlink),

    // See https://www.codemzy.com/blog/react-query-cachetime-staletime
    cacheTime: 1000 * 60 * 60 + 5000, // 1 hour 5 seconds
    staleTime: 1000 * 60 * 60 // 1 hour
  });
  // logger.info('Reblog data author: %s, permlink: %s, isReblogged: %o', author, permlink, isReblogged);
};
