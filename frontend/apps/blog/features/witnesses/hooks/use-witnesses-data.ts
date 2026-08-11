'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getChain } from '@transaction/lib/chain';
import { getAccount, getAccounts, getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { getListWitnessVotes, getWitnessesByVote } from '@transaction/lib/hive';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
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
  /**
   * ★ COOKIE-FIRST LOGIN STATE (2026-08-11, fuckery list item 19). This used to read
   * `useUserClient()` directly, which cannot answer during SSR and answers "signed
   * out" on the client until React mounts, localStorage is read and
   * `/api/users/me` returns — measured ~10s on this box. Because `isLoggedIn` here
   * also gates `ownAccountQuery`/`ownVotesQuery` below, those queries did not even
   * START until the client "caught up", so the stats bar had nothing to show but
   * "Log in to vote" for the whole wait. `useSessionIdentity` (same pattern as
   * `AppHeader`/`LeftRail`, see `features/layouts/server-session.tsx`) answers from
   * the server-read session cookie on the very first render, so these queries are
   * enabled immediately for an already-signed-in reader instead of ~10s later.
   */
  const identity = useSessionIdentity();
  const isLoggedIn = identity.isLoggedIn;
  const username = identity.username;
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
    queryKey: ['witnesses-page', 'own-account', username],
    queryFn: () => getAccount(username),
    enabled: isLoggedIn
  });

  const ownVotesQuery = useQuery({
    queryKey: ['witnesses-page', 'own-votes', username],
    queryFn: () => getListWitnessVotes(username, MAX_WITNESS_VOTES, 'by_account_witness'),
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
    if (!ownVotesQuery.data || !username) return new Set<string>();
    return new Set(
      ownVotesQuery.data.votes.filter((vote) => vote.account === username).map((vote) => vote.witness)
    );
  }, [ownVotesQuery.data, username]);

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
