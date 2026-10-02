'use client';

import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTokenAccounts } from './use-token-accounts';
import { useTokenPriceChip } from './use-token-price-chip';

/**
 * Does the signed-in reader already have a Meritum token?
 *
 * The header pill's own answer (header-token-pill.tsx): the same account
 * expression (a lite account is keyed by its signing wallet, a Hive account by
 * its name) and `useTokenPriceChip` status 'ready', so /creators and the header
 * can never disagree. The read shares the pill's query key, so on most visits it
 * is already cached.
 *
 * `serverHint` is app/creators/page.tsx's answer for a Hive account. It holds
 * until the chain read lands so a creator's first paint is already right; a
 * definite 'none' from the chain overrides it.
 */
export function useViewerHasToken(serverHint = false): boolean {
  const identity = useSessionIdentity();
  const { user } = useUserClient();
  const isLite = user.account_tier === 'lite';
  const tokenAccounts = useTokenAccounts();
  const signingAccount = tokenAccounts.accounts.find((a) => a.canSign) ?? null;
  const priceAccount = (isLite ? signingAccount?.id : identity.username) ?? identity.username;
  const chip = useTokenPriceChip(identity.isLoggedIn ? priceAccount : '');
  return identity.isLoggedIn && (chip.status === 'ready' || (chip.status !== 'none' && serverHint));
}
