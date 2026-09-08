/**
 * Sign and broadcast Hive L1 operations for the wallet's Magi tab (a deposit to
 * the Magi gateway, a swap through the Magi DEX router) with the ACTIVE key,
 * on the Hive chain the Magi network actually reads.
 *
 * ★ WHY NOT `useSendMutation` / `transactionService.transfer` DIRECTLY. Those sign
 * against the app's default chain (REACT_APP_API_ENDPOINT). The Magi network a
 * deployment is provisioned for reads a specific Hive chain, configured as
 * REACT_APP_CREATOR_TOKENS_HIVE_API + _HIVE_CHAIN_ID; on production both are
 * Hive mainnet, on the testnet stack the creator-tokens config points at the
 * Hive TESTNET the Magi testnet ingests. A deposit signed on the wrong chain
 * would either fail or, worse, move real mainnet HIVE for a testnet balance.
 * So this follows creator-tokens/lib/vsc/broadcaster.ts:214-247 line for line:
 * same chain override, same signer call, same broadcast call, and the same
 * session check (`assertActiveSignerFor`) that refuses posting-only or
 * mismatched signers before anything is signed.
 */
import type { ITransaction } from '@hiveio/wax';
import { KeyType } from '@smart-signer/types/common';
import { transactionService } from '@transaction/index';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { assertActiveSignerFor } from '@/blog/features/creator-tokens/lib/vsc/broadcaster';
import { getCreatorTokensHiveChain, type CreatorTokensChainOverride } from '@/blog/features/creator-tokens/lib/vsc/hive-chain';

export interface MagiL1BroadcastResult {
  transactionId: string;
}

/** The Hive chain the provisioned Magi network reads, when it differs from the app default. */
export function getMagiL1ChainOverride(): CreatorTokensChainOverride | null {
  const config = getCreatorTokensConfig();
  if (!config) return null;
  if (config.hiveApi || config.hiveChainId) {
    return { apiEndpoint: config.hiveApi ?? '', chainId: config.hiveChainId ?? '' };
  }
  return null;
}

/** True only when the Hive chain the Magi network reads is configured explicitly. */
export function isMagiL1Configured(): boolean {
  return getMagiL1ChainOverride() !== null;
}

export async function broadcastMagiL1(
  username: string,
  build: (tx: ITransaction) => void
): Promise<MagiL1BroadcastResult> {
  assertActiveSignerFor(username);
  const override = getMagiL1ChainOverride();
  // ★ NO FALLBACK TO THE APP DEFAULT CHAIN (2026-09-08). The default is Hive
  // MAINNET whenever REACT_APP_API_ENDPOINT/CHAIN_ID are unset, so a testnet
  // Magi with no override would sign a real mainnet transfer here. Unavailable
  // is the only honest degradation for a money path; the go-live checklist
  // already requires both override vars on mainnet.
  if (!override) {
    throw new Error(
      'MAGI_L1_CHAIN_NOT_CONFIGURED: REACT_APP_CREATOR_TOKENS_HIVE_API and REACT_APP_CREATOR_TOKENS_HIVE_CHAIN_ID must be set for Magi deposits and swaps. Refusing to sign on the app default chain.'
    );
  }
  const chain = await getCreatorTokensHiveChain(override);
  const txBuilder = await chain.createTransaction();
  build(txBuilder);
  txBuilder.validate();
  const signature = await transactionService.signTransaction(
    txBuilder,
    undefined,
    KeyType.active,
    chain,
    override.apiEndpoint || undefined,
    override.chainId || undefined
  );
  txBuilder.addSignature(signature);
  await chain.api.network_broadcast_api.broadcast_transaction({
    max_block_age: -1,
    trx: txBuilder.toApiJson()
  });
  return { transactionId: txBuilder.id };
}
