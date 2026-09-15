/**
 * ★ ONE SIGNATURE FUNDS AND BUYS (owner, 2026-09-15: "if their hbd is on Hive
 * they just sign a tx directly from there, its sent via gateway").
 *
 * A Meritum buy is paid from the buyer's MAGI balance: the contract draws
 * cost+fee from the caller's L2 HBD under their signed `transfer.allow`
 * (creator-tokens/contract/main.go Buy -> sdk.HiveDraw). When that balance is
 * short, the buyer used to deposit first (a Hive transfer to the gateway with
 * memo `to=<name>`), wait about a minute for the credit, then buy.
 *
 * The node lets both ride in ONE Hive transaction. go-vsc-node
 * state_engine.go: a transfer to the gateway becomes a ledger deposit record
 * at ingest, in op order, BEFORE any contract call of that block executes in
 * ExecuteBatch; the call's draw reads the balance up to and including that
 * block (ledger GetLedgerRange `$lte`). The crosschain swap SDK builds exactly
 * this pair (crosschain-sdk quickSwap.ts: deposit op, then the swap call), so
 * the pattern is what Magi's own swaps run.
 *
 * This module is the PURE half: how much to move, and the invariants that
 * make the pair un-hijackable. It never touches the chain, so it is tested by
 * `pnpm run test:unit` (lib/__tests__/meritum-hive-topup.test.ts). The I/O
 * half is `features/creator-tokens/lib/vsc/broadcaster.ts`
 * (hiveFundedTransactionBroadcaster), which owns the gateway account and
 * re-asserts everything here before a signature is asked for.
 *
 * THE FOUR BINDINGS (each is a test):
 *   1. from  == the account whose ACTIVE key signs the buy (required_auths[0]).
 *   2. to    == the configured gateway account, never a caller value.
 *   3. memo  == `to=<from>`: the deposit can only credit the signer. The node
 *               parses the memo as a query string (ledger_system.go Deposit),
 *               so the name is checked against the node's own account rule
 *               before it is allowed anywhere near a memo.
 *   4. amount == the shortfall, bounded above by the buy's own spend cap plus
 *               the transaction-credit reserve. Never more than this buy can use.
 */

/**
 * The ONE account the node credits deposits for. go-vsc-node checks the
 * literal string (state_engine.go: `op.Value["to"] == "vsc.gateway"`), not a
 * per-network setting, so a transfer to any other account, however well
 * formed, is a plain Hive transfer that never reaches Magi. The broadcaster
 * reads the gateway from configuration and this module refuses anything else.
 */
export const GATEWAY_ACCOUNT = 'vsc.gateway';

/** The node's rule for a Hive name in a deposit memo: HIVE_REGEX and 3..16 chars (ledger_system.go Deposit). */
export const GATEWAY_MEMO_NAME = /^[a-z][a-z0-9.-]{2,15}$/;

/** HBD is a 3-decimal asset; base units are thousandths. */
export const HBD_BASE_UNITS = 1000;

/** Hive's HBD NAI. The node maps this and only this to "hbd" (state_engine.go: amountMap["nai"] == "@@000000013"). */
export const HBD_NAI = '@@000000013';

/** The free transaction-credit allowance a `hive:` account gets (params.go RC_HIVE_FREE_AMOUNT, rc-budget.ts HIVE_FREE_RC_BASE_UNITS). */
export const HIVE_FREE_RC = 10_000;

/** `hive:alice` or `alice` -> `alice`; anything that is not a Hive name (a DID, a bad shape) -> null. */
export function bareHiveName(account: string | null | undefined): string | null {
  if (typeof account !== 'string') return null;
  const name = account.startsWith('hive:') ? account.slice('hive:'.length) : account;
  return GATEWAY_MEMO_NAME.test(name) ? name : null;
}

/** The deposit memo that credits `name` and nobody else. Throws on anything the node would not read as that name. */
export function gatewayDepositMemo(name: string): string {
  const bare = bareHiveName(name);
  if (bare === null) throw new Error(`hive-topup: "${name}" is not a Hive account name; refusing to build a deposit memo for it`);
  return `to=${bare}`;
}

/** Three-decimal HBD string for `baseUnits` (654 -> "0.654"). */
export function hbdString(baseUnits: number): string {
  assertBaseUnits(baseUnits, 'baseUnits');
  const whole = Math.floor(baseUnits / HBD_BASE_UNITS);
  const frac = baseUnits % HBD_BASE_UNITS;
  return `${whole}.${String(frac).padStart(3, '0')}`;
}

export interface TopUpInputs {
  /** The buyer: `alice` or `hive:alice`. */
  signer: string;
  /** cost + fee of THIS buy in base units: the single draw, and the transfer.allow cap. */
  totalDueBaseUnits: number;
  /** Fresh Magi HBD balance in base units. */
  magiHbdBaseUnits: number;
  /** Fresh transaction credits available (getAccountRC.amount). */
  magiRcAvailable: number;
  /** getAccountRC.max_rcs: balance plus the free allowance; the frozen part is max - available. */
  magiRcMax: number;
  /** rc_limit the buy op will carry (rc-budget.ts rcLimitForAction('buy')). */
  rcLimitBaseUnits: number;
  /** Liquid HBD in the Hive wallet, base units; null when the read failed. */
  hiveLiquidHbdBaseUnits: number | null;
}

export type TopUpPlan =
  | { kind: 'not-a-hive-account' }
  | { kind: 'magi-covers' }
  | { kind: 'top-up'; from: string; memo: string; depositBaseUnits: number }
  | { kind: 'short-on-hive'; from: string; depositBaseUnits: number; missingBaseUnits: number }
  | { kind: 'hive-unknown'; from: string; memo: string; depositBaseUnits: number };

/**
 * How much HBD must move from Hive so that the buy executes in the same block.
 *
 * The draw succeeds when `balance' - exclusion >= totalDue`, where
 * `exclusion = max(0, rcLimit - freeRemaining)` and `freeRemaining =
 * HIVE_FREE_RC - frozen` (execution-context.go PullBalance; rc-system.go
 * FreeRcRemaining). The call gets gas `min(available', rcLimit)`, so the
 * credits after the deposit must also reach rcLimit. A deposit raises the
 * balance and the credits 1:1 (RC = balance + free - frozen), hence:
 *
 *   need = max(totalDue + exclusion - balance, rcLimit - available, 0)
 *
 * The result is bounded by totalDue + rcLimit: the buy's own cap plus the
 * credit reserve. Whatever is not drawn stays in the buyer's Magi balance.
 */
export function planHiveTopUp(i: TopUpInputs): TopUpPlan {
  const from = bareHiveName(i.signer);
  if (from === null) return { kind: 'not-a-hive-account' };
  assertBaseUnits(i.totalDueBaseUnits, 'totalDueBaseUnits');
  assertBaseUnits(i.magiHbdBaseUnits, 'magiHbdBaseUnits');
  assertBaseUnits(i.magiRcAvailable, 'magiRcAvailable');
  assertBaseUnits(i.magiRcMax, 'magiRcMax');
  assertBaseUnits(i.rcLimitBaseUnits, 'rcLimitBaseUnits');
  if (i.hiveLiquidHbdBaseUnits !== null) assertBaseUnits(i.hiveLiquidHbdBaseUnits, 'hiveLiquidHbdBaseUnits');

  const frozen = Math.max(0, i.magiRcMax - i.magiRcAvailable);
  const freeRemaining = Math.max(0, HIVE_FREE_RC - frozen);
  const exclusion = Math.max(0, i.rcLimitBaseUnits - freeRemaining);
  const need = Math.max(i.totalDueBaseUnits + exclusion - i.magiHbdBaseUnits, i.rcLimitBaseUnits - i.magiRcAvailable, 0);
  if (need === 0) return { kind: 'magi-covers' };
  const ceiling = i.totalDueBaseUnits + i.rcLimitBaseUnits;
  if (need > ceiling) throw new Error(`hive-topup: computed deposit ${need} exceeds the ceiling ${ceiling}; refusing`);
  const memo = gatewayDepositMemo(from);
  if (i.hiveLiquidHbdBaseUnits === null) return { kind: 'hive-unknown', from, memo, depositBaseUnits: need };
  if (i.hiveLiquidHbdBaseUnits < need) return { kind: 'short-on-hive', from, depositBaseUnits: need, missingBaseUnits: need - i.hiveLiquidHbdBaseUnits };
  return { kind: 'top-up', from, memo, depositBaseUnits: need };
}

/** What the data source hands the broadcaster. Deliberately has NO `to`: the broadcaster owns the gateway account. */
export interface GatewayDepositIntent {
  from: string;
  memo: string;
  amountBaseUnits: number;
}

export function depositIntentOf(plan: TopUpPlan): GatewayDepositIntent | null {
  if (plan.kind !== 'top-up' && plan.kind !== 'hive-unknown') return null;
  return { from: plan.from, memo: plan.memo, amountBaseUnits: plan.depositBaseUnits };
}

/** The subset of a custom_json op the bundle check needs. */
export interface BuyOpShape {
  required_auths: string[];
  required_posting_auths: string[];
  json: string;
}

/** The transfer.allow limit the buy op carries, in base units, or null when it carries none. */
export function spendCapOf(op: BuyOpShape): number | null {
  let body: unknown;
  try {
    body = JSON.parse(op.json);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const intents = (body as { intents?: unknown }).intents;
  if (!Array.isArray(intents)) return null;
  for (const intent of intents) {
    if (typeof intent !== 'object' || intent === null) continue;
    const { type, args } = intent as { type?: unknown; args?: unknown };
    if (type !== 'transfer.allow' || typeof args !== 'object' || args === null) continue;
    const { limit, token, decimals } = args as { limit?: unknown; token?: unknown; decimals?: unknown };
    if (token !== 'hbd' || typeof limit !== 'string' || !/^\d+(\.\d{1,3})?$/.test(limit)) continue;
    if (decimals !== undefined && decimals !== '3') continue;
    return Math.round(Number(limit) * HBD_BASE_UNITS);
  }
  return null;
}

/**
 * Refuse any pair that is not "this signer deposits to the gateway, for
 * themselves, no more than this buy can use". Every clause is a test.
 */
export function assertFundedBundle(deposit: GatewayDepositIntent, op: BuyOpShape, gatewayAccount: string, rcLimitBaseUnits: number): void {
  const gateway = bareHiveName(gatewayAccount);
  if (gateway === null) throw new Error(`hive-topup: gateway account "${gatewayAccount}" is not a Hive account name`);
  if (gateway !== GATEWAY_ACCOUNT) {
    throw new Error(`hive-topup: gateway "${gatewayAccount}" is not ${GATEWAY_ACCOUNT}; the node credits deposits sent to that account only, refusing`);
  }
  if (op.required_posting_auths.length > 0) throw new Error('hive-topup: a funded buy must not carry posting authority');
  if (op.required_auths.length !== 1) throw new Error('hive-topup: a funded buy must carry exactly one active authority');
  const signer = bareHiveName(op.required_auths[0]);
  if (signer === null) throw new Error('hive-topup: the buy is not signed by a Hive account, so nothing can be moved from a Hive wallet');
  if (deposit.from !== signer) throw new Error(`hive-topup: deposit from "${deposit.from}" but the buy is signed by "${signer}"; refusing`);
  if (deposit.from === gateway) throw new Error('hive-topup: the gateway cannot deposit to itself');
  if (deposit.memo !== gatewayDepositMemo(signer)) throw new Error('hive-topup: the deposit memo does not credit the signer; refusing');
  assertBaseUnits(deposit.amountBaseUnits, 'amountBaseUnits');
  if (deposit.amountBaseUnits <= 0) throw new Error('hive-topup: nothing to deposit');
  assertBaseUnits(rcLimitBaseUnits, 'rcLimitBaseUnits');
  const cap = spendCapOf(op);
  if (cap === null) throw new Error('hive-topup: the buy op carries no HBD spend allowance, so a deposit for it has no ceiling; refusing');
  if (deposit.amountBaseUnits > cap + rcLimitBaseUnits) {
    throw new Error(`hive-topup: deposit ${deposit.amountBaseUnits} exceeds this buy's cap ${cap} plus its credit reserve ${rcLimitBaseUnits}; refusing`);
  }
}

function assertBaseUnits(n: number, label: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`hive-topup: ${label} must be a non-negative integer of base units, got ${String(n)}`);
  }
}

/** The rc_limit the buy op carries (op-builders.ts body.rc_limit), or null when unreadable. */
export function rcLimitOf(op: BuyOpShape): number | null {
  try {
    const body: unknown = JSON.parse(op.json);
    if (typeof body !== 'object' || body === null) return null;
    const v = (body as { rc_limit?: unknown }).rc_limit;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}
