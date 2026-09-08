'use client';

/**
 * Liquid HIVE and HBD on the Hive chain a Magi deposit is signed on.
 *
 * When the creator-tokens config carries a chain override (the Hive chain the
 * provisioned Magi network reads; see lib/magi-l1-broadcast.ts) the balance
 * must come from THAT chain, or the deposit dialog would show a mainnet
 * balance for a transfer it is about to sign on another chain.
 */
import { useQuery } from '@tanstack/react-query';
import Big from 'big.js';
import { getCreatorTokensHiveChain } from '@/blog/features/creator-tokens/lib/vsc/hive-chain';
import { getMagiL1ChainOverride } from '../lib/magi-l1-broadcast';

export interface MagiL1Balances {
  liquidHive: Big;
  liquidHbd: Big;
}

function naiToBig(asset: { amount: string | number; precision: number }): Big {
  return new Big(String(asset.amount)).div(new Big(10).pow(asset.precision));
}

/**
 * ★ NO FALLBACK TO THE APP DEFAULT CHAIN (2026-09-08). A deposit is only ever
 * offered when the override is configured (lib/magi-l1-broadcast.ts refuses to
 * sign otherwise), so a balance from any other chain could never be the one the
 * transfer spends from. Unconfigured reads as an error, never as a number.
 */
export function useMagiL1Balances(username: string): { balances: MagiL1Balances | null; isLoading: boolean; isError: boolean } {
  const override = getMagiL1ChainOverride();
  const useOverride = override !== null && username !== '';
  const query = useQuery({
    queryKey: ['wallet', 'magiL1Balances', override?.apiEndpoint ?? '', username],
    enabled: useOverride,
    staleTime: 10_000,
    retry: 1,
    queryFn: async (): Promise<MagiL1Balances> => {
      if (!override) throw new Error('Magi L1 balances: no chain override');
      const chain = await getCreatorTokensHiveChain(override);
      const result = await chain.api.database_api.find_accounts({ accounts: [username], delayed_votes_active: false });
      const account = result.accounts[0];
      if (!account) throw new Error(`No account ${username} on ${override.apiEndpoint}`);
      return { liquidHive: naiToBig(account.balance), liquidHbd: naiToBig(account.hbd_balance) };
    }
  });
  if (!useOverride) return { balances: null, isLoading: false, isError: true };
  return { balances: query.data ?? null, isLoading: query.isLoading, isError: query.isError };
}
