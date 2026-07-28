'use client';

import { getChain } from '@transaction/lib/chain';

/**
 * Hive account keys, generated IN THE BROWSER and never sent anywhere.
 *
 * This is the whole security property of the upgrade flow, so it is worth stating
 * plainly: the master password below is the account's owner key in another form.
 * Whoever holds it owns the account permanently — they can rotate every other key,
 * and once they change the owner key, Hive's 30-day recovery window is the only way
 * back. A server that mints it, receives it, logs it or stores it is a party that can
 * take the account later, and our own upgrade screen promises the opposite
 * ("your own keys"). So it is made here, shown to the user, and the only thing that
 * ever leaves this module is the four PUBLIC keys.
 *
 * Nothing here touches the network. `getChain()` returns the wax instance the rest of
 * the app already uses, which matters for one non-obvious reason: it carries the
 * chain's address prefix, so on a testnet the public keys come out as `TST…` rather
 * than mainnet `STM…` and the account is created with keys the node will accept.
 */

export interface RoleKey {
  publicKey: string;
  privateWif: string;
}

export interface AccountKeys {
  masterPassword: string;
  owner: RoleKey;
  active: RoleKey;
  posting: RoleKey;
  memo: RoleKey;
}

export interface PublicKeySet {
  owner: string;
  active: string;
  posting: string;
  memo: string;
}

const ROLES = ['owner', 'active', 'posting', 'memo'] as const;

/**
 * Mint a master password and expand it into the four role keys for `accountName`.
 *
 * Hive's derivation mixes the ACCOUNT NAME into every key, so these keys open that
 * name and no other. Generate them only once the name is final — keys derived for a
 * name that is then changed would produce an account nobody can open.
 *
 * The password is `'P' + WIF`: the format Hive wallets expect, and the format
 * `packages/ui/lib/sentry-scrub.ts` redacts, so an accidental error report cannot
 * carry a usable owner key.
 */
export async function generateAccountKeys(accountName: string): Promise<AccountKeys> {
  const name = accountName.trim().toLowerCase();
  if (!name) throw new Error('An account name is required to derive keys');

  const wax = await getChain();
  // wax's own CSPRNG, the same call the wallet app's password-change screen uses.
  const masterPassword = `P${wax.suggestBrainKey().wifPrivateKey}`;

  const derived = ROLES.map((role) => {
    const key = wax.getPrivateKeyFromPassword(name, role, masterPassword);
    return [role, { publicKey: key.associatedPublicKey, privateWif: key.wifPrivateKey }] as const;
  });
  const roles = Object.fromEntries(derived) as Record<(typeof ROLES)[number], RoleKey>;

  // Cheap self-check: four identical keys, or a role that failed to derive, would
  // otherwise become an account with a broken authority structure that cannot be
  // fixed after the fact.
  const distinct = new Set(ROLES.map((role) => roles[role].publicKey));
  if (distinct.size !== ROLES.length || [...distinct].some((key) => !key)) {
    throw new Error('Key derivation produced an unusable set of keys');
  }

  return { masterPassword, owner: roles.owner, active: roles.active, posting: roles.posting, memo: roles.memo };
}

/** The only part of {@link AccountKeys} that may cross the network. */
export function publicKeysOf(keys: AccountKeys): PublicKeySet {
  return {
    owner: keys.owner.publicKey,
    active: keys.active.publicKey,
    posting: keys.posting.publicKey,
    memo: keys.memo.publicKey
  };
}

/**
 * Re-derive from the master password and confirm the result matches — used after the
 * account is created, against the owner key the chain actually holds.
 *
 * It answers the one question the user cannot check for themselves: does the password
 * I just wrote down actually open the account that now exists? Everything else about
 * this flow is recoverable; that is not.
 */
export async function ownerKeyMatches(
  accountName: string,
  masterPassword: string,
  onChainOwnerKey: string
): Promise<boolean> {
  const wax = await getChain();
  const derived = wax.getPrivateKeyFromPassword(
    accountName.trim().toLowerCase(),
    'owner',
    masterPassword
  ).associatedPublicKey;
  // Compare bodies, not the printed form: a node renders keys with ITS network prefix
  // (STM/TST) and the prefix is not part of the key.
  const strip = (key: string) => (/^[A-Z]{3}[1-9A-HJ-NP-Za-km-z]+$/.test(key) ? key.slice(3) : key);
  return strip(derived) === strip(onChainOwnerKey);
}
