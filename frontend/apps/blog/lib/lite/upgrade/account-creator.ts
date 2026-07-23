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
