'use client';

import { createContext, ReactNode, useContext } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEY } from '@smart-signer/lib/query-keys';
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
 * Reading the query state outside the hook is safe here because `useUserClient`
 * subscribes to the same key in the same component, so the render that delivers
 * the new answer is the render that re-reads this.
 */
export function useSessionIdentity(): SessionIdentity {
  const { user } = useUserClient();
  const server = useServerSession();
  const queryClient = useQueryClient();
  const clientAnswered = !!queryClient.getQueryState([QUERY_KEY.user])?.dataUpdatedAt;

  if (clientAnswered) {
    return { isLoggedIn: !!user.isLoggedIn, username: user.username, clientAnswered };
  }
  // A localStorage seed that says "logged in" is still better than nothing; the
  // server's cookie reading wins only when the client has nothing at all.
  if (user.isLoggedIn) return { isLoggedIn: true, username: user.username, clientAnswered };
  return { isLoggedIn: server.isLoggedIn, username: server.username, clientAnswered };
}
