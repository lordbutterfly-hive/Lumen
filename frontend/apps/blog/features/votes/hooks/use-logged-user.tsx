import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { createContext, FC, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { netVests } from '@/blog/lib/utils';
import { FullAccount } from '@hive/common-hiveio-packages/wax';
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
  const { user } = useUserClient();
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
  const isChainAccount = !!user.username && user.account_tier !== 'lite';
  const { data: accountData } = useQuery({
    queryKey: ['loggedUserAccount', user.username],
    queryFn: () => fetchAccount(user.username),
    enabled: isChainAccount
  });
  const { data: manabarsData } = useQuery({
    queryKey: ['manabars', user.username],
    queryFn: () => fetchManabar(user.username),
    enabled: isChainAccount,
    refetchOnWindowFocus: false,
    refetchInterval: 60000
  });
  // Truthiness is NOT enough — a partial/failed chain response is an object with
  // no `vesting_shares`, which is precisely how this crashed. Require the field
  // the maths actually needs.
  const net_vests = accountData?.vesting_shares ? netVests(accountData) : 0;
  const reputation = accountData?.reputation ?? 25;

  return (
    <LoggedUserContext.Provider value={{ loggedUser: accountData, net_vests, reputation, manabarsData }}>
      {children}
    </LoggedUserContext.Provider>
  );
};
