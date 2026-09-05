import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useServerAccountTier } from '@/blog/features/wallet/lib/server-account-tier-context';
import { createContext, FC, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { netVests } from '@/blog/lib/utils';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { fetchAccount, fetchManabar } from '@/blog/lib/chain-fetch';

interface SingleManabar {
  max: string;
  current: string;
  percentageValue: number;
  cooldown: Date;
}

interface Manabars {
  upvote: SingleManabar;
  downvote: SingleManabar;
  rc: SingleManabar;
}

type LoggedUserContextType = {
  loggedUser: FullAccount | undefined;
  net_vests: number;
  /**
   * Whether `net_vests` is an ANSWER or a PLACEHOLDER. See `vestsKnown` below —
   * a consumer that branches on `net_vests` must read this too, or it is
   * treating "we have not found out yet" as "the account has nothing".
   */
  vestsKnown: boolean;
  reputation: number;
  manabarsData: Manabars | null | undefined;
};

const LoggedUserContext = createContext<LoggedUserContextType | undefined>(undefined);

export const useLoggedUserContext = () => {
  const context = useContext(LoggedUserContext);
  if (!context) {
    throw new Error('useLoggedUserContext must be used within a LoggedUserProvider');
  }
  return context;
};

export const LoggedUserProvider: FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, clientAnswered } = useUserClient();
  /**
   * ★★★ `identity.username` + a SERVER-KNOWN TIER, NOT `user.username` ALONE
   * (C-B, 2026-09-05, part of the identity-gate waterfall — this provider is
   * the actual source of the measured 810-1178ms manabar / 1307ms account
   * waterfall: it is mounted GLOBALLY and both queries below used to wait for
   * the same slow `user.username`/`user.account_tier` every other identity-
   * gated widget did).
   *
   * `identity.username` resolves from the server session cookie at the FIRST
   * render (`useSessionIdentity`); `user.username` cannot answer until
   * `/api/users/me` does. Swapping the query's username source alone would
   * decouple it from `isChainAccount` below exactly the way
   * `wallet-right-rail.tsx`'s own doc on this class of bug describes: a
   * genuine lite account would get a correct, early `identity.username` while
   * `user.account_tier` was still `undefined` (reading as "not lite"), firing
   * a real Hive account/manabar fetch for a Lumen handle. `useServerAccountTier()`
   * (`features/wallet/lib/server-account-tier-context.tsx`) carries the SAME
   * cookie-sourced tier `identity.username` already trusts, closing that gap
   * with no added wait; see that file's own doc for the full reasoning and
   * why this hook — outside `features/wallet/` — is a deliberate second
   * consumer rather than a duplicated context.
   */
  const identity = useSessionIdentity();
  const serverAccountTier = useServerAccountTier();
  const isLite = clientAnswered || user.isLoggedIn ? user.account_tier === 'lite' : serverAccountTier === 'lite';
  // ★★★ A LUMEN LITE ACCOUNT HAS NO HIVE ACCOUNT (2026-08-06) — CRASH FIX.
  //
  // This provider is mounted GLOBALLY (`features/layouts/providers.tsx`), so it
  // runs on every page for every signed-in user. It asked the chain for
  // `getAccountFull(username)` unconditionally — but a lite username is a Lumen
  // handle, not a Hive account, so the chain has nothing to return. The result
  // was a truthy-but-empty object, `netVests()` then read
  // `account.vesting_shares.amount`, and the whole app died with
  // `TypeError: Cannot read properties of undefined (reading 'amount')` —
  // a BLANK WHITE PAGE, not a contained error. Two independent QA passes hit it
  // on ~10 of 15 signed-in loads; logged-out never crashed.
  //
  // Both chain queries are now skipped for lite accounts. They are meaningless
  // there: no vests, no manabar, no reputation. The defaults below (0 vests,
  // reputation 25) are exactly what a keyless account should report.
  //
  // ★★★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Both queries
  // below used to call `getAccountFull`/`getManabar` directly, here in the
  // browser. That reaches `getChain()`, which INSTANTIATES `@hiveio/wax` and
  // downloads `wax.common.wasm` (2.34 MB) — and because this provider is
  // global and `isChainAccount` is the SAME gate `app-header.tsx`'s unread-
  // notifications query already used, this was the sibling instance of the
  // exact bug fixed there: an anonymous-only measurement would have missed
  // this one too, since `enabled` is false until a real Hive account signs
  // in. See `apps/blog/app/api/account/route.ts` and `.../api/manabar/
  // route.ts`.
  const isChainAccount = !!identity.username && !isLite;
  const { data: accountData } = useQuery({
    queryKey: ['loggedUserAccount', identity.username],
    queryFn: () => fetchAccount(identity.username),
    enabled: isChainAccount
  });
  const { data: manabarsData } = useQuery({
    queryKey: ['manabars', identity.username],
    queryFn: () => fetchManabar(identity.username),
    enabled: isChainAccount,
    refetchOnWindowFocus: false,
    refetchInterval: 60000
  });
  // Truthiness is NOT enough — a partial/failed chain response is an object with
  // no `vesting_shares`, which is precisely how this crashed. Require the field
  // the maths actually needs.
  const net_vests = accountData?.vesting_shares ? netVests(accountData) : 0;
  const reputation = accountData?.reputation ?? 25;

  /**
   * ★★★ ZERO IS ALSO WHAT "I DON'T KNOW YET" LOOKS LIKE (2026-08-13, vote-%
   * bug). The line above collapses four very different situations into the
   * single number 0:
   *
   *   1. a lite account, which genuinely has no Hive account and no vests;
   *   2. a chain account whose `/api/account` read has not come back YET;
   *   3. a chain account whose `/api/account` read FAILED (502) — `data` stays
   *      undefined and there is no retry that will ever change that;
   *   4. nobody identified yet, because `/api/users/me` has not answered (or
   *      never will — see `sessionUnavailable` in server-session.tsx). Then
   *      `user.username` is empty, `enabled` is false, and this query does not
   *      run AT ALL, so 0 is not a measurement, it is a default.
   *
   * Only (1) is an answer. `votes-component.tsx` compared `net_vests` against a
   * 1,000,000-VESTS threshold to decide whether to offer a vote-percentage
   * slider, so in cases 2-4 it silently rendered the one-shot 100% vote button
   * instead — a live control that casts a full-power, on-chain vote on a single
   * click, visually identical to the percentage picker it replaced. Measured on
   * this box against a real account (lordbutterfly, net_vests 112,275,707.67,
   * 112x the threshold): the arrow was the one-shot button for the first ~380ms
   * of every page load, for ~5.9s when the chain read was slow, and PERMANENTLY
   * when `/api/account` or `/api/users/me` failed.
   *
   * So publish whether the number is an answer. The consumer decides what to do
   * with "unknown"; what it must not do is keep reading it as "zero".
   */
  // `isLite` (not the raw `user.account_tier === 'lite'`), so this agrees with
  // `isChainAccount` above on the exact same server-then-client tier answer
  // rather than re-deriving a second, possibly-stale-during-hydration one.
  const vestsKnown = isLite || !!accountData?.vesting_shares;

  return (
    <LoggedUserContext.Provider
      value={{ loggedUser: accountData, net_vests, vestsKnown, reputation, manabarsData }}
    >
      {children}
    </LoggedUserContext.Provider>
  );
};
