import { useEffect, useState } from 'react';
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
  const { data: user } = useQuery<User>({
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
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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

  return {
    user: resolvedUser,
    isHydrated: isMounted ? isHydrated : true // For Pages Router (no isMounted), always hydrated
  };
}
