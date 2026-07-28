/**
 * Account-creation seam (spec §F.1/§F.3). The real implementation:
 *  - claims ACTs as the frontend account (`claim_account`, prefer fee=0/RC),
 *  - generates the master password ('P' + WIF) and derives owner/active/posting/
 *    memo keys via `getPrivateKeyFromPassword` (the repo's existing keygen),
 *  - broadcasts `create_claimed_account` signed by the frontend account's ACTIVE
 *    authority (the isolated active-key service — strictly more dangerous than
 *    posting, so a distinct signer tier).
 *
 * All of that is INFRA-GATED (active key in KMS + a real Hive account), so it is
 * injected via `setAccountCreator`. The master password MUST be produced in the
 * 'P'+WIF format so the extended Sentry scrubber redacts it if it ever leaks.
 */

export interface KeyPair {
  publicKey: string;
  privateWif: string;
}

export interface GeneratedKeys {
  masterPassword: string;
  owner: KeyPair;
  active: KeyPair;
  posting: KeyPair;
  memo: KeyPair;
}

export interface AccountCreator {
  accountExists(name: string): Promise<boolean>;
  /**
   * The account's current OWNER public key, or null when there is no such account.
   *
   * Existence alone is NOT proof that an ambiguous creation of ours succeeded: after a
   * timed-out broadcast the name can be taken by someone else entirely, and handing
   * our user the keys we generated would hand them keys that open nothing. This lets
   * the reconciliation ask "is that account OURS?" instead of "is that name used?".
   *
   * Optional so a stub or a partial implementation still satisfies the interface;
   * reconciliation falls back to the existence check when it is absent.
   */
  accountOwnerKey?(name: string): Promise<string | null>;
  pendingActCount(): Promise<number>;
  claimAct(): Promise<{ trxId: string }>;
  generateKeys(accountName: string): Promise<GeneratedKeys>;
  createClaimedAccount(newName: string, keys: GeneratedKeys): Promise<{ trxId: string }>;
}

let creator: AccountCreator | null = null;

export function setAccountCreator(impl: AccountCreator): void {
  creator = impl;
}

export function hasAccountCreator(): boolean {
  return creator !== null;
}

export function getAccountCreator(): AccountCreator {
  if (!creator) {
    throw new Error('AccountCreator not configured — inject the active-key account service (spec §F)');
  }
  return creator;
}
