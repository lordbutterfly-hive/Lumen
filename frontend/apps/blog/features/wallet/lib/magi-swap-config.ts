/**
 * Swap configuration for the wallet's Magi tab, built from the same env the
 * creator-tokens feature is provisioned with plus the two contract ids the Magi
 * SDK's own MAINNET_CONFIG/TESTNET_CONFIG carry
 * (crosschain-sdk/packages/core/src/types/index.ts:35-64). Nothing here is a
 * guessed default: an unset DEX router id means "no swap dialog", exactly as an
 * unset creator-tokens contract means "Meritum isn't available on this build".
 *
 * No React and no SDK import in this file, so the account card can ask
 * `isMagiSwapConfigured()` without pulling the SDK into the tab's bundle; the
 * dialog itself imports the SDK lazily.
 */
import env from '@beam-australia/react-env';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { getMagiBtcMappingContractId } from '@/blog/lib/lite/wallet/magi-btc-balance';

export interface MagiSwapConfig {
  network: 'vsc-mainnet' | 'vsc-testnet';
  dexRouterContractId: string;
  btcMappingContractId: string;
  gatewayAccount: string;
  /** The L1 asset symbols the deposit leg is denominated in on this network. */
  hiveAssetName: string;
  hbdAssetName: string;
}

function readEnv(key: string): string | undefined {
  const value = env(key);
  return value && value.length > 0 ? value : undefined;
}

export function getMagiSwapConfig(): MagiSwapConfig | null {
  const ct = getCreatorTokensConfig();
  const dexRouterContractId = readEnv('MAGI_DEX_ROUTER_CONTRACT_ID');
  const btcMappingContractId = getMagiBtcMappingContractId();
  // The indexer is deliberately NOT required: the swap quote is read from the
  // router's own chain state through the proxy (lib/magi-swap.ts), never from
  // the indexer (security review M1, 2026-09-08).
  if (!ct || !dexRouterContractId || !btcMappingContractId) return null;
  if (ct.netId !== 'vsc-mainnet' && ct.netId !== 'vsc-testnet') return null;
  const network = ct.netId;
  return {
    network,
    dexRouterContractId,
    btcMappingContractId,
    gatewayAccount: readEnv('MAGI_GATEWAY_ACCOUNT') ?? 'vsc.gateway',
    // The Hive testnet the Magi testnet reads denominates its assets TESTS/TBD
    // (Altera: getHiveAssetName/getHbdAssetName; SDK TESTNET_CONFIG:60-61).
    hiveAssetName: network === 'vsc-testnet' ? 'TESTS' : 'HIVE',
    hbdAssetName: network === 'vsc-testnet' ? 'TBD' : 'HBD'
  };
}

export function isMagiSwapConfigured(): boolean {
  return getMagiSwapConfig() !== null;
}
