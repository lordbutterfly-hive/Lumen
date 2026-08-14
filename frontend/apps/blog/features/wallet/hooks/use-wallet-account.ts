import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { WalletFigures } from '../lib/wallet-derived';
import { fromWalletFiguresWire, WalletFiguresWire } from '../lib/wallet-figures-wire';

/**
 * Everything the wallet page needs for one account: balances, the HP figures
 * derived from them, and the dynamic global properties the dialogs read.
 *
 * ★★★ ONE SAME-ORIGIN REQUEST, NOT FIFTEEN TO api.hive.blog (2026-08-13, browser
 * audit §1.5). This hook used to run four browser-side queries — `getAccountFull`,
 * `getDynamicGlobalProperties`, `getFindAccounts` and `getChain` — which together
 * produced fifteen of the nineteen direct requests the audit counted on `/wallet`
 * (`getAccountFull` alone is find_accounts + bridge.get_profile + twelve
 * `get_relationship_between_accounts`), and `getChain()` downloaded
 * `wax.common.wasm`, 2.34 MB, purely so `convertToHP` could run in the browser.
 *
 * `/api/wallet/summary` makes the same reads server-side, derives the same
 * figures with the same `deriveWalletFigures`, and sends the result. The return
 * shape of this hook is unchanged apart from `chain`, which no consumer needs any
 * more (see `use-delegations.ts` and `use-account-history.ts`, whose chain use
 * moved to their own routes in the same pass).
 *
 * `refetchInterval: 60_000` is kept from the previous implementation — the same
 * cadence, now costing one request instead of fifteen.
 */

interface WalletSummaryWire {
  account: FullAccount;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse;
  figures: WalletFiguresWire;
  pendingClaimedAccounts: number;
}

async function fetchWalletSummary(username: string): Promise<WalletSummaryWire> {
  const res = await fetch(`/api/wallet/summary?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`wallet summary request failed: HTTP ${res.status}`);
  return (await res.json()) as WalletSummaryWire;
}

export function useWalletAccount(username: string) {
  const summaryQuery = useQuery({
    queryKey: ['walletSummary', username],
    queryFn: () => fetchWalletSummary(username),
    enabled: !!username,
    refetchInterval: 60_000
  });

  const data = summaryQuery.data ?? null;

  // `Big`/`Date` do not survive JSON — rebuilt once here so every consumer keeps
  // the exact `WalletFigures` type it already expected. See the wire module.
  const figures: WalletFigures | null = useMemo(
    () => (data ? fromWalletFiguresWire(data.figures) : null),
    [data]
  );

  return {
    account: data?.account ?? null,
    dynamicGlobal: data?.dynamicGlobal ?? null,
    figures,
    pendingClaimedAccounts: data?.pendingClaimedAccounts ?? 0,
    isLoading: summaryQuery.isLoading,
    isError: summaryQuery.isError,
    refetch: summaryQuery.refetch
  };
}
