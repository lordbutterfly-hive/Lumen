'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAccount, fetchWitnessesPage, fetchWitnessVotes } from '@/blog/lib/chain-fetch';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { MAX_WITNESS_VOTES } from '../lib/constants';
import { WitnessRow } from '../lib/types';

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

  /**
   * ★★★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This hook used
   * to run FIVE separate chain reads in the browser — `getDynamicGlobalProperties`,
   * a dedicated `useQuery({queryFn: getChain})`, `getWitnessesByVote`,
   * `getAccounts`, plus (signed-in only) `getAccount`/`getListWitnessVotes` —
   * every one reaching `getChain()`. `/witnesses` has NO sign-in wall, so this
   * downloaded `wax.common.wasm` for every visitor, anonymous or signed in,
   * just to view a read-only table — the single widest unnecessary blast
   * radius found in this pass (highest-priority finding of the audit).
   *
   * The four visitor-independent reads (dgp, witness list, witness account
   * batch, and the chain-instance math `buildWitnessRows`/`calculateHpApr`
   * need) are now ONE combined server route — see
   * `apps/blog/app/api/witnesses-page/route.ts` for why they're bundled
   * rather than four separate ones. The two signed-in-only reads
   * (`ownAccountQuery`, `ownVotesQuery`) stay separate, genuinely per-viewer
   * queries, now against `/api/account` and `/api/witness-votes`.
   */
  const pageQuery = useQuery({
    queryKey: ['witnesses-page', 'bulk'],
    queryFn: () => fetchWitnessesPage<WitnessRow>()
  });

  const ownAccountQuery = useQuery({
    queryKey: ['witnesses-page', 'own-account', username],
    queryFn: () => fetchAccount(username),
    enabled: isLoggedIn
  });

  const ownVotesQuery = useQuery({
    queryKey: ['witnesses-page', 'own-votes', username],
    queryFn: () => fetchWitnessVotes(username, MAX_WITNESS_VOTES, 'by_account_witness'),
    enabled: isLoggedIn
  });

  const ownVotes = useMemo(() => {
    if (!ownVotesQuery.data || !username) return new Set<string>();
    return new Set(
      ownVotesQuery.data.votes.filter((vote) => vote.account === username).map((vote) => vote.witness)
    );
  }, [ownVotesQuery.data, username]);

  // `ownVotes` is a per-viewer overlay on top of the shared, server-computed
  // rows — applying it here is a plain `Set.has()` per row, no chain access
  // needed, so it stays client-side same as before.
  const rows = useMemo(() => {
    if (!pageQuery.data) return [];
    if (ownVotes.size === 0) return pageQuery.data.rows;
    return pageQuery.data.rows.map((row) => ({ ...row, isVoted: ownVotes.has(row.owner) }));
  }, [pageQuery.data, ownVotes]);

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['witnesses-page'] });
  }, [queryClient]);

  return {
    rows,
    isLoading: pageQuery.isLoading,
    isError: pageQuery.isError,
    ownDataError: isLoggedIn && (ownVotesQuery.isError || ownAccountQuery.isError),
    ownVotesUnavailable: isLoggedIn && ownVotesQuery.isError,
    refetch,
    headBlock: pageQuery.data?.headBlock ?? 0,
    hpAprPercent: pageQuery.data?.hpAprPercent ?? null,
    hbdInterestRatePercent: pageQuery.data?.hbdInterestRatePercent ?? null,
    // Loading or errored own-votes reads as "unknown," never a confident-but-wrong MAX_WITNESS_VOTES.
    votesLeft:
      isLoggedIn && (ownVotesQuery.isLoading || ownVotesQuery.isError)
        ? null
        : MAX_WITNESS_VOTES - ownVotes.size,
    ownVotesCount: ownVotes.size,
    proxyAccount: ownAccountQuery.data?.proxy ?? '',
    hasProxy: !!ownAccountQuery.data?.proxy,
    witnessCount: pageQuery.data?.witnessCount ?? 0
  };
}
