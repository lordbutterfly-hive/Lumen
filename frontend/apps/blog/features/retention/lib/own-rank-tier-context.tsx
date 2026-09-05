'use client';

import { createContext, ReactNode, useContext } from 'react';
import type { OwnRankTierSeed } from './own-rank-tier-seed';

/**
 * Carries `app/layout.tsx`'s server-fetched rank-tier snapshot down to
 * `useOwnRankTier` as `initialData` (C-B, 2026-09-05) — the same
 * context-not-Hydrate pattern `WalletSummaryProvider` and
 * `InitialProfileProvider` document: React Query v4's Hydrate does not
 * reliably populate a client component's `useQuery` during App Router SSR
 * here, so a plain context is what actually lands the seed on the server
 * render itself.
 *
 * Kept inside `features/retention/` (not the shared `InitialXxxProvider`
 * family in `components/observer-provider.tsx`) so this fix stays inside its
 * own slice, same reasoning `wallet-summary-context.tsx` gives for the same
 * choice.
 */
const OwnRankTierContext = createContext<OwnRankTierSeed | null>(null);

export function OwnRankTierProvider({
  value,
  children
}: {
  value: OwnRankTierSeed | null;
  children: ReactNode;
}) {
  return <OwnRankTierContext.Provider value={value}>{children}</OwnRankTierContext.Provider>;
}

export const useOwnRankTierSeed = () => useContext(OwnRankTierContext);
