import Big from 'big.js';
import { getRoundedAbbreveration } from '@ui/lib/math-utils';
import { SECONDS_PER_BLOCK } from './constants';

/** Minimal shape of `t()` this module needs — avoids coupling to a specific i18next namespace type. */
export type TFn = (key: string, options?: Record<string, unknown>) => string;

/** Formats HP vote weight, e.g. `102.90M`. */
export function formatHpVotes(hp: Big): string {
  return getRoundedAbbreveration(hp.lt(0) ? Big(0) : hp);
}

/** Formats a witness's HBD price feed as `$0.048`. */
export function formatPriceFeed(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '—';
  return `$${usd.toFixed(3)}`;
}

/** Converts a head-block/last-block delta into seconds since last produced block. */
export function blockAgeSeconds(headBlock: number, lastConfirmedBlock: number): number {
  if (!lastConfirmedBlock || lastConfirmedBlock < 1) return Number.POSITIVE_INFINITY;
  return Math.max(0, (headBlock - lastConfirmedBlock) * SECONDS_PER_BLOCK);
}

/** Formats a block-age in seconds into a short relative string using witnesses.* i18n keys. */
export function formatBlockAge(seconds: number, t: TFn): string {
  if (!Number.isFinite(seconds)) return t('witnesses.block_age.never');
  if (seconds < 5) return t('witnesses.block_age.now');
  if (seconds < 60) return t('witnesses.block_age.seconds_ago', { count: Math.floor(seconds) });
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return t('witnesses.block_age.minutes_ago', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return t('witnesses.block_age.hours_ago', { count: hrs });
  const days = Math.floor(hrs / 24);
  return t('witnesses.block_age.days_ago', { count: days });
}

/** Parses a NaiAsset-shaped HBD exchange base into a USD float. */
export function parsePriceFeedUsd(base: { amount: string; precision: number } | undefined): number {
  if (!base) return 0;
  const amount = Number(base.amount);
  if (!Number.isFinite(amount)) return 0;
  return amount / 10 ** base.precision;
}

/** Formats a NaiAsset (e.g. account_creation_fee) as `0.001 HIVE`. */
export function formatNaiAsset(asset: { amount: string; precision: number } | undefined, symbol: string): string {
  if (!asset) return '—';
  const amount = Number(asset.amount);
  if (!Number.isFinite(amount)) return '—';
  return `${(amount / 10 ** asset.precision).toFixed(3)} ${symbol}`;
}

/** Formats an integer with thousands separators, e.g. `65,536`. */
export function formatInteger(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}
