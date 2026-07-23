import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAccountFull, getDynamicGlobalProperties, getFindAccounts } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { deriveWalletFigures, WalletFigures } from '../lib/wallet-derived';

/**
 * Fetches everything the wallet page needs for one account (balances,
 * dynamic global properties for the HP <-> vests rate, and the wax chain
 * instance) and derives the display figures. Same three-query shape
 * features/layouts/user-profile/profile-layout.tsx already uses for its own
 * HP math, so caches are shared across pages when the query keys line up.
 */
export function useWalletAccount(username: string) {
  const accountQuery = useQuery({
    queryKey: ['walletAccountData', username],
    queryFn: () => getAccountFull(username),
    enabled: !!username,
    refetchInterval: 60_000
  });

  const dynamicGlobalQuery = useQuery({
    queryKey: ['dynamicGlobalData'],
    queryFn: () => getDynamicGlobalProperties(),
    refetchInterval: 60_000
  });

  const chainQuery = useQuery({
    queryKey: ['hiveChain'],
    queryFn: () => getChain(),
    staleTime: Infinity
  });

  // FullAccount (the app's trimmed account shape) doesn't carry
  // pending_claimed_accounts, so it's fetched separately from the raw
  // ApiAccount — used only for the "Claim account tokens" dialog's copy.
  const rawAccountQuery = useQuery({
    queryKey: ['walletRawAccountData', username],
    queryFn: () => getFindAccounts(username),
    enabled: !!username
  });
  const pendingClaimedAccounts = Number(rawAccountQuery.data?.accounts[0]?.pending_claimed_accounts ?? 0);

  const isLoading = accountQuery.isLoading || dynamicGlobalQuery.isLoading || chainQuery.isLoading;
  const isError = accountQuery.isError || dynamicGlobalQuery.isError || chainQuery.isError;

  const figures: WalletFigures | null = useMemo(() => {
    if (!accountQuery.data || !dynamicGlobalQuery.data || !chainQuery.data) return null;
    return deriveWalletFigures(accountQuery.data, dynamicGlobalQuery.data, chainQuery.data);
  }, [accountQuery.data, dynamicGlobalQuery.data, chainQuery.data]);

  return {
    account: accountQuery.data ?? null,
    dynamicGlobal: dynamicGlobalQuery.data ?? null,
    chain: chainQuery.data ?? null,
    figures,
    pendingClaimedAccounts,
    isLoading,
    isError,
    refetch: accountQuery.refetch
  };
}
