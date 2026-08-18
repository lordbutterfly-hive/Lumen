import type { IHiveChainInterface } from '@hiveio/wax';
import { TTransactionPackType, ApiTransaction } from '@hiveio/wax';
import { getLogger } from '@hive/ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
// ★ One shared definition of "Hive was unreachable" — this file used to keep a
// private copy, and the server had none, so the same blip was reported two
// different ways. See lib/hive-network-error.ts.
import { isHiveNetworkError, withHiveRetry } from '@smart-signer/lib/hive-network-error';

const logger = getLogger('app');

/**
 * Verify authority of a signed transaction on chain.
 * Throws user-friendly errors for known failure cases, and re-throws
 * network errors as-is to avoid misattribution.
 *
 * @param txApiJson - Transaction in API JSON format (from txBuilder.toApiJson())
 * @param pack - Transaction pack type
 * @param keyType - The authority the transaction ACTUALLY REQUIRED (e.g. 'posting',
 *   'active'). It is used only to word the error, and wording it wrong sends the
 *   user to fix the wrong key.
 *
 *   ★ ALL FIVE SIGNERS GOT THIS WRONG (fixed 2026-08-17). Every signer signs with
 *   `requiredKeyType ?? this.keyType` — the authority the CALLER asked for — but
 *   each passed `this.keyType` here, which is the authority the SESSION was
 *   created with. Those differ exactly when a caller needs to step up, which is
 *   the case that fails and therefore the only case this message is ever read in.
 *
 *   Lumen makes that the normal path: a Hive login is hard-coded to POSTING
 *   (`features/lite-auth/login/keychain-signin.tsx`), while a creator-token write
 *   asks for ACTIVE. So a user whose Keychain holds no active key was told
 *   "The provided key does not have POSTING authority for this account" — about a
 *   posting key that was present and fine. The fix they needed was to add their
 *   active key; the sentence pointed at the one thing that was not the problem.
 *
 *   Note this never affected the VERIFICATION: `verify_authority` below is passed
 *   only `trx` and `pack`, and the chain derives the required authority from the
 *   operations themselves. This was always and only a wrong sentence.
 * @param signerName - Name of the signer for logging (e.g. 'Google Drive', 'Keychain')
 */
export async function verifyAuthorityOrThrow(
  txApiJson: ApiTransaction,
  pack: TTransactionPackType,
  keyType: string,
  signerName: string,
  /**
   * ★ The chain to verify AGAINST (2026-08-18). Defaults to the global chain,
   * so every existing caller is byte-identical. It exists because this check
   * was actively MASKING the Meritum launch failure: a Keychain signature made
   * for mainnet verifies fine on mainnet, so this passed and let a transaction
   * through that the testnet node was always going to reject. A guard that
   * checks a different chain than the one you broadcast to is worse than none.
   */
  chain?: IHiveChainInterface
): Promise<void> {
  try {
    await withHiveRetry(
      async () =>
        (chain ?? (await getChain())).api.database_api.verify_authority({
          trx: txApiJson,
          pack
        }),
      `${signerName} verify_authority`
    );
  } catch (error) {
    logger.error('%s key authority verification failed: %s', signerName, error instanceof Error ? error.message : String(error));
    const msg = error instanceof Error ? error.message : String(error);

    // Re-throw network errors as-is — don't misattribute them as authority failures
    if (isHiveNetworkError(error)) {
      throw error;
    }

    if (/unknown key/i.test(msg)) {
      throw new Error('Account not found on the blockchain');
    }
    throw new Error(`The provided key does not have ${keyType} authority for this account`);
  }
}
