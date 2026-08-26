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
  // Checked FIRST: a lite session must always reach its own destroy route,
  // whatever else is configured.
  if (user.account_tier === 'lite') {
    return signOutLite(everywhere);
  }
  /*
   * ★★★ ALWAYS DESTROY THE SERVER SESSION — DO NOT ASK `authenticateOnBackend`
   * FIRST (2026-08-25).
   *
   * This used to be `if (authenticateOnBackend) signOutBackend(); else return
   * defaultUser;`, and that `else` is a silent, one-way failure: the user is
   * shown as signed out, their local state is cleared, and the `app_session`
   * cookie STAYS VALID. Anything reading it server-side still sees them signed
   * in. "I logged out" is a promise; a branch that quietly does not keep it is
   * the worst shape a session bug can take.
   *
   * The flag is the wrong question anyway. It records how the user SIGNED IN —
   * whether the login round-tripped through `/api/auth/login`. Signing out is
   * about what exists NOW, and a cookie can be present for reasons this flag
   * never saw: a login path that defaults it to false (both
   * `components/auth/form.tsx` and `google-oauth-redirect-handler.tsx` default
   * to `false`, fed by `LOGIN_AUTHENTICATE_ON_BACKEND`, which is ABSENT from
   * `.env.local` — so the value is false), a cookie issued by an older build, or
   * a session restored from a device where the flag was set differently.
   *
   * Calling the route unconditionally is safe in the direction that matters:
   * `logout.ts` "unconditionally destroys whatever is here" (its own comment) and
   * clears `account_info` besides, so destroying a session that does not exist
   * costs one request and changes nothing. Not destroying one that DOES exist
   * leaves a live credential behind. Fail towards ending the session.
   *
   * ★ Found while switching test accounts: the UI reported a clean sign-out and
   * the very next request was still authenticated. That instance was a forged
   * QA cookie carrying `authenticateOnBackend: false`, NOT a real login — the
   * Keychain path hardcodes `true` (`keychain-signin.tsx:87`) and does log out
   * correctly. So this is a latent footgun rather than a live regression; it is
   * fixed because the branch cannot justify existing, not because users hit it.
   */
  return signOutBackend();
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
