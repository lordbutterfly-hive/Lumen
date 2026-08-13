'use client';

import { createContext, ReactNode, useContext } from 'react';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

/**
 * ★★★ WHO THE SERVER ALREADY KNEW YOU WERE (2026-08-10, fuckery list N-3).
 *
 * The header and the left rail decide what to draw from `useUserClient()`, which
 * cannot answer on the server and answers "logged out" on the client until three
 * things have happened: React mounts, `usehooks-ts` reads localStorage, and
 * `/api/users/me` comes back. Measured on this box with a real lite session:
 * `/api/users/me` reported `isLoggedIn: true` at t=3s while the header still
 * rendered "Log in" and the rail still had no Settings row; the avatar appeared
 * between t=3s and t=8s on the home page, and on `/search` the logged-out chrome
 * was still up 4.6 seconds in. A signed-in reader was shown a signed-out product,
 * on a page they reached by clicking something only signed-in readers can see.
 *
 * The server never had that problem. It reads the session cookie to render the
 * page, so it knows the answer before the first byte. This carries that answer
 * down to the two client components that need it, so their FIRST render — server
 * and client alike, which is what keeps hydration byte-identical — is drawn from
 * the cookie rather than from a guess.
 *
 * ★ IT IS A STARTING POINT, NOT AN AUTHORITY. It is captured once, in the root
 * layout, and the root layout does not re-run on a client-side navigation. So it
 * must never be allowed to OVERRIDE a client answer that has actually arrived —
 * otherwise signing out would leave an avatar on screen until a full reload. The
 * rule its consumers follow is: use it only while the client has no answer of its
 * own, and drop it the moment one lands. See `useSessionIdentity`.
 */
export interface ServerSession {
  isLoggedIn: boolean;
  username: string;
}

export const EMPTY_SERVER_SESSION: ServerSession = { isLoggedIn: false, username: '' };

const ServerSessionContext = createContext<ServerSession>(EMPTY_SERVER_SESSION);

export function ServerSessionProvider({ value, children }: { value: ServerSession; children: ReactNode }) {
  return <ServerSessionContext.Provider value={value}>{children}</ServerSessionContext.Provider>;
}

export function useServerSession(): ServerSession {
  return useContext(ServerSessionContext);
}

export interface SessionIdentity {
  isLoggedIn: boolean;
  username: string;
  /** True once `/api/users/me` has actually answered in this tab. */
  clientAnswered: boolean;
  /**
   * True when that request FAILED and has never once succeeded — so
   * `clientAnswered` is false and will not become true by itself. See
   * `use-user-core.ts` for why the two flags cannot be one.
   *
   * ★ A consumer that renders a skeleton, a spinner or a "loading" word while
   * `!clientAnswered` MUST also handle this, or that skeleton is permanent. A
   * consumer that CLOSES a capability while `!clientAnswered` must keep it closed
   * here — this flag never authorises anything, it only explains.
   */
  sessionUnavailable: boolean;
  /** Ask again. Pair it with whatever `sessionUnavailable` renders. */
  retrySession: () => void;
}

/**
 * Who to draw the chrome for, right now.
 *
 * `useUserCore` seeds its query from localStorage with `initialDataUpdatedAt: 0`,
 * so `dataUpdatedAt` is 0 for the seed and non-zero the instant a real response
 * lands. That is an exact "has the client heard back yet" flag, and it is the
 * whole switch: before it, the cookie the server read is the better answer;
 * after it, the client is the ONLY answer, which is what lets a sign-out take
 * effect without a reload.
 *
 * ★ CORRECTED (2026-08-13) — the paragraph this replaces was the bug.
 * It used to read `dataUpdatedAt` with `queryClient.getQueryState()`, an
 * imperative cache peek, and justified it by claiming: "Reading the query
 * state outside the hook is safe here because `useUserClient` subscribes to
 * the same key in the same component, so the render that delivers the new
 * answer is the render that re-reads this." That is false whenever the
 * answer is unchanged. React Query v4 tracks properties by proxy, and
 * `useUserClient` only destructured `data`, so `data` was the sole tracked
 * prop. `useUserCore` writes every response straight back to localStorage
 * and reseeds the next page's query with it, so for a returning reader the
 * next `/api/users/me` response is routinely deep-equal to the seed —
 * structural sharing then returns the *same* `data` reference. `dataUpdatedAt`
 * changed in the cache; nothing was subscribed to it; no render ever
 * happened to re-read it. `clientAnswered` stuck at `false` forever, and
 * every gate below, plus every other consumer of this hook that branches on
 * `clientAnswered`, hung on a skeleton with no error and no explanation.
 *
 * The fix: `useUserClient()` now destructures `dataUpdatedAt` itself and
 * returns `clientAnswered` directly (`use-user-core.ts`), which makes it a
 * TRACKED prop — a deeply-equal response now correctly notifies and
 * re-renders this component, resolving the gate.
 */
export function useSessionIdentity(): SessionIdentity {
  const { user, clientAnswered, sessionUnavailable, retrySession } = useUserClient();
  const server = useServerSession();

  // ★ `sessionUnavailable` rides ALONGSIDE the answer, it does not change it
  // (2026-08-13). A failed `/api/users/me` says nothing about who you are, so the
  // cookie/localStorage fallbacks below still decide `isLoggedIn` exactly as
  // before — the flag only lets a consumer stop pretending it is still loading.
  const failure = { sessionUnavailable, retrySession };

  if (clientAnswered) {
    return { isLoggedIn: !!user.isLoggedIn, username: user.username, clientAnswered, ...failure };
  }
  // A localStorage seed that says "logged in" is still better than nothing; the
  // server's cookie reading wins only when the client has nothing at all.
  if (user.isLoggedIn) return { isLoggedIn: true, username: user.username, clientAnswered, ...failure };
  return { isLoggedIn: server.isLoggedIn, username: server.username, clientAnswered, ...failure };
}
