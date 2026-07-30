'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getChain } from '@transaction/lib/chain';
import { getAccount, getAccounts, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getListWitnessVotes, getWitnessesByVote } from '@transaction/lib/hive';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { getLogger } from '@ui/lib/logging';
import { buildWitnessRows } from '../lib/build-witness-rows';
import { MAX_WITNESS_VOTES, WITNESS_FETCH_LIMIT } from '../lib/constants';
import { WitnessRow } from '../lib/types';

const logger = getLogger('app');

export interface UseWitnessesDataResult {
  rows: WitnessRow[];
  isLoading: boolean;
  /** The witness list / network data failed to load — the list is genuinely unknown, not empty. */
  isError: boolean;
  /** The logged-in viewer's own votes/proxy failed to load — their vote + proxy state is unknown. */
  ownDataError: boolean;
  /** The viewer's own-votes query failed, so per-row "voted" state is unknown (render indeterminate). */
  ownVotesUnavailable: boolean;
  /** Re-runs every witnesses-page query — wired to the error/retry affordances. */
  refetch: () => void;
  headBlock: number;
  /** Current network HP staking APR (%), or null while unavailable. Network-wide — not witness-specific. */
  hpAprPercent: number | null;
  /** Current network HBD savings rate (%) — the median of all witnesses' proposed rates. */
  hbdInterestRatePercent: number | null;
  /** null while the viewer's own votes are loading or failed to load — never a confident-but-wrong 30. */
  votesLeft: number | null;
  ownVotesCount: number;
  proxyAccount: string;
  hasProxy: boolean;
  witnessCount: number;
}

/**
 * Fetches and merges everything the witnesses page needs: the ranked
 * witness list, each witness's account (for avatar/description), the
 * network dynamic global properties (for HP/APR math), and — when logged
 * in — the viewer's own witness votes and proxy setting.
 */
export function useWitnessesData(): UseWitnessesDataResult {
  const { user } = useUserClient();
  const isLoggedIn = user.isLoggedIn;
  const queryClient = useQueryClient();

  const dgpQuery = useQuery({
    queryKey: ['witnesses-page', 'dynamic-global-properties'],
    queryFn: getDynamicGlobalProperties
  });

  const chainQuery = useQuery({
    queryKey: ['witnesses-page', 'chain'],
    queryFn: getChain,
    staleTime: Infinity
  });

  const witnessesQuery = useQuery({
    queryKey: ['witnesses-page', 'witness-list'],
    queryFn: () => getWitnessesByVote(WITNESS_FETCH_LIMIT)
  });

  const ownAccountQuery = useQuery({
    queryKey: ['witnesses-page', 'own-account', user.username],
    queryFn: () => getAccount(user.username),
    enabled: isLoggedIn
  });

  const ownVotesQuery = useQuery({
    queryKey: ['witnesses-page', 'own-votes', user.username],
    queryFn: () => getListWitnessVotes(user.username, MAX_WITNESS_VOTES, 'by_account_witness'),
    enabled: isLoggedIn
  });

  const owners = useMemo(() => witnessesQuery.data?.map((w) => w.owner) ?? [], [witnessesQuery.data]);

  const accountsQuery = useQuery({
    queryKey: ['witnesses-page', 'witness-accounts', owners],
    queryFn: async () => {
      const accounts = await getAccounts(owners);
      return new Map(accounts.map((a) => [a.name, a]));
    },
    enabled: owners.length > 0
  });

  const ownVotes = useMemo(() => {
    if (!ownVotesQuery.data || !user.username) return new Set<string>();
    return new Set(
      ownVotesQuery.data.votes.filter((vote) => vote.account === user.username).map((vote) => vote.witness)
    );
  }, [ownVotesQuery.data, user.username]);

  const rows = useMemo(() => {
    if (!witnessesQuery.data || !dgpQuery.data || !chainQuery.data) return [];
    return buildWitnessRows({
      witnesses: witnessesQuery.data,
      accounts: accountsQuery.data ?? new Map(),
      dgp: dgpQuery.data,
      chain: chainQuery.data,
      ownVotes
    });
  }, [witnessesQuery.data, dgpQuery.data, chainQuery.data, accountsQuery.data, ownVotes]);

  const hpAprPercent = useMemo(() => {
    if (!chainQuery.data || !dgpQuery.data) return null;
    try {
      const dgp = dgpQuery.data;
      return chainQuery.data.calculateHpApr(
        dgp.head_block_number,
        dgp.vesting_reward_percent,
        dgp.virtual_supply,
        dgp.total_vesting_fund_hive
      );
    } catch (error) {
      logger.error('calculateHpApr failed: %o', error);
      return null;
    }
  }, [chainQuery.data, dgpQuery.data]);

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['witnesses-page'] });
  }, [queryClient]);

  return {
    rows,
    isLoading: witnessesQuery.isLoading || dgpQuery.isLoading,
    isError: witnessesQuery.isError || dgpQuery.isError || chainQuery.isError,
    ownDataError: isLoggedIn && (ownVotesQuery.isError || ownAccountQuery.isError),
    ownVotesUnavailable: isLoggedIn && ownVotesQuery.isError,
    refetch,
    headBlock: dgpQuery.data?.head_block_number ?? 0,
    hpAprPercent,
    hbdInterestRatePercent: dgpQuery.data ? dgpQuery.data.hbd_interest_rate / 100 : null,
    // Loading or errored own-votes reads as "unknown," never a confident MAX_WITNESS_VOTES.
    votesLeft:
      isLoggedIn && (ownVotesQuery.isLoading || ownVotesQuery.isError)
        ? null
        : MAX_WITNESS_VOTES - ownVotes.size,
    ownVotesCount: ownVotes.size,
    proxyAccount: ownAccountQuery.data?.proxy ?? '',
    hasProxy: !!ownAccountQuery.data?.proxy,
    witnessCount: witnessesQuery.data?.length ?? 0
  };
}
