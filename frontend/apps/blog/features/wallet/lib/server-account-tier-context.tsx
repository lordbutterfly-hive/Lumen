'use client';

import { createContext, ReactNode, useContext } from 'react';
import type { ServerAccountTier } from '@/blog/lib/server-session';

/**
 * Carries `app/layout.tsx`'s server-read `accountTier` (from the session
 * cookie — see `lib/server-session.ts`) down to any client component that
 * gates a real Hive-account fetch on tier, alongside `useSessionIdentity`'s
 * own `username` (C-B, 2026-09-05).
 *
 * ★★★ WHY THIS IS A SEPARATE CONTEXT FROM `useSessionIdentity` RATHER THAN A
 * FIELD ADDED TO IT. `SessionIdentity`/`useSessionIdentity`
 * (`features/layouts/server-session.tsx`) is shared, general-purpose plumbing
 * used across the whole app; widening its type is outside this task's file
 * list. This context carries exactly the one extra fact needed and nothing
 * else.
 *
 * ★ WHY IT LIVES UNDER `features/wallet/` DESPITE HAVING A CONSUMER OUTSIDE
 * IT. `wallet-content.tsx` and `wallet-right-rail.tsx` are its primary,
 * money-adjacent consumers (see below) — the same reasoning
 * `wallet-summary-context.tsx` gives for keeping ITS SSR-seed plumbing local
 * to this slice. `features/votes/hooks/use-logged-user.tsx` (a GLOBAL
 * provider, mounted for every signed-in page) needs the exact same fact for
 * the exact same reason and imports this rather than duplicating a third copy
 * of a four-line context — the alternative this codebase already rejects
 * elsewhere (`use-rank-marks.ts`'s own doc on why a second, cheaper rank
 * function was the actual bug, not the fix).
 *
 * ★ WHY IT EXISTS AT ALL. Every consumer gates a REAL Hive-account fetch
 * (balances, history, delegations, manabar) on `isLite`, which used to read
 * only the client's `user.account_tier` — undefined until `/api/users/me`
 * answers (or a localStorage seed already answers it). Once those files start
 * reading `identity.username` instead of `user.username` for the SAME
 * early-fire win, `username` and `isLite` stop resolving together: for a
 * genuine lite account, `identity.username` is correct from the very first
 * render while `user.account_tier === undefined` still reads as "not lite" —
 * which would fire a Hive balance/history/delegation/manabar fetch for a
 * Lumen handle that is not a Hive account. This context closes that gap with
 * the SAME server-cookie read that already answers `username`, so a consumer
 * never has to trust the two facts on different clocks.
 */
const ServerAccountTierContext = createContext<ServerAccountTier>(null);

export function ServerAccountTierProvider({
  value,
  children
}: {
  value: ServerAccountTier;
  children: ReactNode;
}) {
  return <ServerAccountTierContext.Provider value={value}>{children}</ServerAccountTierContext.Provider>;
}

export const useServerAccountTier = () => useContext(ServerAccountTierContext);
