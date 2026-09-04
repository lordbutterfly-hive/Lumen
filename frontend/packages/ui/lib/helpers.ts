import type { NaiAsset } from '@hiveio/wax';
import Big from 'big.js';
import {
  getAssetConfig,
  getNaiSymbols,
  isAssetConstantsInitialized
} from './asset-constants';

// Re-export helper functions from asset-constants
export { isAssetConstantsInitialized };

export function convertStringToBig(number: string | NaiAsset): Big {
  if (number === '') throw new Error('Number cant be empty string');
  if (typeof number === 'string') {
    return new Big(number.split(' ')[0]);
  }
  // For NaiAsset, divide amount by 10^precision to get actual value.
  // ★ DEFENSIVE (2026-08-06): a missing/partial asset used to crash the whole
  // app here (`reading 'amount' of undefined`) because callers pass chain
  // responses straight in, and a keyless Lumen Lite account has no chain data
  // to return. The real fix is at the caller (don't ask the chain about a
  // non-chain account); this stops any future caller turning absent data into
  // a blank white page.
  if (!number || number.amount === undefined || number.amount === null) return new Big(0);
  return new Big(number.amount).div(new Big(10).pow(number.precision));
}

/**
 * Checks if a NaiAsset is HBD.
 * Requires asset constants to be initialized via initializeAssetConstants().
 */
export function isHbd(asset: NaiAsset): boolean {
  return asset.nai === getAssetConfig().HBD.nai;
}

/**
 * Checks if a NaiAsset is HIVE.
 * Requires asset constants to be initialized via initializeAssetConstants().
 */
export function isHive(asset: NaiAsset): boolean {
  return asset.nai === getAssetConfig().HIVE.nai;
}

/**
 * Checks if a NaiAsset is VESTS.
 * Requires asset constants to be initialized via initializeAssetConstants().
 */
export function isVests(asset: NaiAsset): boolean {
  return asset.nai === getAssetConfig().VESTS.nai;
}

/**
 * Formats a NaiAsset to a human-readable string like "1.234 HIVE"
 * @param asset - The NaiAsset to format
 * @param overrideSymbol - Optional symbol override (e.g., 'HP' instead of 'HIVE')
 * @returns Formatted string like "1.234 HIVE"
 */
export function formatNaiAsset(asset: NaiAsset, overrideSymbol?: string): string {
  const amount = Big(asset.amount).div(Big(10).pow(asset.precision));
  const naiSymbols = getNaiSymbols();
  const symbol = overrideSymbol || naiSymbols[asset.nai] || '';
  return `${amount.toFixed(asset.precision)} ${symbol}`;
}
