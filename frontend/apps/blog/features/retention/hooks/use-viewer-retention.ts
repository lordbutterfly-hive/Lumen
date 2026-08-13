'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useRetention, type RetentionSummaryResponse, type RetentionSource } from './use-retention';

/**
 * ★ THE LITE LADDER HAD NO CONSUMER. THIS IS IT.
 *
 * `GET /api/lite/retention`, `lib/lite/retention/**` and migration 0025 shipped a
 * complete Lumen-native ladder for lite accounts — and nothing in the client ever
 * called it. Every retention surface (left-rail showcase, profile chip, profile
 * card, the /ranks "where you are" block) went through `useRetention`, which is
 * hard-DISABLED for a lite account because the chain route 404s for a name with
 * no Hive account. Driven live on 2026-08-08 against the production build: a
 * signed-in lite account saw no chip, no card, no showcase, and a /ranks page
 * whose "where you are" region was neither the signed-out prompt nor a rank —
 * it was nothing at all. 176 accounts, one silently empty block each.
 *
 * WHY A SEPARATE HOOK RATHER THAN A FLAG ON `useRetention`. The two routes have
 * different shapes of contract, not just different URLs: the chain one takes a
 * username and is public; the lite one takes NOTHING and answers only about the
 * session (deliberately — see the route's own note on the enumeration surface it
 * avoids). A username parameter on the lite path would be a lie about what the
 * server will honour, so the hook that fetches it does not accept one.
 *
 * BOTH QUERIES ARE ALWAYS CREATED, each gated by `enabled`. React's rules of
 * hooks forbid choosing between them with an `if`, and `enabled:false` is exactly
 * the mechanism for "this one does not apply to this viewer".
 */

/** Lite path: no parameter — the server answers about the session and only that. */
async function fetchLiteRetention(): Promise<RetentionSummaryResponse> {
  const res = await fetch('/api/lite/retention');
  if (!res.ok) throw new Error(`lite retention fetch failed: ${res.status}`);
  return (await res.json()) as RetentionSummaryResponse;
}

/**
 * The signed-in LITE user's own rank. `enabled` must be false for everyone else:
 * the route answers 401 for an anonymous or full-Hive session, and a query that
 * is certain to fail is load, not data.
 */
export function useLiteRetention(enabled: boolean): UseQueryResult<RetentionSummaryResponse> {
  return useQuery({
    // Session-scoped, so the key carries no username: two different lite users
    // cannot share a browser session, and keying on a name the server ignores
    // would invent a cache dimension the data does not have.
    //
    // ★ A DIFFERENT ROOT, NOT `['retention', 'lite']`. The chain hook keys on
    // `['retention', <username>]`, so any tuple of that shape is reachable by a
    // real account name — `['retention','lite']` is exactly what a viewer of the
    // Hive account @lite produces, and React Query would then serve one cache
    // entry to two queries with different bodies and different meanings. A
    // distinct root cannot be collided with by any username.
    queryKey: ['lite-retention'],
    queryFn: fetchLiteRetention,
    enabled,
    staleTime: 5 * 60 * 1000,
    // Same rule as the chain hook: on failure we substitute NOTHING. A wrong
    // status is worse than no status.
    retry: 1
  });
}

export interface ViewerRetention {
  summary: RetentionSummaryResponse | undefined;
  /** Which ladder applies to this viewer; null when signed out. */
  source: RetentionSource | null;
  /**
   * A request for this viewer's standing is GENUINELY IN FLIGHT.
   *
   * ★ NOT `useQuery().isLoading`. In React Query v4 a query that has never
   * resolved reports `status: 'loading'` FOREVER while it is disabled or idle,
   * so a caller that renders "working it out…" from `isLoading` alone will say
   * that to somebody nothing is being fetched for, indefinitely. Caught by
   * driving a lite session whose page had partly failed to hydrate: the /ranks
   * block sat on "Working out where you are standing…" with no request ever
   * issued. `fetchStatus` is the field that means "a fetch is actually
   * happening", and it is the one this reports.
   *
   * ★ PLUS ONE MORE CASE (2026-08-12, G2): "we know you're signed in but we do
   * not yet know which ladder applies to you." Neither the chain nor the lite
   * query below can be `enabled` until `user.account_tier` is known, and that
   * field has no session-cookie equivalent — unlike `isLoggedIn`, it can only
   * come from the client query resolving. So this also reports loading for that
   * narrow, real window, rather than falling through to `active.fetchStatus`
   * (which is legitimately idle — neither query has started yet) and reading as
   * "not loading" to a caller who would otherwise render "unavailable".
   */
  isLoading: boolean;
  /** The applicable query failed — the caller must say so, not render blank. */
  isError: boolean;
  /**
   * Re-read this viewer's summary.
   *
   * Needed since the daily goal moved server-side: changing the goal changes what the
   * streak was judged against, so the card must re-read the whole computation rather than
   * patch the ring locally and hope the next answer agrees.
   */
  refetch: () => Promise<unknown>;
}

/**
 * The signed-in viewer's own standing, from whichever ladder actually applies.
 * This is what every "your rank" surface should use; `useRetention(username)`
 * remains the right call for looking at SOMEBODY ELSE's chain account.
 */
export function useViewerRetention(): ViewerRetention {
  const { user, isHydrated } = useUserClient();
  /**
   * ★ SAME RACE, ONE LEVEL DEEPER (2026-08-12, G2). Every consumer of this hook
   * (TodayCard, RanksLadder, ProfileLeagueCard's own chip, the showcase, the
   * nudge, the weekly recap) ultimately renders off `summary`/`isLoading`/
   * `isError`/`source` below, and all four used to gate on raw `user.isLoggedIn`
   * — which cannot answer during SSR and reports signed-out on the client until
   * `/api/users/me` returns. `identity.isLoggedIn` (server-session.tsx) answers
   * immediately from the session cookie the server already read, so a signed-in
   * reader is never told "signed out" here. `isChain`/`isLite` stay on the raw
   * `user.isLoggedIn`/`user.account_tier` below — `account_tier` does not exist
   * on `identity` by design, and it is genuinely what decides which of the two
   * queries to enable, so there is no earlier-available signal for that split.
   */
  const identity = useSessionIdentity();
  const isLite = user.isLoggedIn && user.account_tier === 'lite';
  const isChain = user.isLoggedIn && !isLite;

  const chain = useRetention(user.username, isChain);
  const lite = useLiteRetention(isLite);

  const active = isLite ? lite : chain;
  // Until the session itself has settled we do not yet know WHICH query applies,
  // so that counts as in-flight too — otherwise the first painted frame after
  // hydration would briefly claim the answer is unavailable. `!identity.clientAnswered`
  // covers the identity-race window specifically: `identity.isLoggedIn` can be
  // true (from the cookie) while `isChain`/`isLite` are still both false because
  // `user.account_tier` has not resolved yet — during that window neither query
  // below is even enabled, so `active.fetchStatus` alone would read as idle.
  //
  // ★ ...EXCEPT WHEN THE SESSION READ IS NEVER GOING TO SETTLE (2026-08-13,
  // adversarial review S4). `clientAnswered` is `dataUpdatedAt > 0` and React
  // Query's error reducer never touches `dataUpdatedAt`, so a `/api/users/me`
  // that only ever failed pinned `inFlight` true FOREVER — every rank surface in
  // the app (TodayCard, RanksLadder, the profile chip, the nudge, the weekly
  // recap) sat on `isLoading` with no error and no way out. "We don't know yet"
  // and "we asked and it failed" are different sentences and the consumers
  // already render them differently; this hook was only ever able to say the
  // first one.
  const sessionSettled = identity.clientAnswered || identity.sessionUnavailable;
  const inFlight = !isHydrated || !sessionSettled || active.fetchStatus !== 'idle';
  return {
    summary: identity.isLoggedIn ? active.data : undefined,
    source: identity.isLoggedIn ? (isLite ? 'lumen' : 'chain') : null,
    isLoading: identity.isLoggedIn && !active.data && inFlight,
    // A session we could not read is a rank we could not read: report the error
    // rather than an eternal spinner. `refetch` below re-runs the underlying
    // retention query; `identity.retrySession` is the one that re-asks who you
    // are, and the consumers' retry buttons go through `refetch`, so re-ask both.
    isError: identity.isLoggedIn && (active.isError || identity.sessionUnavailable),
    refetch: () => {
      if (identity.sessionUnavailable) identity.retrySession();
      return active.refetch();
    }
  };
}

/**
 * The rank to show ON A PROFILE PAGE for `username`.
 *
 * A chain profile is public, so anyone may see its rank. A LITE profile is not:
 * `/api/lite/retention` is session-scoped by construction and there is no public
 * lite-rank route, so the rank is available only when the viewer IS the profile
 * owner. That is a real limit and it is expressed here rather than papered over —
 * the alternative (deriving a second, cheaper lite rank client-side) is exactly
 * the "two contradicting ranks" bug that got the feed emblem removed.
 */
export function useProfileRetention(
  username: string,
  chainAccount: boolean
): UseQueryResult<RetentionSummaryResponse> {
  const { user } = useUserClient();
  const isOwnLiteProfile =
    !chainAccount &&
    user.isLoggedIn &&
    user.account_tier === 'lite' &&
    user.username.toLowerCase() === (username || '').toLowerCase();

  const chain = useRetention(username, chainAccount);
  const lite = useLiteRetention(isOwnLiteProfile);
  return isOwnLiteProfile ? lite : chain;
}
