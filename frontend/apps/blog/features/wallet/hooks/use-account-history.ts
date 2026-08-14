import { useQuery } from '@tanstack/react-query';
import type { DescribedHistoryEntry } from '../lib/account-history';

export interface WalletHistoryPage {
  entries: DescribedHistoryEntry[];
  totalOperations: number;
}

/**
 * Real on-chain wallet activity for `username`, already described.
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
 * `lang` is passed through because one branch of the describer joins a
 * multi-asset reward with `Intl.ListFormat`. Everything else it emits is already
 * an i18n key, so the caller still decides the wording.
 */
export function useAccountHistory(username: string, lang: string) {
  return useQuery<WalletHistoryPage>({
    queryKey: ['walletAccountHistory', username, lang],
    queryFn: async () => {
      const params = new URLSearchParams({ username, lang });
      const res = await fetch(`/api/wallet/history?${params.toString()}`);
      if (!res.ok) throw new Error(`wallet history request failed: HTTP ${res.status}`);
      return (await res.json()) as WalletHistoryPage;
    },
    enabled: !!username,
    refetchInterval: 60_000
  });
}
