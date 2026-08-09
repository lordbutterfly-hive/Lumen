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
 * @param keyType - The key type being verified (e.g. 'posting', 'active')
 * @param signerName - Name of the signer for logging (e.g. 'Google Drive', 'Keychain')
 */
export async function verifyAuthorityOrThrow(
  txApiJson: ApiTransaction,
  pack: TTransactionPackType,
  keyType: string,
  signerName: string
): Promise<void> {
  try {
    await withHiveRetry(
      async () =>
        (await getChain()).api.database_api.verify_authority({
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
