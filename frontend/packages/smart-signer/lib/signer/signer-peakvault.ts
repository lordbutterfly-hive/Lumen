import { SignChallenge, SignTransaction, Signer, SignerOptions } from '@smart-signer/lib/signer/signer';
import { TTransactionPackType, IOnlineSignatureProvider } from '@hiveio/wax';

import { getLogger } from '@hive/ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { assertDigestMatches } from '@smart-signer/lib/signer/assert-digest';
import { verifyAuthorityOrThrow } from '@smart-signer/lib/signer/verify-authority';
import PeakVaultProvider from '@hiveio/wax-signers-peakvault';
const logger = getLogger('app');

declare global {
  interface Window {
    peakvault: any;
  }
}

export const hasCompatiblePeakvault = () => PeakVaultProvider.isExtensionInstalled();

/**
 * Signs challenges (any strings) or Hive transactions with Hive private
 * keys, using [Peakvault](https://vault.peakd.com/).
 *
 * @export
 * @class SignerPeakvault
 * @extends {Signer}
 */
export class SignerPeakvault extends Signer {
  constructor(signerOptions: SignerOptions, pack: TTransactionPackType = TTransactionPackType.LEGACY) {
    super(signerOptions, pack);
  }

  async destroy(): Promise<void> {}

  async signChallenge({ message }: SignChallenge): Promise<string> {
    const { username, keyType } = this;
    logger.info('in SignerPeakvault.signChallenge %o', { message, username, keyType });
    try {
      const provider = PeakVaultProvider.for(this.username, keyType);

      const signature = provider.encryptData(message, username);

      logger.info('peakvault', { signature });
      return signature;
    } catch (error) {
      throw error;
    }
  }

  async signTransaction({ digest, transaction, requiredKeyType, chain }: SignTransaction): Promise<string> {
    try {
      // `chain` is the chain the CALLER built on; omitted by every caller but
      // creator-tokens, which is on a different Hive L1. Falling back to the
      // global chain keeps every existing path byte-identical.
      const authTx = (chain ?? (await getChain())).createTransactionFromProto(transaction);
      assertDigestMatches(digest, authTx.sigDigest, 'PeakVault');

      const provider: IOnlineSignatureProvider = PeakVaultProvider.for(
        this.username,
        requiredKeyType ?? this.keyType
      );
      await provider.signTransaction(authTx);

      await verifyAuthorityOrThrow(authTx.toApiJson(), TTransactionPackType.LEGACY, requiredKeyType ?? this.keyType, 'Peakvault');
      // F-L13 (sibling site) — logged the raw login signature at info.
      // This transaction is NEVER broadcast: it is the off-chain auth proof
      // the backend verifies, so the signature IS the credential and pino has
      // no redaction on this path. Log that one was produced, not its value.
      logger.info('Peakvault signTransaction produced %d signature(s)', authTx.transaction.signatures.length);
      return authTx.transaction.signatures[0];
    } catch (error) {
      logger.error('SignerPeakvault.signTransaction error: %s', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
