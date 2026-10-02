'use client';

import { useEffect } from 'react';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { rememberHasToken } from '../ui/meritum/intro/intro-state';
import { useTokenAccounts } from './use-token-accounts';
import { useTokenPriceChip, type TokenPriceChipStatus } from './use-token-price-chip';

/**
 * Remember the browser's definite answer ('ready' = has a token, 'none' = has
 * not) for the server's next first paint of /creators (intro-state.ts). Called
 * here AND from the header pill, which is mounted on every page at every width,
 * so a creator's first visit to /creators is already right if they came from
 * anywhere else on the site. 'loading' and 'unknown' change nothing.
 */
export function useRememberHasToken(status: TokenPriceChipStatus, username: string): void {
  useEffect(() => {
    if (status === 'ready') rememberHasToken(username, true);
    else if (status === 'none') rememberHasToken(username, false);
  }, [status, username]);
}

/**
 * Does the signed-in reader already have a Meritum token?
 *
 * The header pill's own answer (header-token-pill.tsx): the same account
 * expression (a lite account is keyed by its signing wallet, a Hive account by
 * its name) and `useTokenPriceChip` status 'ready', so /creators and the header
 * can never disagree. The read shares the pill's query key, so on most visits it
 * is already cached.
 *
 * `serverHint` is app/creators/page.tsx's answer (the chain for a Hive account,
 * else the remembered cookie). It holds until the chain read lands so a
 * creator's first paint is already right; a definite 'none' from the chain
 * overrides it.
 */
export function useViewerHasToken(serverHint = false): boolean {
  const identity = useSessionIdentity();
  const { user } = useUserClient();
  const isLite = user.account_tier === 'lite';
  const tokenAccounts = useTokenAccounts();
  const signingAccount = tokenAccounts.accounts.find((a) => a.canSign) ?? null;
  const priceAccount = (isLite ? signingAccount?.id : identity.username) ?? identity.username;
  const chip = useTokenPriceChip(identity.isLoggedIn ? priceAccount : '');
  useRememberHasToken(identity.isLoggedIn ? chip.status : 'unknown', identity.username);
  return identity.isLoggedIn && (chip.status === 'ready' || (chip.status !== 'none' && serverHint));
}
