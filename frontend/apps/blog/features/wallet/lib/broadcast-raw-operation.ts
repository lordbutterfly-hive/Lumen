import { ITransaction } from '@hiveio/wax';
import { transactionService, TransactionBroadcastResult, TransactionOptions } from '@transaction/index';

/**
 * Builds, signs and broadcasts a single Hive operation that TransactionService
 * doesn't expose a typed helper for yet (convert_operation,
 * recurrent_transfer_operation). Mirrors TransactionService.processHiveAppOperation
 * exactly, using only its public methods (getChain / signTransaction /
 * broadcastTransaction / broadcastAndObserveTransaction) — the actual
 * signing still goes through the app's real smart-signer flow
 * (Keychain / HiveAuth / HiveSigner / password), same as every other wallet
 * action on this page.
 */
export async function broadcastRawOperation(
  buildOperation: (builder: ITransaction) => void,
  transactionOptions: TransactionOptions = {}
): Promise<TransactionBroadcastResult> {
  const { observe = false, singleSignKeyType, requiredKeyType } = transactionOptions;

  const chain = await transactionService.getChain();
  const txBuilder = await chain.createTransaction();

  buildOperation(txBuilder);
  txBuilder.validate();

  const signature = await transactionService.signTransaction(txBuilder, singleSignKeyType, requiredKeyType);
  txBuilder.addSignature(signature);

  return observe
    ? transactionService.broadcastAndObserveTransaction(txBuilder)
    : transactionService.broadcastTransaction(txBuilder);
}
