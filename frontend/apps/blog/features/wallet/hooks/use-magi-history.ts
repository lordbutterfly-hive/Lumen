'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import {
  MAGI_TRANSACTIONS_MAX_OFFSET,
  MAGI_TRANSACTIONS_PAGE_SIZE,
  readMagiTransactions,
  type MagiTransaction
} from '@/blog/lib/lite/wallet/magi-transactions';
import { MAGI_GROUP_OP_TYPES, type MagiHistoryGroup } from '../lib/magi-history';

export const magiHistoryKey = (account: string, group: MagiHistoryGroup) =>
  ['wallet', 'magiHistory', toMagiAccountId(account), group] as const;

/**
 * One Magi account's transactions, page by page, filtered by the active tab.
 *
 * ★ OFFSET PAGING, LIKE ALTERA (txStores.ts `fetchTxs(did, 'extend')` passes
 * `offset: get(magiTxsStore).length`). The node's `findTransaction` takes
 * limit/offset and nothing else, so there is no stable cursor to use — which
 * means a transaction landing WHILE somebody pages can push a row from page 1
 * onto page 2 and show it twice. The list de-duplicates by row key rather than
 * pretending it cannot happen.
 *
 * ★ THE POLL STOPS ONCE THE READER PAGES INTO THE PAST — same reasoning as
 * use-account-history.ts: React Query refetches every loaded page, and only the
 * first one can gain rows.
 *
 * ★ `enabled` INCLUDES THE CONFIG CHECK. With no Magi endpoint provisioned the
 * proxy answers 503 and this would retry a failure for ever; the panel above
 * already says "Magi isn't available on this build yet".
 */
export function useMagiHistory(account: string, group: MagiHistoryGroup) {
  const configured = getCreatorTokensConfig() !== null;
  return useInfiniteQuery<MagiTransaction[]>({
    queryKey: magiHistoryKey(account, group),
    queryFn: ({ pageParam }) =>
      readMagiTransactions(toMagiAccountId(account), {
        limit: MAGI_TRANSACTIONS_PAGE_SIZE,
        offset: typeof pageParam === 'number' ? pageParam : 0,
        types: MAGI_GROUP_OP_TYPES[group]
      }),
    getNextPageParam: (lastPage, pages) => {
      // A short page means the node ran out of rows for this filter.
      if (lastPage.length < MAGI_TRANSACTIONS_PAGE_SIZE) return undefined;
      const loaded = pages.reduce((total, page) => total + page.length, 0);
      // Our own ceiling: past this, offset paging is a worse tool than the
      // explorer link at the bottom of the card, and the proxy refuses it.
      if (loaded >= MAGI_TRANSACTIONS_MAX_OFFSET) return undefined;
      return loaded;
    },
    enabled: !!account && configured,
    refetchInterval: (data) => ((data?.pages.length ?? 1) <= 1 ? 45_000 : false),
    retry: 1
  });
}
