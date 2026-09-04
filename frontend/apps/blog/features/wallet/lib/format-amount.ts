import Big from 'big.js';
import type { NaiAsset } from '@hiveio/wax';
import { convertStringToBig } from '@ui/lib/helpers';
import { numberWithCommas } from '@ui/lib/utils';

/**
 * Formats a NaiAsset / Big / numeric string as a 3-decimal, comma-grouped
 * token amount string (e.g. "36,712.514") — the format every balance on the
 * wallet page uses.
 */
export function formatTokenAmount(value: NaiAsset | Big | string, decimals = 3): string {
  const big = typeof value === 'string' ? new Big(value) : value instanceof Big ? value : convertStringToBig(value);
  return numberWithCommas(big.toFixed(decimals));
}

/**
 * Formats a USD amount as "$1,234.56".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$—';
  return `$${numberWithCommas(value.toFixed(2))}`;
}
