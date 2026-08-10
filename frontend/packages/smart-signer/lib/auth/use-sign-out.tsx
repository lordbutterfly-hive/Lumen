import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson } from '@smart-signer/lib/fetch-json';
import { QUERY_KEY } from '@smart-signer/lib/query-keys';
import { User } from '@smart-signer/types/common';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { defaultUser } from '@smart-signer/lib/auth/utils';
import * as userLocalStorage from '@smart-signer/lib/auth/user-localstore';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

async function signOutBackend(): Promise<User> {
  return await fetchJson('/api/auth/logout', {
    method: 'POST',
    headers: [
      ['content-type', 'application/json'],
      [csrfHeaderName, '1']
    ]
  });
}

/**
 * A Lumen LITE session lives in a server-side cookie of its own, destroyed by
 * its own route. It does NOT set `authenticateOnBackend`, so the branch below
 * used to skip every server call and return a logged-out user object while the
 * real session cookie stayed valid — the user looked signed out, and anything
 * reading the cookie server-side still saw them signed in. The endpoint that
 * fixes it already existed and had no callers.
 *
 * ★★★ TWO DIFFERENT ACTIONS, AND THIS IS WHERE THEY WERE CONFLATED (2026-08-10).
 *
 * Sign-out in this product is per-DEVICE — it is the item in the user menu of the
 * tab you are looking at. Every lite sign-out was routed to `/api/lite/auth/logout`,
 * which advanced the ACCOUNT-wide `session_epoch`, so clicking it in one tab
 * silently signed the user out of every other tab, phone and laptop. That is the
 * long-standing "epoch drift" (17 of 209 accounts sit above epoch 0), and it is why
 * an earlier attempt to enforce the epoch on `/api/users/me` had to be reverted with
 * users being signed out "on almost every action".
 *
 * `logout-all` — the endpoint that is SUPPOSED to do the account-wide thing — had
 * no callers anywhere in the product, so the destructive behaviour was reachable
 * only by accident and the deliberate one was not reachable at all. Both are now
 * addressable, and which one runs is the caller's explicit choice.
 */
async function signOutLite(everywhere: boolean): Promise<User> {
  await fetchJson(everywhere ? '/api/lite/auth/logout-all' : '/api/lite/auth/logout', {
    method: 'POST',
    headers: [
      ['content-type', 'application/json'],
      [csrfHeaderName, '1']
    ]
  });
  return defaultUser;
}

async function signOut(user: User, everywhere: boolean): Promise<User> {
  const { authenticateOnBackend } = user;
  // Checked BEFORE authenticateOnBackend: a lite session must always reach its
  // own destroy route, whatever else is configured.
  if (user.account_tier === 'lite') {
    return signOutLite(everywhere);
  }
  if (authenticateOnBackend) {
    return signOutBackend();
  } else {
    return defaultUser;
  }
}

/**
 * @param params.everywhere  Revoke EVERY session for the account, not just this
 *   device. Defaults to false — the plain sign-out control means "this device",
 *   and defaulting the other way is the bug described above. Lite accounts only:
 *   a full Hive session has no per-device server state either way.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const signOutMutation = useMutation({
    mutationFn: (params: { user: User; everywhere?: boolean }) => {
      const { user, everywhere } = params;
      return signOut(user, everywhere === true);
    },
    onMutate: () => {
      // Clear observer cookie immediately — SSR stops personalizing
      document.cookie = 'observer=; path=/; max-age=0';

      // Optimistically update user to logged-out state immediately for instant UI feedback
      const previousUser = queryClient.getQueryData<User>([QUERY_KEY.user]);
      queryClient.setQueryData([QUERY_KEY.user], defaultUser);
      // Sync localStorage immediately so navigated pages get correct initial data
      // (don't rely on the useEffect in useUserCore which runs after render)
      userLocalStorage.saveUser(defaultUser);
      // Invalidate observer-dependent queries to refetch with default observer
      queryClient.invalidateQueries({ queryKey: ['communitiesList'] });
      queryClient.invalidateQueries({ queryKey: ['entriesInfinite'] });
      return { previousUser };
    },
    onError: (error, _variables, context) => {
      // Rollback on error
      if (context?.previousUser) {
        queryClient.setQueryData([QUERY_KEY.user], context.previousUser);
        userLocalStorage.saveUser(context.previousUser);
      }
      logger.error(error, 'Sign out failed');
    }
  });
  return signOutMutation;
}
