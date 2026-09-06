'use client';
import { createContext, createElement, useCallback, useEffect, useMemo, FC, PropsWithChildren } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useIsMounted } from 'usehooks-ts';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEY } from '@smart-signer/lib/query-keys';
import { useUserCore, IUseUser, UseUserOptions } from './use-user-core';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE `useUserCore` INSTANCE FOR THE WHOLE TREE (option A, warm-reclick build
 * map, 2026-09-06: `/mnt/o/LUMEN-DOCS/WARM-RECLICK-BUILD-MAP-2026-09-06.md`
 * section 5.A).
 *
 * `useUserClient()` (the App Router entry point, `./use-user-client.ts`) used
 * to run this FULL implementation — a `useQuery` observer, a `useLocalStorage`
 * read + storage-event subscription, `useIsMounted`, a `saveUser` effect, a
 * `setIsHydrated(true)` effect, an `auth-storage-desync` window listener, a
 * redirect effect — in EVERY one of its 171 call sites across 124 blog files
 * (11 to 17 per feed card). Measured: 364 `["user"]` React Query observers on
 * one signed-in home load, 440 storage listeners, 440 mount `setState`s, 220
 * `JSON.parse` + 220 `setItem` calls, all doing the exact same work 364 times
 * over. `UserClientProvider` below runs this ONCE, mounted in `Providers`
 * (`features/layouts/providers.tsx`), and every `useUserClient()` call
 * becomes a plain `useContext` read of the single resulting value.
 *
 * ★ `isHydrated` TIMING CHANGES, OUTCOMES DO NOT. Before this change, every
 * component's own `isHydrated` flipped false -> true after ITS OWN mount —
 * an extra render per component per mount. Now the flag flips once, after the
 * provider's own first commit, and any component that mounts later simply
 * reads `true` immediately (nothing to hydrate against — it was never part of
 * the server-rendered tree). Re-grepped every one of the 57 `isHydrated`
 * consumers (2026-09-06): all of them either (a) branch on it during render
 * (`observer = isHydrated ? clientObserver : ssrObserver`, `loggedIn =
 * isHydrated && user.isLoggedIn`), which reads identically either way, or
 * (b) `top-comment-session-reset.tsx`, which watches its OWN local
 * `isHydrated` inside a `useEffect` to record a one-time baseline — but that
 * component is already a global singleton mounted once in `Providers`
 * alongside this provider, not one of the 171 per-instance call sites, so
 * hoisting changes nothing for it: it still sees false-then-true in lockstep
 * with the rest of the initially-hydrated tree. No consumer depends on
 * witnessing the transition from a LATE mount.
 *
 * ★★★ THE PROVIDER NEVER UNMOUNTS — REFETCH CADENCE MUST BE RESTORED
 * EXPLICITLY (2026-09-06, adversarial review). Before this hoist, the feed
 * (and everything in it) is destroyed and rebuilt on every navigation (see
 * the build map's dumb question #1), so ~171 fresh `useUserCore` mounts per
 * navigation each carried their own `refetchOnMount: true` staleness check —
 * the first fresh mount past the 5-minute `staleTime` triggered a real
 * refetch, for free. `UserClientProvider` lives in the root layout next to
 * `AppHeader` and, like the header, NEVER unmounts across navigations. React
 * Query v4 only re-checks `refetchOnMount`'s staleness condition when an
 * observer newly SUBSCRIBES — with exactly one observer that subscribed once,
 * at the initial page load, that check never fires again. Left alone, a
 * session that expires server-side, or a sign-out in another tab that does
 * not happen to fire `auth-storage-desync`, would go unnoticed for the rest
 * of the tab's life instead of surfacing within one navigation past
 * `staleTime`, as it used to. The effect below restores exactly that cadence
 * — a route change now plays the role the lost fresh mount used to play,
 * and `stale: true` keeps it a no-op except past `staleTime`, same as before.
 *
 * Deliberately NOT `refetchOnWindowFocus: true`. `use-user-core.ts` restricts
 * that (`(query) => query.state.dataUpdatedAt === 0`) on purpose — 2026-08-08,
 * hardened 2026-08-13: an unconditional on-focus refetch propagated a
 * transient wrong answer to every consumer within seconds, which is a worse
 * failure than a session staying stale a little longer. That predicate is
 * evaluated once per actual focus event regardless of observer count (React
 * Query dedupes concurrent fetches of the same query), so hoisting changes
 * NOTHING about its behaviour — only the mount-driven path needed a fix here.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const UserClientContext = createContext<IUseUser | undefined>(undefined);

/**
 * The pre-hoist implementation, unchanged in substance — every side effect
 * `useUserCore` performs (the query observer, the localStorage seed/sync, the
 * `saveUser` write, the `auth-storage-desync` listener, the redirect effect,
 * the hydration flag) still happens here, just in ONE place now instead of
 * once per caller.
 *
 * Exported for `UserClientProvider` (below, always with default options) and
 * for `useUserClientWithRedirect` (`./use-user-client.ts`) — the explicit,
 * always-legacy hook for a caller that needs `redirectTo`/`redirectIfFound`
 * (0 callers today; the shared provider instance is mounted with no options
 * and cannot serve a request for a different redirect target).
 */
export function useUserClientLegacy(options: UseUserOptions = {}): IUseUser {
  const isMounted = useIsMounted();
  const router = useRouter();

  const handleRedirect = useCallback((path: string) => {
    router.push(path);
  }, [router]);

  return useUserCore(options, handleRedirect, isMounted);
}

/**
 * Mounted once in `features/layouts/providers.tsx`, wrapping `LoggedUserProvider`
 * and everything under it (which is to say: the app header plus every route's
 * `{children}` — see that file). Owns the single `useUserCore` instance for
 * the whole tree.
 *
 * ★ `createElement`, NOT JSX (2026-09-06). `lib/reblogged-by-cache-time.test.ts`
 * (and any other `lib/*.test.ts`) runs through `ts-node` with the repo's own
 * `jsx: "preserve"` (`packages/tsconfig/base.json`) — meaning TypeScript emits
 * raw `<Foo>` syntax for Node to choke on directly, relying on Next's own
 * webpack/SWC pass (never run by the test harness) to do the actual JSX
 * transform. That test imports `use-reblogged-by-query.ts` for its one pure
 * helper, which imports `useUserClient`, which now reaches this file — so any
 * literal JSX here breaks `pnpm test:unit` for a file this change never
 * touches. `React.createElement` compiles to a plain function call under any
 * `jsx` setting; same precedent as
 * `features/creator-tokens/ui/token-page/price-chart.selftest.ts`.
 */
export const UserClientProvider: FC<PropsWithChildren> = ({ children }) => {
  const raw = useUserClientLegacy();
  const queryClient = useQueryClient();
  const pathname = usePathname();

  // See the "PROVIDER NEVER UNMOUNTS" note above: this is the replacement for
  // the fresh-mount staleness check every one of the old 171 call sites used
  // to perform on its own. `stale: true` makes this a no-op on every
  // navigation except the one that lands after `staleTime` (5 minutes) has
  // actually elapsed, exactly mirroring the old cadence.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: [QUERY_KEY.user], stale: true });
  }, [pathname, queryClient]);

  // ★ MEMOIZE THE CONTEXT VALUE (2026-09-06, adversarial review). `useUserCore`
  // returns a brand-new object literal on every render (true before this
  // hoist too — it just used to matter only to the ONE component holding it).
  // A Context Provider re-renders every one of its consumers whenever its
  // `value` prop's IDENTITY changes, not when a field's VALUE changes — so
  // without this, the effect above (which re-renders this provider on every
  // `pathname` change) would re-render all 171 consumers on every navigation
  // even when nothing about the user actually changed. Keyed on the five
  // fields `IUseUser` actually carries, so identity is stable unless one of
  // them really is a new value.
  const value = useMemo<IUseUser>(() => ({
    user: raw.user,
    isHydrated: raw.isHydrated,
    clientAnswered: raw.clientAnswered,
    sessionUnavailable: raw.sessionUnavailable,
    retrySession: raw.retrySession
  }), [raw.user, raw.isHydrated, raw.clientAnswered, raw.sessionUnavailable, raw.retrySession]);

  return createElement(UserClientContext.Provider, { value }, children);
};
