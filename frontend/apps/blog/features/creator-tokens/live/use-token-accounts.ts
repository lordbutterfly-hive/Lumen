'use client';

/**
 * Which Magi accounts does the signed-in user hold creator tokens under?
 *
 * For a full Hive login the answer is trivially one: their Hive account, which
 * the contract sees as `hive:<name>`.
 *
 * For a **lite** account it is not their Lumen handle at all. A Lumen handle is
 * a display name — Magi has never heard of it, and reading a balance under it
 * returns nothing forever. What Magi knows is the **wallet** they signed in
 * with: a Bitcoin or Ethereum wallet is a first-class Magi account in `did:pkh`
 * form, and the creator-token contract already accepts both
 * (`creator-tokens/sdk/address.go` classifies `did:pkh:eip155` and
 * `did:pkh:bip122`; `core/util.go` sizes `MaxAccountLen` to fit them).
 *
 * So this hook resolves the real holder identities from
 * `GET /api/lite/wallet/dids`, which a previous session built for exactly this
 * purpose and nothing had consumed yet.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *
 *  1. **It never merges wallets into one number.** A user can bind a Bitcoin
 *     wallet AND an Ethereum one; those are two separate Magi accounts and
 *     binding the second does not move anything held by the first. Each holding
 *     keeps the `holder` it is actually under, so the UI can say which wallet a
 *     token sits in. Summing them would invent a position that does not exist at
 *     any single address.
 *
 *  2. **It never invents an account for a Google-only lite user.** There is no
 *     keypair behind a Google sign-in and Magi recognises nothing OAuth-shaped,
 *     so such a user cannot hold, buy or sell anything. `canHold` is false and
 *     the screens must say so rather than showing an empty portfolio, which
 *     would read as "you own nothing" instead of "this kind of account cannot
 *     own anything".
 *
 *  3. **It says nothing about SPENDING.** Holding and reading are settled;
 *     signing a Magi transaction from a wallet is a separate payload from our
 *     login proof and is not offered by that route. `canSign` is therefore
 *     reported separately and is currently false for every wallet identity —
 *     see the note on it below.
 */

import { useQuery } from '@tanstack/react-query';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';

/** One Magi account the user holds tokens under, with enough provenance to label it. */
export interface TokenAccount {
  /** The identifier the contract keys balances by: `hive:<name>` or a `did:pkh:…`. */
  id: string;
  /** 'hive' | 'btc' | 'evm' — what to show next to a holding. */
  kind: 'hive' | 'btc' | 'evm';
  /** The wallet address for a did:pkh account, for display. Null for a Hive account. */
  address: string | null;
}

interface WalletDidsResponse {
  wallets: { method: string; address: string; did: string; network: string | null }[];
  canHoldTokens: boolean;
}

export interface TokenAccounts {
  /** Every account to read balances for. Empty when the user cannot hold tokens at all. */
  accounts: TokenAccount[];
  /** Still resolving — distinct from "resolved to none". */
  isLoading: boolean;
  /** The lookup itself failed. NOT the same as "no wallets": the UI must not render an empty portfolio here. */
  failed: boolean;
  /**
   * FALSE for a Google-only lite account: no keypair, so no Magi account, so
   * nothing can be held. The screens say this explicitly instead of rendering
   * an empty wallet.
   */
  canHold: boolean;
  /**
   * FALSE for every wallet identity today. Reading is solved; signing is not —
   * a Magi transaction needs a signature over the transaction itself (EIP-712
   * over the transaction container for EVM, the transaction CID for Bitcoin),
   * which is a different payload from the login nonce we currently sign. Until
   * that rail is ported, a wallet holder can SEE and be PAID, but cannot
   * initiate. Kept as its own flag so no screen infers one from the other.
   */
  canSign: boolean;
}

function kindOf(method: string, network: string | null): TokenAccount['kind'] {
  if (method === 'btc_wallet') return 'btc';
  if (method === 'evm_wallet') return 'evm';
  // Fall back on the stored network when a future method name is unfamiliar,
  // rather than guessing 'hive' and mislabelling a wallet.
  return network === 'eip155' ? 'evm' : 'btc';
}

export function useTokenAccounts(): TokenAccounts {
  const { user, isHydrated } = useUserClient();
  const loggedIn = isHydrated && user.isLoggedIn;
  const isLite = user.account_tier === 'lite';

  const query = useQuery({
    queryKey: ['creatorTokens', 'walletDids', user.username],
    queryFn: async (): Promise<WalletDidsResponse> => {
      const res = await fetch('/api/lite/wallet/dids', { cache: 'no-store' });
      // Throw rather than returning an empty list: an empty list is a FACT
      // ("no wallet bound") and must never be manufactured from a failure.
      if (!res.ok) throw new Error(`wallet DID lookup failed: ${res.status}`);
      return (await res.json()) as WalletDidsResponse;
    },
    enabled: loggedIn && isLite,
    staleTime: 5 * 60 * 1000
  });

  if (!loggedIn) {
    return { accounts: [], isLoading: false, failed: false, canHold: false, canSign: false };
  }

  if (!isLite) {
    // A full Hive account signs with its own keys, so it can both hold and spend.
    return {
      accounts: [{ id: user.username, kind: 'hive', address: null }],
      isLoading: false,
      failed: false,
      canHold: true,
      canSign: true
    };
  }

  if (query.isLoading) {
    return { accounts: [], isLoading: true, failed: false, canHold: false, canSign: false };
  }
  if (query.isError || !query.data) {
    return { accounts: [], isLoading: false, failed: true, canHold: false, canSign: false };
  }

  return {
    accounts: query.data.wallets.map((w) => ({
      id: w.did,
      kind: kindOf(w.method, w.network),
      address: w.address
    })),
    isLoading: false,
    failed: false,
    canHold: query.data.canHoldTokens,
    canSign: false
  };
}
