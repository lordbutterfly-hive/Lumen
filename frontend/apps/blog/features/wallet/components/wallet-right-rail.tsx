'use client';

import Big from 'big.js';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTranslation } from '@/blog/i18n/client';
import { useWalletAccount } from '../hooks/use-wallet-account';
import { getMarketStatsUrl } from '../lib/wallet-endpoint';
import PriceCardHive from './price-card-hive';
import PriceCardHbd from './price-card-hbd';
import AdvancedToolsCard from './advanced-tools-card';

const ZERO = new Big(0);

/**
 * Right rail: market price cards + the Advanced power-user tools card.
 * Fetches its own wallet data (same query keys as the center column, so
 * react-query dedupes the network call) rather than taking it as props —
 * same decoupled-sibling pattern the home shell already uses for its rail.
 */
export default function WalletRightRail() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  /**
   * ★ SAME DEFECT AS /witnesses (2026-08-11, class sweep). `/wallet` (app/wallet/
   * page.tsx) already redirects to /login server-side before this ever mounts, so
   * every reader who reaches this rail IS logged in — but `user.isLoggedIn` still
   * cannot answer during SSR and reports "signed out" on the client until
   * `/api/users/me` returns, so the Advanced Tools card (power up/down, delegate,
   * claim account tokens) was hidden from its guaranteed-signed-in owner for up to
   * several seconds on every visit. `identity` resolves correctly on first paint
   * from the same session cookie the page-level redirect already trusted.
   */
  const identity = useSessionIdentity();
  // Same guard as wallet-content.tsx, and it is NOT redundant: this rail fetches
  // its own copy, so guarding only the centre column left the page still
  // crashing. `getAccountFull` on a name that does not exist on chain resolves to
  // a TRUTHY object with no balance fields (Hive returns an empty array,
  // `getAccounts([n])[0]` is undefined, and the spread `{...undefined}` yields
  // `{}`), so the hook's `if (!accountQuery.data) return null` guard passes and
  // `Big(undefined)` throws inside its useMemo. There is no error.tsx under
  // app/wallet, so that throw blanks the whole page — including the honest
  // "no wallet yet" panel that was added to explain the situation.
  const isLite = user.account_tier === 'lite';
  const { figures, pendingClaimedAccounts } = useWalletAccount(isLite ? '' : user.username);

  const marketStatsUrl = getMarketStatsUrl();

  return (
    <aside className="flex w-full flex-col gap-4 font-ui" data-testid="wallet-right-rail">
      <PriceCardHive />
      <PriceCardHbd />
      {/* ★ Only offer the link when there is somewhere to send people.
          `getMarketStatsUrl()` falls back to '#' when REACT_APP_WALLET_ENDPOINT
          is unset, and a UX tester found exactly that: a link whose href was
          literally "#", so clicking it did nothing at all. The helper's own
          comment says these exist to link out to real deployed pages "instead
          of dead-ending on '#'" — this makes that true. Same treatment as the
          profile's Block Explorer link. */}
      {marketStatsUrl !== '#' ? (
        <a
          href={marketStatsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-caption font-medium text-ink-brand-6 hover:text-ink-brand-4"
          data-testid="wallet-view-more-market-stats"
        >
          {t('wallet.market.view_more')}
        </a>
      ) : null}
      {/* Hidden for logged-out and lite accounts. Every tool in here (power
          up/down, delegate, claim account tokens) is a real, unconditional
          transactionService call with no tier/login check inside the tool
          dialogs themselves — this rail was the only gate. It was previously
          gated on `!isLite` alone, which left it fully visible and clickable
          for a signed-out visitor too (found during the closeout's own
          dev-server pass: curled /wallet logged out and the whole Advanced
          card, including "Claim account tokens", rendered enabled). Lite is
          additionally hidden because with the account queries disabled above
          its figures would all be ZERO — a card reading "0.000 HP" is a claim
          about a balance, not an absence of one.

          ★ `identity.clientAnswered` GATES THIS TOO (2026-08-11, follow-through
          fix). `isLite` and `username` below both read the raw `useUserClient()`
          object, which `useSessionIdentity` does NOT carry (it only exposes
          isLoggedIn/username sourced from the cookie). On a cold tab with a
          session cookie and no localStorage seed, `identity.isLoggedIn` answers
          true immediately while `user.account_tier` is still `undefined` and
          `user.username` is still `''` — so `isLite` false-negatives to "not
          lite" and this card rendered with an empty username and every figure
          at ZERO (see advanced-tools-card.tsx's own comment on why that's
          unacceptable). `account_tier` and `username` only become trustworthy
          together, in the same render, once `clientAnswered` flips true (same
          fetch, same response) — same reasoning list-variant.tsx already
          applies to its write gate. So the safe default here is "treat as lite
          until proven otherwise": wait for `clientAnswered` before showing the
          card at all, rather than showing one full of zeros. */}
      {identity.isLoggedIn && identity.clientAnswered && !isLite && (
        <AdvancedToolsCard
          username={user.username}
          // ★ movableHp, not netHp (2026-08-13, map item 10). Delegate is the
          // other half of the sentence wallet-derived.ts already documents for
          // Power Down: received HP cannot be re-delegated, so any control that
          // MOVES stake — Delegate included — must use movableHp, never netHp.
          maxHp={figures?.movableHp ?? ZERO}
          liquidHive={figures?.liquidHive ?? ZERO}
          liquidHbd={figures?.liquidHbd ?? ZERO}
          pendingClaimedAccounts={pendingClaimedAccounts}
        />
      )}
      {/* ★ AN INVISIBLE CARD IS NOT AN EXPLANATION (2026-08-13, adversarial
          review S4). The gate above is right and stays: `clientAnswered` false
          means we cannot tell a lite account from a full one, and showing tools
          that sign real transactions on a guess is not on. But a failed
          `/api/users/me` can never set `clientAnswered` (the error reducer does
          not touch `dataUpdatedAt`), so on this page — which is only reachable
          BY a signed-in reader, the route redirects otherwise — Power Up,
          Delegate and Claim account tokens simply stopped existing, permanently,
          with nothing on screen accounting for it. This says why. It grants
          nothing. */}
      {identity.isLoggedIn && identity.sessionUnavailable && (
        <p
          className="rounded-card border border-dashed border-line-14 px-4 py-3 text-caption text-ink-10"
          data-testid="wallet-rail-session-unavailable"
        >
          {t('wallet.session_unavailable')}
        </p>
      )}
    </aside>
  );
}
