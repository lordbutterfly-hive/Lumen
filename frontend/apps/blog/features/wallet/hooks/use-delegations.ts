import { useQuery } from '@tanstack/react-query';

export interface DelegateeRow {
  name: string;
  hp: string;
}

/**
 * Real outgoing vesting delegations for `username`, already converted to HP.
 *
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-13, browser audit §1.5).
 * This called `database_api.list_vesting_delegations` from the browser — one of
 * the nineteen direct api.hive.blog requests on `/wallet` — and then ran
 * `convertToHP` on every row, which needs a wax `Chain` instance and was one of
 * the reasons the page held one at all. Both moved to
 * `apps/blog/app/api/wallet/delegations/route.ts`, which also keeps the
 * `order: 'by_delegation'` reasoning and the defensive delegator filter.
 *
 * The `dynamicGlobal` / `chain` parameters are gone with them: they existed only
 * to feed that conversion, and every caller passed them straight through from
 * `useWalletAccount`.
 */
export function useDelegations(username: string) {
  return useQuery<DelegateeRow[]>({
    queryKey: ['vestingDelegations', username],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/delegations?username=${encodeURIComponent(username)}`);
      if (!res.ok) throw new Error(`wallet delegations request failed: HTTP ${res.status}`);
      return (await res.json()) as DelegateeRow[];
    },
    enabled: !!username
  });
}
