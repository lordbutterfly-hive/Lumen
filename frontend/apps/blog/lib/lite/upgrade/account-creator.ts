/**
 * Account-creation seam (spec §F.1/§F.3). The real implementation:
 *  - claims ACTs as the creator account (`claim_account`, fee=0 / RC),
 *  - broadcasts `create_claimed_account` signed by that account's ACTIVE authority
 *    (strictly more dangerous than posting, so a distinct signer tier).
 *
 * ★ IT DOES NOT GENERATE KEYS, AND CANNOT. Private keys are minted in the user's
 * BROWSER (`features/lite-auth/upgrade/browser-keys.ts`) and only the four PUBLIC
 * keys are sent here. A Hive master password is the owner key: any server that mints
 * or receives one can take the account back later, however carefully it is handled —
 * and our upgrade screen tells the user the account is theirs alone. The interface
 * therefore has no `generateKeys` and no type that can carry a private key, so a
 * future change cannot quietly reintroduce server-side custody without redefining
 * this contract in the open.
 *
 * Everything here is INFRA-GATED (active key in KMS + a real Hive account), so it is
 * injected via `setAccountCreator`.
 */

/** The four public keys a fresh account is created with. Public: safe to transmit, log and store. */
export interface AccountPublicKeys {
  owner: string;
  active: string;
  posting: string;
  memo: string;
}

export interface AccountCreator {
  accountExists(name: string): Promise<boolean>;
  /**
   * Every public key in the account's OWNER authority, or null when there is no such
   * account (or it cannot be determined).
   *
   * Existence alone is NOT proof that an ambiguous creation of ours succeeded: after a
   * timed-out broadcast the name can be taken by someone else entirely. This lets
   * reconciliation ask "is that account the one WE created?" — by comparing against the
   * owner key the user's browser submitted — instead of "is that name used?".
   *
   * Optional so a stub or partial implementation still satisfies the interface — but an
   * implementation without it can never PROVE an account is ours, and reconciliation
   * refuses to adopt on anything less than proof. Production implementations must have it.
   */
  accountOwnerKeys?(name: string): Promise<string[] | null>;
  pendingActCount(): Promise<number>;
  claimAct(): Promise<{ trxId: string }>;
  /**
   * Create the account. `onBroadcast` is called at the moment the transaction is handed
   * to the chain and not before — after that point a failure is AMBIGUOUS (the account
   * may exist), while every earlier failure provably created nothing. The caller needs
   * that distinction to know whether it may safely release the name and retry.
   */
  createClaimedAccount(
    newName: string,
    keys: AccountPublicKeys,
    onBroadcast?: () => void
  ): Promise<{ trxId: string }>;
}

let creator: AccountCreator | null = null;

export function setAccountCreator(impl: AccountCreator): void {
  // Loud at wiring time, not silently degraded at 3am. Without this method,
  // reconciliation can never PROVE an account is ours, so it refuses every ambiguous
  // case — which permanently wedges any user whose attempt is in flight and whose name
  // now exists on chain. Refusing is the right call; discovering the cause then is not.
  if (!impl.accountOwnerKeys) {
    throw new Error(
      'AccountCreator must implement accountOwnerKeys(): without it an interrupted upgrade can never be reconciled'
    );
  }
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
