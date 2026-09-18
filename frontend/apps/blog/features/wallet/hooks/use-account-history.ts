import { useInfiniteQuery } from '@tanstack/react-query';
import type { DescribedHistoryEntry } from '../lib/account-history';
import type { HistoryGroup } from '../lib/history-groups';

export interface WalletHistoryPage {
  entries: DescribedHistoryEntry[];
  /** Sequence number to ask for the next page of OLDER operations; null at the end. */
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * Real on-chain wallet activity for `username`, already described, page by page.
 *
 * ★★★ THROUGH OUR SERVER, NOT `chain.restApi` (2026-08-13, browser audit §1.5).
 * This hook used to call `hafah-api/operation-types` and
 * `hivemind-api/accounts/{name}/operations` straight from the browser — two of
 * the nineteen direct api.hive.blog requests measured on `/wallet` — and then
 * handed the raw operations to `describeHistoryOperation`, which needs a wax
 * `Chain` for its vests->HP conversion AND for the asset symbols. Both calls and
 * the describing now happen in `/api/wallet/history`; see that route for why the
 * describing had to move with them rather than staying here.
 *
 * ★★★ INFINITE, AND GROUPED (2026-09-18). One flat page of 25 was all this
 * wallet could ever show; the route now pages backwards on a stable cursor, and
 * the three tabs above the list (All / Rewards / Send & receive) are three
 * different operation filters asked of the chain — NOT a client-side filter over
 * one page, which would show "no rewards" to somebody whose newest 25 operations
 * happen to be transfers.
 *
 * ★ THE POLL STOPS ONCE THE READER PAGES INTO THE PAST. React Query refetches
 * EVERY loaded page of an infinite query, so a fixed 60s interval would turn a
 * reader who pressed "Load older" five times into five requests a minute,
 * forever. Only the first page can gain new rows anyway — older pages are
 * settled history — so the interval applies while exactly one page is loaded.
 *
 * `lang` is passed through because one branch of the describer joins a
 * multi-asset reward with `Intl.ListFormat`. Everything else it emits is already
 * an i18n key, so the caller still decides the wording.
 */
export function useAccountHistory(username: string, lang: string, group: HistoryGroup = 'all') {
  return useInfiniteQuery<WalletHistoryPage>({
    queryKey: ['walletAccountHistory', username, lang, group],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ username, lang, group });
      if (typeof pageParam === 'number') params.set('cursor', String(pageParam));
      const res = await fetch(`/api/wallet/history?${params.toString()}`);
      if (!res.ok) throw new Error(`wallet history request failed: HTTP ${res.status}`);
      return (await res.json()) as WalletHistoryPage;
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor ?? undefined : undefined),
    enabled: !!username,
    refetchInterval: (data) => ((data?.pages.length ?? 1) <= 1 ? 60_000 : false)
  });
}
