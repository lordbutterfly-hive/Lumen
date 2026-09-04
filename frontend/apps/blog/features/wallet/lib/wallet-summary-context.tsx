'use client';

import { createContext, ReactNode, useContext } from 'react';
import type { WalletSummaryWire } from './wallet-summary-wire';

/**
 * Carries `app/wallet/page.tsx`'s server-fetched wallet summary down to
 * `useWalletAccount` as `initialData` (T3g, 2026-09-04) - the same
 * context-not-Hydrate pattern `InitialProfileProvider` documents
 * (`components/observer-provider.tsx`): React Query v4's Hydrate does not
 * reliably populate a client component's `useQuery` during App Router SSR
 * here, so a page-local context is what actually lands the seed on the
 * server render instead of only after client hydration.
 *
 * Kept inside `features/wallet/` (not added to the shared
 * `InitialXxxProvider` family in `components/observer-provider.tsx`) so this
 * page's fix stays inside its own slice.
 */
const WalletSummaryContext = createContext<WalletSummaryWire | null>(null);

export function WalletSummaryProvider({
  value,
  children
}: {
  value: WalletSummaryWire | null;
  children: ReactNode;
}) {
  return <WalletSummaryContext.Provider value={value}>{children}</WalletSummaryContext.Provider>;
}

export const useInitialWalletSummary = () => useContext(WalletSummaryContext);
