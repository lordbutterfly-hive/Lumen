/**
 * Which Hive operations each tab of the wallet's activity list asks the chain
 * for, and the uint64 filter mask that asks for them.
 *
 * ★ NO CHAIN IMPORTS IN THIS FILE, ON PURPOSE. `account-history.ts` next door
 * needs a wax `Chain` (vests -> HP, asset symbols), which makes it unusable
 * from a plain `ts-node` test and from the client bundle. Everything here is
 * pure data + arithmetic, so the tab bar (client), the route (server) and
 * `lib/__tests__/wallet-history-groups.test.ts` can all share one definition of
 * what "Rewards" means.
 *
 * ★★★ THE MASK IS A STRING, NEVER A NUMBER (measured 2026-09-18, api.hive.blog).
 * `account_history_api.get_account_history` takes `operation_filter_low` /
 * `operation_filter_high` as uint64 BITSETS keyed by op type id. The mask this
 * wallet needs is 14671040415445024796 — far past `Number.MAX_SAFE_INTEGER`, so
 * a JS number silently rounds it to 14671040415445025000 and CHANGES WHICH BITS
 * ARE SET. Sent that way the live node answered with a different set of
 * operations: the account's newest `transfer_operation` vanished from the page
 * and an `author_reward_operation` took its place. hived parses a JSON string
 * into uint64 exactly, so the mask crosses the wire as a decimal string and is
 * built here with BigInt.
 */

export type HistoryGroup = 'all' | 'rewards' | 'transfers';

/** Tab order, left to right. `all` first: it is the honest default. */
export const HISTORY_GROUPS = ['all', 'rewards', 'transfers'] as const;

/**
 * What the row is, for colour and icon. NOT the same question as the amount's
 * sign (`HistoryTone`): a power-up moves money out of the liquid balance but is
 * not a payment, and a savings deposit is neither.
 */
export type HistoryCategory = 'in' | 'out' | 'reward' | 'power' | 'savings' | 'market' | 'other';

/**
 * "Rewards" = what the network paid you.
 *
 * `producer_reward_operation` is deliberately NOT here. It is block-production
 * pay, one op every ~2.5 minutes for a witness account (~576/day), which would
 * bury every author and curation reward in the tab whose whole purpose is to
 * show them. The HP it pays is still counted in the balances above the list.
 */
export const REWARD_OPERATION_NAMES = [
  'author_reward_operation',
  'curation_reward_operation',
  'comment_benefactor_reward_operation',
  'claim_reward_balance_operation',
  'interest_operation'
] as const;

/**
 * "Send & receive" = money moving between accounts, INCLUDING HP (owner,
 * 2026-09-18: "send receive would be HP send receive and normal transactions").
 * So a power up, a power down and a delegation belong here beside a plain
 * transfer — they are all "this account sent/received value", the difference is
 * only which form the value took.
 */
export const TRANSFER_OPERATION_NAMES = [
  'transfer_operation',
  'recurrent_transfer_operation',
  'fill_recurrent_transfer_operation',
  'transfer_to_savings_operation',
  'transfer_from_savings_operation',
  'cancel_transfer_from_savings_operation',
  'fill_transfer_from_savings_operation',
  'transfer_to_vesting_operation',
  'withdraw_vesting_operation',
  'fill_vesting_withdraw_operation',
  'delegate_vesting_shares_operation',
  'return_vesting_delegation_operation'
] as const;

/**
 * Market and conversion operations. They have no tab of their own — three tabs
 * is the whole design — but they are real wallet movements, so "All" carries
 * them rather than hiding them behind a filter nobody asked for.
 */
export const MARKET_OPERATION_NAMES = [
  'fill_order_operation',
  'limit_order_create_operation',
  'limit_order_cancel_operation',
  'convert_operation',
  'fill_convert_request_operation',
  'collateralized_convert_operation',
  'fill_collateralized_convert_request_operation'
] as const;

export const ALL_HISTORY_OPERATION_NAMES: readonly string[] = Array.from(
  new Set<string>([...REWARD_OPERATION_NAMES, ...TRANSFER_OPERATION_NAMES, ...MARKET_OPERATION_NAMES])
);

export function operationNamesForGroup(group: HistoryGroup): readonly string[] {
  switch (group) {
    case 'rewards':
      return REWARD_OPERATION_NAMES;
    case 'transfers':
      return TRANSFER_OPERATION_NAMES;
    default:
      return ALL_HISTORY_OPERATION_NAMES;
  }
}

export function parseHistoryGroup(raw: unknown): HistoryGroup | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && (HISTORY_GROUPS as readonly string[]).includes(value)
    ? (value as HistoryGroup)
    : null;
}

export interface OperationFilterMask {
  /** Bits for op type ids 0-63, as a decimal string. */
  low: string;
  /** Bits for op type ids 64-127, as a decimal string. */
  high: string;
}

/**
 * Turn op type ids into the two-word bitset hived expects. Ids outside 0-127
 * cannot be expressed by this API at all, so they are dropped here rather than
 * corrupting the mask (the chain has 93 op types today; the ceiling is real but
 * far off).
 */
export function operationFilterMask(opTypeIds: readonly number[]): OperationFilterMask {
  let low = BigInt(0);
  let high = BigInt(0);
  for (const id of opTypeIds) {
    if (!Number.isInteger(id) || id < 0 || id > 127) continue;
    if (id < 64) low |= BigInt(1) << BigInt(id);
    else high |= BigInt(1) << BigInt(id - 64);
  }
  return { low: low.toString(), high: high.toString() };
}

/**
 * The category a row falls in, from its operation type alone — except for a
 * plain transfer, where the direction decides and only the caller knows which
 * account is "you".
 */
export function categoryForOperation(type: string, incoming?: boolean): HistoryCategory {
  switch (type) {
    case 'transfer_operation':
    case 'recurrent_transfer_operation':
    case 'fill_recurrent_transfer_operation':
      return incoming ? 'in' : 'out';
    case 'transfer_from_savings_operation':
    case 'fill_transfer_from_savings_operation':
      return 'in';
    case 'transfer_to_savings_operation':
    case 'cancel_transfer_from_savings_operation':
      return 'savings';
    case 'transfer_to_vesting_operation':
    case 'withdraw_vesting_operation':
    case 'fill_vesting_withdraw_operation':
    case 'delegate_vesting_shares_operation':
    case 'return_vesting_delegation_operation':
      return 'power';
    case 'author_reward_operation':
    case 'curation_reward_operation':
    case 'comment_benefactor_reward_operation':
    case 'claim_reward_balance_operation':
    case 'interest_operation':
      return 'reward';
    case 'fill_order_operation':
    case 'limit_order_create_operation':
    case 'limit_order_cancel_operation':
    case 'convert_operation':
    case 'fill_convert_request_operation':
    case 'collateralized_convert_operation':
    case 'fill_collateralized_convert_request_operation':
      return 'market';
    default:
      return 'other';
  }
}

/**
 * Where one page starts and how big it can be.
 *
 * hived asserts `start >= limit - 1` on `get_account_history` (sequence numbers
 * are 0-based, and a page cannot reach below the first operation an account
 * ever had). Near the beginning of a history the page therefore has to SHRINK
 * to what is left, or the node refuses the whole request — which the reader
 * would see as "couldn't load your transaction history" exactly when they
 * finally reached the end of it. `start: -1` means "newest" and is exempt.
 */
export function pageBoundsFromCursor(
  cursor: number | null,
  pageSize: number
): { start: number; limit: number } {
  if (cursor === null) return { start: -1, limit: pageSize };
  return { start: cursor, limit: Math.max(1, Math.min(pageSize, cursor + 1)) };
}

/**
 * The cursor for the NEXT (older) page, given the sequence numbers this page
 * returned and the limit it was asked for.
 *
 * Two ways a page is the last one, both measured against the live node:
 *  - it came back SHORT, which means the filtered scan reached the beginning of
 *    the account's history (the scan really does cover all of it: a filter for
 *    one rare operation type returned a 2022 match out of 658k operations);
 *  - its oldest row is sequence 0, the first operation the account ever had.
 */
export function nextCursorFrom(
  sequences: readonly number[],
  limit: number
): { nextCursor: number | null; hasMore: boolean } {
  if (sequences.length === 0) return { nextCursor: null, hasMore: false };
  const oldest = Math.min(...sequences);
  const hasMore = sequences.length >= limit && oldest > 0;
  return { nextCursor: hasMore ? oldest - 1 : null, hasMore };
}
