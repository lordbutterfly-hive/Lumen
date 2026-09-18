'use client';

import HistoryCard from '@/blog/features/wallet/components/history-card';

/**
 * The public /@name/wallet activity list. Same card, same tabs, same paging as
 * the signed-in wallet (features/wallet/components/history-card.tsx) — this
 * page shows PUBLIC chain data about somebody else, so the only differences are
 * the third-person error copy and the `public-history` testid prefix.
 *
 * It used to be a full copy of the private list, which is how the two drifted:
 * the copy is what D2 asks for in the wallet tree, but a duplicated LIST is how
 * one of them silently keeps an old bug.
 */
export default function PublicAccountHistoryList({ username }: { username: string }) {
  return <HistoryCard username={username} testIdPrefix="public-history" errorKey="wallet.public.history_error" />;
}
