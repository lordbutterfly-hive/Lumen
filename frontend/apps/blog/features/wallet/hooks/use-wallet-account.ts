import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WalletFigures } from '../lib/wallet-derived';
import { fromWalletFiguresWire } from '../lib/wallet-figures-wire';
import { useInitialWalletSummary } from '../lib/wallet-summary-context';
import type { WalletSummaryWire } from '../lib/wallet-summary-wire';

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

async function fetchWalletSummary(username: string): Promise<WalletSummaryWire> {
  const res = await fetch(`/api/wallet/summary?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`wallet summary request failed: HTTP ${res.status}`);
  return (await res.json()) as WalletSummaryWire;
}

export function useWalletAccount(username: string) {
  /**
   * ★★★ SSR SEED, GATED ON MATCHING THE QUERY'S OWN USERNAME (T3g, 2026-09-04).
   *
   * `app/wallet/page.tsx` fetches this same summary server-side and hands it
   * down via `WalletSummaryProvider` so the masthead and balances can paint on
   * first render instead of every `/wallet` visit showing the loading masthead
   * while the browser's own fetch is in flight (462ms warm, up to 11.65s cold).
   *
   * The `seed.account.name === username` check is the money-correctness guard:
   * this context is a single value, not keyed by username, so it must never be
   * applied to a DIFFERENT username than the one it was fetched for (a lite
   * account passes `''` here - see wallet-content.tsx - which can never match
   * a real seeded account name, so a lite reader simply gets no seed, exactly
   * today's behaviour).
   *
   * Seeded with `initialDataUpdatedAt: 0`, not a real timestamp - same choice
   * `profile-main.tsx` makes for `profileData` and for the same reason: this
   * is real money, so on ANY doubt the seed might not be the newest truth
   * (the read happened moments earlier, during SSR), the query is marked
   * immediately stale and reads through to the client's own fetch in the
   * background. React Query keeps showing this seeded data (no loading flash)
   * while that refetch runs, so this can only ever REPLACE a wrong number
   * with a right one sooner, never show a stale one longer.
   */
  const seed = useInitialWalletSummary();
  const initialSummary = seed && seed.account?.name === username ? seed : undefined;

  const summaryQuery = useQuery({
    queryKey: ['walletSummary', username],
    queryFn: () => fetchWalletSummary(username),
    enabled: !!username,
    refetchInterval: 60_000,
    initialData: initialSummary,
    initialDataUpdatedAt: initialSummary ? 0 : undefined
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
