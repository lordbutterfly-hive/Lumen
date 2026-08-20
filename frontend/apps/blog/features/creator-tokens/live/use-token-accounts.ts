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
  /**
   * Whether THIS account can initiate a transaction — deliberately per account,
   * not per session.
   *
   * A scrutiny pass caught that a single session-wide flag could not express the
   * rule this rail is supposed to follow ("prove one chain at a time, never flip
   * globally"): the EVM rail and the Bitcoin rail are separate ports with separate
   * proofs, and Bitcoin additionally cannot be rehearsed on testnet at all
   * (dids.Parse never calls ParseBtcTestnetDID, so a BTC testnet DID can be funded
   * and can never sign). Turning both on together because one was proven is exactly
   * the mistake the rule exists to prevent.
   */
  canSign: boolean;
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
   * DERIVED: true when ANY resolved account can sign. A convenience for screens
   * that only need "is anything signable here"; anything that acts on a specific
   * account must read `TokenAccount.canSign` instead, because signability is a
   * property of the chain, not the session.
   *
   * False for every wallet identity today. Reading is solved; signing is not — a
   * Magi transaction needs a signature over the transaction itself (EIP-712 over
   * the container for EVM, the transaction CID for Bitcoin), which is a different
   * payload from the login nonce we sign now.
   */
  canSign: boolean;
}

/**
 * Can this chain's wallets SIGN a Magi transaction yet?
 *
 * Flipped per KIND as each chain is proven end to end, never both at once —
 * the two rails share a container format and share nothing else.
 *
 * ★ evm: TRUE since 2026-08-20, proven on testnet, not merely in a unit test.
 * A `did:pkh:eip155` identity registered its own market
 * (tx bafyreicoa3ttbkzq6agipz2vg6luuq55zpxt2cqvzjlabwedjqm2ius72i, INCLUDED,
 * state `m|did:pkh:…|st` = ACTIVE at block 5,852,790) and then BOUGHT a token
 * on another creator's market with a `transfer.allow` intent
 * (bafyreifsv3teq7c5plemu33by6wbnow3vntq5nhqn4bwyq55a3uqsupjnm — supply 30→31,
 * reserve +1,247, buyer debited 1,371 including fee). Signature produced by
 * EIP-712 typed data from `vsc-tx/eip712.ts` and verified by the node's own
 * `lib/dids.EthDID.Verify`.
 *
 * ★★ btc: STILL FALSE, and NOT because the crypto is unproven — it is. A real
 * mainnet `bc1q` BIP-137 signature over the container CID verifies TRUE against
 * `lib/dids.BtcDID.Verify` after `normalizeBip137Header` rewrites the
 * native-segwit recovery byte (40 → 32; raw fails with "recovery code 40 is not
 * in the valid range [27, 34]").
 *
 * It stays false because BTC CANNOT BE REHEARSED. `dids.Parse` tries
 * `ParseEthDID` then `ParseBtcDID` — MAINNET ONLY — and never
 * `ParseBtcTestnetDID`, and every helper in btc.go is pinned to
 * `chaincfg.MainNetParams`. So the first Bitcoin transaction this app ever
 * sends is real mainnet money on a path no testnet run can exercise first.
 * Flipping this without that decision being made deliberately, by a person,
 * would spend a user's BTC to find out. See `vsc-tx/btc.ts`.
 */
function chainCanSign(kind: TokenAccount['kind']): boolean {
  return kind === 'evm';
}

function kindOf(method: string, network: string | null): TokenAccount['kind'] {
  if (method === 'btc_wallet') return 'btc';
  if (method === 'evm_wallet') return 'evm';
  // Fall back on the stored network when a future method name is unfamiliar,
  // rather than guessing 'hive' and mislabelling a wallet.
  return network === 'eip155' ? 'evm' : 'btc';
}

export function useTokenAccounts(): TokenAccounts {
  const { user, isHydrated, sessionUnavailable } = useUserClient();
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
    /**
     * ★ NOT `&& isLite` any more. An upgraded user still owns their wallet credentials,
     * and while their session cookie still says `lite` (which it does for up to 14 days,
     * since `/api/users/me` reads the cookie and never the DB) this lookup is what keeps
     * their wallet-held tokens visible. Harmless for a never-lite Hive account: it has no
     * lite session, the route answers 401, `query.data` stays undefined, and the branch
     * below simply yields the Hive account on its own - exactly the old behaviour.
     */
    enabled: loggedIn,
    staleTime: 5 * 60 * 1000
  });

  if (!loggedIn) {
    // F14 fix: `/api/users/me` failing looks IDENTICAL to genuinely signed
    // out through `loggedIn` alone. `sessionUnavailable` (use-user-core.ts's
    // own doc on the flag) is the third state: we asked and got a definitive
    // failure, not "no session". Reporting `failed` here — the SAME signal
    // this hook already uses for "the wallet lookup itself failed" — routes
    // it into the "couldn't check" notice every consumer (meritum-eligibility.tsx)
    // already renders for that, instead of the confident-looking
    // empty/logged-out shape a session blip used to produce.
    return { accounts: [], isLoading: false, failed: sessionUnavailable, canHold: false, canSign: false };
  }

  if (!isLite) {
    /**
     * ★★★ AN UPGRADED USER KEEPS THEIR WALLET ACCOUNTS (2026-08-19).
     *
     * This used to return the Hive account ALONE, which silently deleted a real position
     * from the interface. The sequence: someone signs in with a Bitcoin or Ethereum
     * wallet, is credited creator tokens under that wallet's `did:pkh`, later creates a
     * Hive account, and from that moment the app reads only `hive:<name>`. Their tokens
     * are still on chain, still theirs, and gone from every screen - portfolio, token
     * page, eligibility - with no message, because from the app's point of view the
     * account set is complete and healthy.
     *
     * Nothing on chain links the two identities. Magi never hears about a Lumen upgrade;
     * `markUpgraded` touches only our own DB row and does not remove the wallet
     * credential. So the wallet account remains real, remains funded, and must remain
     * VISIBLE - it is the only way its owner can see what is still theirs, or know there
     * is something to move.
     *
     * ★★ WHAT THIS DOES NOT COVER, STATED PLAINLY. It restores the wallet accounts only
     * while a LITE SESSION still exists - i.e. the whole window in which the upgraded
     * user's cookie still says `lite`. Once they sign in with their Hive keys they have
     * no lite session at all, `/api/lite/wallet/dids` cannot authenticate them, and their
     * wallet accounts are invisible again. Closing that needs a server-side lookup keyed
     * by `hive_account_name` (the DB row records it at upgrade), which is a route that
     * does not exist yet. Until it does, this narrows the hole; it does not close it.
     *
     * `canSign` is TRUE for the Hive one and per-chain for the wallet entries — the
     * same `chainCanSign` the pure-lite branch uses, so the two paths cannot drift
     * into disagreeing about what a given wallet can do. The derived `canSign` below
     * is `some(...)`, so the screens offer signing whenever ANY held account can sign.
     *
     * ★ A DUAL USER NOW HAS TWO SIGNERS, AND THAT IS A REAL CHANGE. Before the EVM
     * rail landed, a Hive+wallet user had exactly one signing identity, so "which
     * account signs" was never a question. It is now: holdings under the EVM DID must
     * be acted on BY that DID (`rate` is caller-gated at core/rating.go:68, and a
     * balance lives under the account that bought it), and a surface that always signs
     * as `accounts[0]` will refuse at the contract with a message about permissions
     * rather than about identity.
     */
    const hiveAccount: TokenAccount = { id: user.username, kind: 'hive', address: null, canSign: true };
    const walletAccounts: TokenAccount[] =
      query.data?.wallets.map((w) => ({
        id: w.did,
        kind: kindOf(w.method, w.network),
        address: w.address,
        canSign: chainCanSign(kindOf(w.method, w.network))
      })) ?? [];
    return {
      accounts: [hiveAccount, ...walletAccounts],
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

  const accounts: TokenAccount[] = query.data.wallets.map((w) => ({
    id: w.did,
    kind: kindOf(w.method, w.network),
    address: w.address,
    canSign: chainCanSign(kindOf(w.method, w.network))
  }));

  return {
    accounts,
    isLoading: false,
    failed: false,
    canHold: query.data.canHoldTokens,
    // DERIVED, not asserted — so it cannot drift from the per-account truth when
    // the first chain is switched on.
    canSign: accounts.some((a) => a.canSign)
  };
}
