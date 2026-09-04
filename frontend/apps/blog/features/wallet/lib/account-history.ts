import type { NaiAsset, GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import type { HiveOperation } from '@hive/common-hiveio-packages/wax';
import { Chain } from '@transaction/lib/chain';
import { convertToHP } from '@ui/lib/utils';
import { getNaiSymbols } from '@ui/lib/asset-constants';
import { formatTokenAmount } from './format-amount';

/**
 * Operation types the wallet's "Recent activity" list understands — the same
 * set apps/wallet's pre-Lumen account-history feed fetched (see
 * apps/wallet/lib/hive.ts `walletOperations`), minus the escrow ops, which
 * that older UI never formatted into readable text either (it fell through
 * to a raw operation dump). Keeping the list here, not just in the hook,
 * because the formatter below has to stay exhaustive over exactly this set.
 */
export const WALLET_HISTORY_OPERATION_NAMES = [
  'transfer_operation',
  'transfer_to_vesting_operation',
  'withdraw_vesting_operation',
  'interest_operation',
  'transfer_to_savings_operation',
  'transfer_from_savings_operation',
  'cancel_transfer_from_savings_operation',
  'fill_order_operation',
  'claim_reward_balance_operation',
  'author_reward_operation'
] as const;

export type HistoryTone = 'credit' | 'debit' | 'neutral';

export interface HistoryCounterparty {
  name: string;
  direction: 'to' | 'from';
}

export interface DescribedHistoryEntry {
  /** React key. `operation_id` round-trips as a string in the REST response
   * (it exceeds Number.MAX_SAFE_INTEGER) — never do arithmetic on it. */
  key: string;
  timestamp: HiveOperation['timestamp'];
  labelKey: string;
  labelParams?: Record<string, string>;
  counterparty: HistoryCounterparty | null;
  tone: HistoryTone;
  amountText: string | null;
  memo: string | null;
}

interface DescribeContext {
  username: string;
  chain: Chain | null;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}

/**
 * `HiveOperation.op.value.vesting_shares` is declared `string` in
 * extended-hive.chain.ts, but the live hivemind REST response actually sends
 * it as a NaiAsset object (verified against api.hive.blog, 2026-08-08) — same
 * mismatch apps/wallet's own formatter worked around with an `as NaiAsset`
 * cast. This checks the shape at runtime instead of trusting either the
 * stale type or a blind cast.
 */
function asNaiAsset(value: unknown): NaiAsset | undefined {
  if (value && typeof value === 'object' && 'amount' in value && 'precision' in value && 'nai' in value) {
    return value as NaiAsset;
  }
  return undefined;
}

function isZeroAsset(asset: NaiAsset | undefined): boolean {
  return !asset || asset.amount === '0' || asset.amount === undefined;
}

function symbolFor(asset: NaiAsset): string {
  try {
    return getNaiSymbols()[asset.nai] ?? '';
  } catch {
    // Asset constants aren't initialized until the chain is — shouldn't
    // happen by the time this list can render, but a missing symbol must
    // never be the reason the whole card throws.
    return '';
  }
}

function formatAsset(asset: NaiAsset | undefined): string {
  if (!asset) return '';
  const symbol = symbolFor(asset);
  return symbol ? `${formatTokenAmount(asset)} ${symbol}` : formatTokenAmount(asset);
}

function formatHp(vests: NaiAsset | undefined, ctx: DescribeContext): string | null {
  if (!vests || !ctx.chain || !ctx.dynamicGlobal) return null;
  const hp = convertToHP(
    vests,
    ctx.chain,
    ctx.dynamicGlobal.total_vesting_shares,
    ctx.dynamicGlobal.total_vesting_fund_hive
  );
  return `${formatTokenAmount(hp)} HP`;
}

/** Non-zero parts of a reward payout, e.g. ["12.000 HIVE", "450.000 HP"] — a
 * payout that landed entirely in one asset (the common case since HF25) is
 * not padded out with "0.000 HBD" noise. */
function rewardParts(
  hive: NaiAsset | undefined,
  hbd: NaiAsset | undefined,
  vests: NaiAsset | undefined,
  ctx: DescribeContext
): string[] {
  const parts: string[] = [];
  if (!isZeroAsset(hive)) parts.push(formatAsset(hive));
  if (!isZeroAsset(hbd)) parts.push(formatAsset(hbd));
  if (!isZeroAsset(vests)) {
    const hp = formatHp(vests, ctx);
    if (hp) parts.push(hp);
  }
  return parts;
}

/** Localized "12 HIVE, 3 HBD and 450 HP" join — real list formatting, not a
 * hardcoded ", " + "and" that would be wrong in most other languages. */
function joinParts(parts: string[], lang: string): string {
  if (parts.length === 0) return '';
  try {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }).format(parts);
  } catch {
    return parts.join(', ');
  }
}

/** Resolves who the counterparty is relative to the account whose wallet
 * we're viewing, for the ops where `to`/`from` may or may not be the viewer
 * (a gifted power-up or a savings deposit made on someone else's behalf).
 * Returns null when both sides are the viewer's own account. */
function relativeToUser(
  from: string | undefined,
  to: string | undefined,
  username: string
): HistoryCounterparty | null {
  if (to && to !== username) return { name: to, direction: 'to' };
  if (from && from !== username) return { name: from, direction: 'from' };
  return null;
}

function humanizeOpType(type: string): string {
  return type.replace(/_operation$/, '').replace(/_/g, ' ');
}

/**
 * Turns one raw `HiveOperation` into the plain data the row component
 * renders — no JSX, no i18n calls (the label is a translation KEY plus
 * params; the caller decides the language). Returns null only when the
 * operation is malformed (missing `op`/`op.value`), which the REST response
 * shouldn't produce for the whitelisted types above, but the list must never
 * crash the page over one bad row.
 */
export function describeHistoryOperation(
  op: HiveOperation,
  ctx: DescribeContext,
  lang: string
): DescribedHistoryEntry | null {
  const { username } = ctx;
  const type = op.op?.type;
  const value = op.op?.value;
  if (!type || !value) return null;

  const key = String(op.operation_id);
  const memo = typeof value.memo === 'string' && value.memo.length > 0 ? value.memo : null;
  const base = { key, timestamp: op.timestamp, memo };

  switch (type) {
    case 'transfer_operation': {
      const incoming = value.to === username;
      const counterpartyName = incoming ? value.from : value.to;
      return {
        ...base,
        labelKey: incoming ? 'wallet.history.types.transfer_received' : 'wallet.history.types.transfer_sent',
        counterparty: counterpartyName ? { name: counterpartyName, direction: incoming ? 'from' : 'to' } : null,
        tone: incoming ? 'credit' : 'debit',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'transfer_to_savings_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.transfer_to_savings',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'transfer_from_savings_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.transfer_from_savings',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'credit',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'cancel_transfer_from_savings_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.cancel_savings_withdrawal',
        counterparty: null,
        tone: 'neutral',
        amountText: null
      };
    }
    case 'transfer_to_vesting_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.power_up',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'withdraw_vesting_operation': {
      const vestingShares = asNaiAsset(value.vesting_shares);
      const active = !isZeroAsset(vestingShares);
      return {
        ...base,
        labelKey: active ? 'wallet.history.types.power_down_started' : 'wallet.history.types.power_down_stopped',
        counterparty: null,
        tone: 'neutral',
        amountText: active ? formatHp(vestingShares, ctx) : null
      };
    }
    case 'interest_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.interest',
        counterparty: null,
        tone: 'credit',
        amountText: formatAsset(value.interest) || null
      };
    }
    case 'claim_reward_balance_operation': {
      const parts = rewardParts(value.reward_hive, value.reward_hbd, value.reward_vests, ctx);
      const amountText = parts.length > 0 ? joinParts(parts, lang) : formatAsset(value.reward_hive);
      return {
        ...base,
        labelKey: 'wallet.history.types.claim_rewards',
        counterparty: null,
        tone: 'credit',
        amountText: amountText || null
      };
    }
    case 'fill_order_operation': {
      const paid = formatAsset(value.current_pays);
      const received = formatAsset(value.open_pays);
      return {
        ...base,
        labelKey: 'wallet.history.types.market_trade',
        counterparty: null,
        tone: 'neutral',
        amountText: paid && received ? `${paid} → ${received}` : null
      };
    }
    case 'author_reward_operation': {
      const parts = rewardParts(value.hive_payout, value.hbd_payout, value.vesting_payout, ctx);
      const amountText = parts.length > 0 ? joinParts(parts, lang) : null;
      return {
        ...base,
        labelKey: 'wallet.history.types.author_reward',
        counterparty: null,
        tone: 'credit',
        amountText
      };
    }
    default:
      return {
        ...base,
        labelKey: 'wallet.history.types.other',
        labelParams: { type: humanizeOpType(type) },
        counterparty: null,
        tone: 'neutral',
        amountText: null
      };
  }
}
