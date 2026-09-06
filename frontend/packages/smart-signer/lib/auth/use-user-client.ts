'use client';
import { useContext } from 'react';
import { getLogger } from '@ui/lib/logging';
import { IUseUser, UseUserOptions } from './use-user-core';
import { UserClientContext, useUserClientLegacy } from './user-client-context';

const logger = getLogger('app');

/**
 * User authentication hook for App Router (next/navigation), for the
 * OVERWHELMING majority of callers — anyone who does not need
 * `redirectTo`/`redirectIfFound` (that is `useUserClientWithRedirect`, below;
 * `useUserCore` from `./use-user-core` for a caller outside App Router
 * entirely). Use `useUser` for Pages Router components.
 *
 * ★ THIN CONTEXT READ (option A, warm-reclick build map, 2026-09-06). This
 * used to run the full `useUserCore` implementation on every call (171 call
 * sites, 124 files). That implementation now runs ONCE, in
 * `UserClientProvider` (`./user-client-context.tsx`, mounted in
 * `features/layouts/providers.tsx`), and this function just reads its result
 * from context — same return shape as before, so no consumer changes.
 *
 * ★ NO SILENT FALLBACK (2026-09-06, adversarial review superseded the
 * original design here). This used to fall back to running the full
 * `useUserCore` implementation itself when no provider was found, gated on
 * `usesDefaultUserOptions(options)` recomputed every render — but that gate
 * can flip between renders of the SAME call site whenever a caller's options
 * are conditional (e.g. a `redirectTo` derived from state), which changes
 * how many hooks that render calls and throws "Rendered more hooks than
 * during the previous render". Splitting `useUserClient()` (no options, ever)
 * from `useUserClientWithRedirect(options)` (always the full hook,
 * unconditionally) removes that failure mode outright — see the latter's own
 * comment.
 *
 * That made the provider-less fallback pointless to keep for its OTHER job
 * too (a caller outside `UserClientProvider`'s tree): a repo-wide grep
 * (2026-09-06) found zero live callers of this function outside
 * `features/layouts/providers.tsx`'s tree. The candidate was
 * `packages/smart-signer/lib/use-signer-client.ts` -> `SignerProviderClient`,
 * documented as mounted by `apps/wallet` — but `apps/wallet` has no source in
 * this repo (two `.env.*` files only) and nothing anywhere imports
 * `SignerProviderClient`. So this throws instead of silently running a second,
 * un-hoisted implementation nobody asked for. If `apps/wallet` (or any other
 * separate provider tree) comes back and needs this, mount its own
 * `UserClientProvider` around it (`./user-client-context.tsx`) — do not
 * resurrect a fallback here.
 *
 * @returns User data
 */
export function useUserClient(): IUseUser {
  const ctx = useContext(UserClientContext);
  if (!ctx) {
    throw new Error(
      'useUserClient() must be rendered under <UserClientProvider> ' +
      '(features/layouts/providers.tsx mounts it once around the whole ' +
      'apps/blog tree). If this is a genuinely separate provider tree ' +
      '(e.g. apps/wallet), mount your own <UserClientProvider> around it - ' +
      'see packages/smart-signer/lib/auth/user-client-context.tsx.'
    );
  }
  return ctx;
}

/**
 * The always-full implementation, for the one case `useUserClient()` cannot
 * serve: a caller that needs `redirectTo`/`redirectIfFound`. The shared
 * `UserClientProvider` instance is mounted once, globally, with no options,
 * so it cannot special-case a redirect target for one caller.
 *
 * Unconditionally calls `useUserClientLegacy` — no context read, no branch.
 * The previous design tried to pick between a context read and this hook
 * inside ONE function based on `options`, a value that CAN change between
 * renders of the same call site (unlike provider-tree position, which
 * cannot) — so the number of hooks that render actually called could differ
 * from the render before it, and React throws "Rendered more hooks than
 * during the previous render" the moment it does. Two named functions remove
 * the possibility: whichever one a call site writes, it calls the same hooks,
 * unconditionally, every render.
 *
 * 0 callers need this today (repo-wide grep, 2026-09-06); kept for the one
 * legitimate use `UseUserOptions` was designed for. Warns in development if
 * called with nothing that actually needs it — that caller should use the
 * cheaper `useUserClient()` instead.
 */
export function useUserClientWithRedirect(options: UseUserOptions): IUseUser {
  if (process.env.NODE_ENV !== 'production' && usesDefaultUserOptions(options)) {
    logger.warn(
      'useUserClientWithRedirect() called with no redirectTo/redirectIfFound - ' +
      'useUserClient() is cheaper (reads the shared UserClientProvider instead ' +
      'of running its own useUserCore instance).'
    );
  }
  return useUserClientLegacy(options);
}

/**
 * True when `options` carries neither `redirectTo` nor `redirectIfFound` —
 * the only shape `UserClientProvider`'s single shared instance can answer
 * from context. A plain function, not a hook, safe to call unconditionally
 * from anywhere (including, deliberately, inside the `if` in
 * `useUserClientWithRedirect` above — that is a side-effect check, not a
 * hook-count branch). Handles `undefined` so a caller that has not opted
 * into any options at all still reads as "default".
 *
 * Unit-tested in `apps/blog/lib/auth/use-user-client-options.test.ts`.
 */
export function usesDefaultUserOptions(options?: UseUserOptions): boolean {
  return !options?.redirectTo && !options?.redirectIfFound;
}
