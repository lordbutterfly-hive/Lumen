import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QUERY_KEY } from '@smart-signer/lib/query-keys';
import * as userLocalStorage from './user-localstore';
import { useLocalStorage } from 'usehooks-ts';
import { fetchJson } from '@smart-signer/lib/fetch-json';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import { getLogger } from '@ui/lib/logging';
import { User } from '@smart-signer/types/common';

const logger = getLogger('app');

export interface IUseUser {
  user: User;
  /** True when user state from localStorage is stable (after hydration completes) */
  isHydrated: boolean;
  /** True once `/api/users/me` has actually answered in this tab. Subscribed, not peeked:
   *  reading `dataUpdatedAt` off the query result registers it as a TRACKED prop, so an
   *  answer that is deeply equal to the seed still re-renders. Reading it through
   *  `queryClient.getQueryState()` did not, and that was the whole bug. */
  clientAnswered: boolean;
  /**
   * ★★★ THE OTHER END OF `clientAnswered` (2026-08-13, adversarial review S4).
   *
   * True when `/api/users/me` has FAILED and has never once succeeded in this tab —
   * i.e. `clientAnswered` is false and is not going to become true on its own.
   * `clientAnswered` alone cannot express this: React Query's error reducer never
   * touches `dataUpdatedAt` (verified in the installed `@tanstack/query-core@4.41.0`
   * source, `query.js`, `case 'error'`), so with `initialDataUpdatedAt: 0` a query
   * that has only ever failed keeps `dataUpdatedAt === 0` FOREVER. Ten components
   * branch on `clientAnswered`, every one of them a loader or a blocked control, and
   * not one had an error branch — three retries and ~93s worst case later the reader
   * was still looking at a skeleton with nothing to click and no explanation.
   *
   * ★ THIS IS NOT A LICENCE TO OPEN A GATE. It is deliberately a THIRD state, not a
   * second way of saying "answered". Four fail-closed capability gates hang off
   * `clientAnswered` (`account_tier`-based lite checks in the proposal dialogs,
   * account-lists' write gate, the wallet rail) and every one of them must stay shut
   * on a failed read — "we could not check" resolves to "no", exactly as it does in
   * the block filters. What this flag buys is the ability to say SO, and to offer a
   * retry, instead of spinning.
   */
  sessionUnavailable: boolean;
  /** Ask `/api/users/me` again, now. For the retry affordance the states above need;
   *  a no-op-safe call on a query that is already fetching. */
  retrySession: () => void;
}

export interface UseUserOptions {
  redirectTo?: string;
  redirectIfFound?: boolean;
}

async function getUser(): Promise<User> {
  return await fetchJson(`/api/users/me`);
}

/**
 * Core user hook logic shared between Pages Router and App Router versions.
 *
 * @param options - Configuration options
 * @param onRedirect - Callback to handle redirects (router-specific)
 * @param isMounted - Optional function to check if component is mounted (for App Router)
 * @returns User data and query state
 */
export function useUserCore(
  { redirectTo = '', redirectIfFound = false }: UseUserOptions = {},
  onRedirect: (path: string) => void,
  isMounted?: () => boolean
): IUseUser {
  const queryClient = useQueryClient();
  const [storedUser, storeUser] = useLocalStorage<User>('user', defaultUser);
  const { data: user, dataUpdatedAt, isError, fetchStatus, refetch } = useQuery<User>({
    queryKey: [QUERY_KEY.user],
    queryFn: async (): Promise<User> => getUser(),
    // Seed from localStorage for the first paint, then always revalidate:
    // `initialDataUpdatedAt: 0` marks the seed as stale so a browser whose local
    // copy is empty or out of date is not pinned to "logged out" for the page's
    // life. The server is the only authority on whether the cookie is still good.
    refetchOnMount: true,
    // Off since 2026-08-08: re-checking identity on every focus/reconnect was
    // added for the multi-tab case (signing in as someone else in tab 2) but it
    // propagated any transient wrong answer everywhere within seconds. Mount-only
    // is the safer trade; the multi-tab case is much rarer.
    //
    // ★★★ WITH ONE EXCEPTION, ADDED 2026-08-13 (adversarial review S4): a tab that
    // has NEVER had an answer. The reasoning above is entirely about a session we
    // already know — "don't re-ask about something settled, a transient wrong
    // answer costs more than a stale right one". It says nothing about the case
    // where the very first read failed, and there the trade inverts completely:
    // there is no known-good answer to protect, `refetchOnMount` only fires on a
    // NEW mount (so a reader sitting still on /submit.html or /@me/settings never
    // retries), and the cost of not re-asking is ten components stuck on a
    // skeleton permanently. `dataUpdatedAt === 0` is exactly "no successful
    // response has ever landed in this tab" — with `initialDataUpdatedAt: 0` the
    // localStorage seed does not count and an error never sets it. So: waking a
    // laptop or getting the network back retries ONLY while we have nothing, and
    // goes back to being off the instant a real answer arrives. The multi-tab
    // behaviour the 2026-08-08 note protects is untouched.
    refetchOnWindowFocus: (query) => query.state.dataUpdatedAt === 0,
    refetchOnReconnect: (query) => query.state.dataUpdatedAt === 0,
    // ★ ONE SESSION CHECK PER PAGE, NOT ONE PER MOUNTING COMPONENT (2026-08-10).
    //
    // `initialDataUpdatedAt: 0` marks the localStorage seed stale so the FIRST
    // mount always revalidates — that part is deliberate and stays. But the query
    // client's default staleness is 60s, and this hook is called from a dozen
    // components that mount at different moments (header, rails, cards, dialogs),
    // so anything mounting more than a minute into a page triggered another
    // `/api/users/me`. Measured on one home page load: three of them, the second
    // and third taking 30.0s and 18.6s because they were queued behind the feed on
    // the same single-threaded server.
    //
    // Five minutes is safe precisely because nothing here depends on polling to
    // learn about a session change: sign-in, sign-out, lite login, consent and the
    // desync listener all write `[QUERY_KEY.user]` with `setQueryData` directly, so
    // the change is instant and this window only governs how often we RE-ASK about
    // a session nobody has touched.
    staleTime: 5 * 60 * 1000,
    initialData: storedUser,
    initialDataUpdatedAt: 0,
    // A FAILED REQUEST IS NOT A LOGOUT. A request that never reached the server
    // says nothing about who you are, so it must leave the last known answer
    // alone. Real sign-out still works: it clears the cookie, and the next
    // SUCCESSFUL response is what reports logged-out.
    retry: 2,
    onError: (error) => {
      logger.warn('users/me refetch failed; keeping the current session as-is: %o', error);
    }
  });

  useEffect(() => {
    userLocalStorage.saveUser(user || defaultUser);
  }, [user]);

  // Listen for auth storage desync events (IndexedDB cleared while session valid).
  // When detected, immediately transition to logged-out state in React Query cache.
  useEffect(() => {
    const handleDesync = () => {
      logger.warn('Auth storage desync event received — resetting user to logged-out state');
      queryClient.setQueryData([QUERY_KEY.user], defaultUser);
      storeUser(defaultUser);
    };
    window.addEventListener('auth-storage-desync', handleDesync);
    return () => window.removeEventListener('auth-storage-desync', handleDesync);
  }, [queryClient, storeUser]);

  useEffect(() => {
    // If no redirect needed, just return (example: already on
    // /dashboard). If user data not yet there (fetch in progress,
    // logged in or not) then don't do anything yet.
    if (!redirectTo || !user) {
      return;
    }

    if (
      // If redirectTo is set, redirect if the user was not found.
      (redirectTo && !redirectIfFound && !user?.isLoggedIn) ||
      // If redirectIfFound is also set, redirect if the user was found.
      (redirectIfFound && user?.isLoggedIn)
    ) {
      onRedirect(redirectTo);
    }
  }, [user, redirectIfFound, redirectTo, onRedirect]);

  // For App Router, check if mounted before returning user to prevent hydration mismatch
  // Server uses cookies, client uses localStorage - these may differ during hydration
  // Post-hydration invalidation in useUserClient ensures queries refetch with correct observer
  const resolvedUser = isMounted
    ? (!isMounted() || !user ? defaultUser : user)
    : (user ?? defaultUser);

  // Track hydration state - true when user state from localStorage is stable
  // This ensures queries wait for proper user state before fetching
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    if (isMounted && isMounted()) {
      setIsHydrated(true);
    }
  }, [isMounted]);

  const retrySession = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    user: resolvedUser,
    isHydrated: isMounted ? isHydrated : true, // For Pages Router (no isMounted), always hydrated
    clientAnswered: dataUpdatedAt > 0,
    // All three conditions are required.
    //  * `isError` alone would be true for a failed REFETCH that still has a
    //    perfectly good earlier answer behind it (React Query keeps `data` on
    //    error), and reporting that as "unavailable" would put an error card in
    //    front of a reader whose session is known and fine.
    //  * `dataUpdatedAt === 0` is what makes it "and it has never worked".
    //  * `fetchStatus === 'idle'` means we are not asking RIGHT NOW. Without it a
    //    `retrySession()` click would leave the error card up for the whole attempt
    //    — a button that visibly does nothing — instead of falling back to the
    //    consumer's ordinary loading branch, which is the truthful thing to show
    //    while a request really is in flight.
    sessionUnavailable: isError && dataUpdatedAt === 0 && fetchStatus === 'idle',
    retrySession
  };
}
