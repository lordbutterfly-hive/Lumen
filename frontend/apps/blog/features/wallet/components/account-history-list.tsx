'use client';

import HistoryCard from './history-card';

/**
 * "Recent activity" on the signed-in wallet — the transaction/account-history
 * list that used to sit below the balances and stopped rendering when the
 * wallet page was rebuilt for Lumen (the new wallet-content.tsx never grew a
 * replacement; there was no failing query to fix, the section itself was never
 * ported). Restored as its own card, matching the section-label + card pattern
 * SavingsVault already uses on this same page, rather than porting
 * apps/wallet's HistoryTable (a wide `<table>`, wax custom-formatter classes
 * and a filter bar) into a page that has no other tables.
 *
 * Everything it renders lives in `history-card.tsx`, shared with the public
 * wallet; this file only fixes the two things that differ — the testid prefix
 * and the first-person error copy.
 */
export default function AccountHistoryList({ username }: { username: string }) {
  return <HistoryCard username={username} testIdPrefix="wallet-history" errorKey="wallet.history.error" />;
}
