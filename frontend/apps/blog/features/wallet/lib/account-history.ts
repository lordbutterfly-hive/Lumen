import type { NaiAsset, GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import type { HiveOperation } from '@hive/common-hiveio-packages/wax';
import { Chain } from '@transaction/lib/chain';
import { convertToHP } from '@ui/lib/utils';
import { getNaiSymbols } from '@ui/lib/asset-constants';
import { formatTokenAmount } from './format-amount';
import { categoryForOperation, type HistoryCategory } from './history-groups';

/**
 * Operation types the wallet's activity list understands.
 *
 * ★ THE SET NOW LIVES IN `history-groups.ts` (2026-09-18), because the tabs
 * above the list — All / Rewards / Send & receive — each ask the chain for a
 * DIFFERENT subset of it, and the tab bar (client) and the route (server) have
 * to agree on which. That file has no chain imports so both sides can read it.
 * This re-export keeps the old name working for anything that only wants "every
 * operation this list can render".
 *
 * The formatter below has to stay exhaustive over exactly that set: an
 * operation with no case falls through to `other`, which renders the op name
 * and NO amount — honest, but useless on a money list.
 */
export { ALL_HISTORY_OPERATION_NAMES as WALLET_HISTORY_OPERATION_NAMES } from './history-groups';

export type HistoryTone = 'credit' | 'debit' | 'neutral';

export interface HistoryCounterparty {
  name: string;
  direction: 'to' | 'from';
}

export interface DescribedHistoryEntry {
  /** React key. The per-account operation sequence number from
   * `account_history_api.get_account_history`, as a string — it is also the
   * pagination cursor, and it is unique per account. */
  key: string;
  timestamp: HiveOperation['timestamp'];
  labelKey: string;
  labelParams?: Record<string, string>;
  counterparty: HistoryCounterparty | null;
  tone: HistoryTone;
  /**
   * What kind of movement this is — money in, money out, a reward, HP, savings,
   * the market. Drives the row's icon and colour. Deliberately NOT the same
   * question as `tone`: a power-up leaves the liquid balance but is not a
   * payment, and a savings deposit is neither a credit nor a debit.
   */
  category: HistoryCategory;
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
 * extended-hive.chain.ts, but the live response actually sends it as a NaiAsset
 * object (verified against api.hive.blog, 2026-08-08, re-verified against
 * `account_history_api.get_account_history` 2026-09-18) — same mismatch
 * apps/wallet's own formatter worked around with an `as NaiAsset` cast. This
 * checks the shape at runtime instead of trusting either the stale type or a
 * blind cast.
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

/**
 * A VESTS amount as HP, or — when the chain/global props are missing, which is
 * the only way `formatHp` returns null — nothing at all rather than a raw VESTS
 * number nobody can read.
 */
function hpOrNull(value: unknown, ctx: DescribeContext): string | null {
  const vests = asNaiAsset(value);
  if (!vests || isZeroAsset(vests)) return null;
  return formatHp(vests, ctx);
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
 * operation is malformed (missing `op`/`op.value`), which the chain
 * shouldn't produce for the whitelisted types, but the list must never
 * crash the page over one bad row.
 *
 * `key` is passed in because the two APIs that can produce a `HiveOperation`
 * key it differently: the REST one carries a global `operation_id`, while
 * `account_history_api.get_account_history` carries the per-account SEQUENCE
 * number beside the operation (and sends `operation_id: 0` for every row —
 * measured, 2026-09-18, which would have collapsed every React key to "0").
 */
export function describeHistoryOperation(
  op: HiveOperation,
  ctx: DescribeContext,
  lang: string,
  key: string = String(op.operation_id)
): DescribedHistoryEntry | null {
  const { username } = ctx;
  const type = op.op?.type;
  const value = op.op?.value;
  if (!type || !value) return null;

  const memo = typeof value.memo === 'string' && value.memo.length > 0 ? value.memo : null;
  const base = { key, timestamp: op.timestamp, memo };

  switch (type) {
    case 'transfer_operation':
    case 'fill_recurrent_transfer_operation': {
      const incoming = value.to === username;
      const counterpartyName = incoming ? value.from : value.to;
      const recurrent = type === 'fill_recurrent_transfer_operation';
      return {
        ...base,
        labelKey: recurrent
          ? incoming
            ? 'wallet.history.types.recurrent_transfer_received'
            : 'wallet.history.types.recurrent_transfer_sent'
          : incoming
            ? 'wallet.history.types.transfer_received'
            : 'wallet.history.types.transfer_sent',
        counterparty: counterpartyName ? { name: counterpartyName, direction: incoming ? 'from' : 'to' } : null,
        tone: incoming ? 'credit' : 'debit',
        category: categoryForOperation(type, incoming),
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'recurrent_transfer_operation': {
      // The SET-UP of a recurring payment, not a payment: nothing moves until
      // the first `fill_recurrent_transfer_operation`. Amount shown because it
      // is the size of each instalment, tone neutral because this op moved
      // nothing. A zero amount is how a recurring transfer is CANCELLED.
      const cancelled = isZeroAsset(asNaiAsset(value.amount));
      return {
        ...base,
        labelKey: cancelled
          ? 'wallet.history.types.recurrent_transfer_stopped'
          : 'wallet.history.types.recurrent_transfer_started',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        category: 'out',
        amountText: cancelled ? null : formatAsset(value.amount) || null
      };
    }
    case 'transfer_to_savings_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.transfer_to_savings',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        category: 'savings',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'transfer_from_savings_operation': {
      // The REQUEST. The money lands three days later, as
      // `fill_transfer_from_savings_operation` — so this row must not be a
      // credit, or the same withdrawal reads as two arrivals.
      return {
        ...base,
        labelKey: 'wallet.history.types.transfer_from_savings',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        category: 'savings',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'fill_transfer_from_savings_operation': {
      const incoming = value.to === username || value.to === undefined;
      return {
        ...base,
        labelKey: 'wallet.history.types.savings_withdrawal_completed',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: incoming ? 'credit' : 'debit',
        category: incoming ? 'in' : 'out',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'cancel_transfer_from_savings_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.cancel_savings_withdrawal',
        counterparty: null,
        tone: 'neutral',
        category: 'savings',
        amountText: null
      };
    }
    case 'transfer_to_vesting_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.power_up',
        counterparty: relativeToUser(value.from, value.to, username),
        tone: 'neutral',
        category: 'power',
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
        category: 'power',
        amountText: active ? formatHp(vestingShares, ctx) : null
      };
    }
    case 'fill_vesting_withdraw_operation': {
      // One weekly instalment of a power down. `deposited` is HIVE when it
      // lands liquid and VESTS when the withdrawal is routed to another
      // account's power, so the asset decides which figure is honest here.
      const deposited = asNaiAsset(value.deposited);
      const depositedIsVests = deposited ? symbolFor(deposited) === 'VESTS' : false;
      const amountText = deposited
        ? depositedIsVests
          ? formatHp(deposited, ctx)
          : formatAsset(deposited)
        : hpOrNull(value.withdrawn, ctx);
      const incoming = value.to_account === username;
      return {
        ...base,
        labelKey: 'wallet.history.types.power_down_payout',
        counterparty: relativeToUser(value.from_account, value.to_account, username),
        tone: incoming ? 'credit' : 'debit',
        category: 'power',
        amountText
      };
    }
    case 'delegate_vesting_shares_operation': {
      const outgoing = value.delegator === username;
      const hp = hpOrNull(value.vesting_shares, ctx);
      const counterpartyName = outgoing ? value.delegatee : value.delegator;
      return {
        ...base,
        labelKey: hp
          ? outgoing
            ? 'wallet.history.types.delegation_out'
            : 'wallet.history.types.delegation_in'
          : 'wallet.history.types.delegation_removed',
        counterparty: counterpartyName ? { name: counterpartyName, direction: outgoing ? 'to' : 'from' } : null,
        tone: 'neutral',
        category: 'power',
        amountText: hp
      };
    }
    case 'return_vesting_delegation_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.delegation_returned',
        counterparty: null,
        tone: 'neutral',
        category: 'power',
        amountText: hpOrNull(value.vesting_shares, ctx)
      };
    }
    case 'interest_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.interest',
        counterparty: null,
        tone: 'credit',
        category: 'reward',
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
        category: 'reward',
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
        category: 'market',
        amountText: paid && received ? `${paid} → ${received}` : null
      };
    }
    case 'limit_order_create_operation': {
      const sell = formatAsset(value.amount_to_sell);
      const receive = formatAsset(value.min_to_receive);
      return {
        ...base,
        labelKey: 'wallet.history.types.market_order_placed',
        counterparty: null,
        tone: 'neutral',
        category: 'market',
        amountText: sell && receive ? `${sell} → ${receive}` : sell || null
      };
    }
    case 'limit_order_cancel_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.market_order_cancelled',
        counterparty: null,
        tone: 'neutral',
        category: 'market',
        amountText: null
      };
    }
    case 'convert_operation':
    case 'collateralized_convert_operation': {
      return {
        ...base,
        labelKey: 'wallet.history.types.convert_started',
        counterparty: null,
        tone: 'neutral',
        category: 'market',
        amountText: formatAsset(value.amount) || null
      };
    }
    case 'fill_convert_request_operation':
    case 'fill_collateralized_convert_request_operation': {
      const paid = formatAsset(value.amount_in);
      const received = formatAsset(value.amount_out);
      return {
        ...base,
        labelKey: 'wallet.history.types.convert_completed',
        counterparty: null,
        tone: received ? 'credit' : 'neutral',
        category: 'market',
        amountText: paid && received ? `${paid} → ${received}` : received || null
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
        category: 'reward',
        amountText
      };
    }
    case 'curation_reward_operation': {
      // One asset only (VESTS), and it is the reward for voting somebody
      // else's post — so the author is the counterparty worth naming.
      const author = typeof value.author === 'string' ? value.author : undefined;
      return {
        ...base,
        labelKey: 'wallet.history.types.curation_reward',
        counterparty: author && author !== username ? { name: author, direction: 'from' } : null,
        tone: 'credit',
        category: 'reward',
        amountText: hpOrNull(value.reward, ctx)
      };
    }
    case 'comment_benefactor_reward_operation': {
      const parts = rewardParts(value.hive_payout, value.hbd_payout, value.vesting_payout, ctx);
      const author = typeof value.author === 'string' ? value.author : undefined;
      return {
        ...base,
        labelKey: 'wallet.history.types.benefactor_reward',
        counterparty: author && author !== username ? { name: author, direction: 'from' } : null,
        tone: 'credit',
        category: 'reward',
        amountText: parts.length > 0 ? joinParts(parts, lang) : null
      };
    }
    default:
      return {
        ...base,
        labelKey: 'wallet.history.types.other',
        labelParams: { type: humanizeOpType(type) },
        counterparty: null,
        tone: 'neutral',
        category: categoryForOperation(type),
        amountText: null
      };
  }
}
