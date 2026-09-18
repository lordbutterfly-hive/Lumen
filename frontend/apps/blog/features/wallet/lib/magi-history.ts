import Big from 'big.js';
import type { MagiTransaction, MagiTransactionOp } from '@/blog/lib/lite/wallet/magi-transactions';
import type { HistoryCategory } from './history-groups';
import type { HistoryTone } from './account-history';

/**
 * Turning one Magi transaction into the rows the wallet's Magi tab shows.
 *
 * ★ PURE, AND NO CHAIN IMPORTS. Everything here is arithmetic on the node's own
 * JSON, so the same function runs in the browser and in
 * `lib/__tests__/wallet-magi-history.test.ts` under a plain ts-node.
 *
 * ★ THE ROW IS AN OPERATION, NOT A TRANSACTION (Altera's rule,
 * transactions/Table/Table.svelte: "Always iterate the full `ops` array so every
 * operation in a transaction renders as its own row"). One Magi transaction can
 * carry a deposit AND the contract call it funds; collapsing that to one row
 * hides half of what moved.
 *
 * ★ AMOUNTS: TWO WIRE FORMATS, MEASURED. `data.amount` is a decimal STRING for
 * `transfer` / `withdraw` / `stake_hbd` ("11.000") and an INTEGER IN BASE UNITS
 * for `deposit` (175 = 0.175 HBD). Getting this wrong prints a deposit a
 * thousand times too large. See magi-transactions.ts for where this was
 * measured.
 */

export type MagiHistoryGroup = 'all' | 'transfers' | 'staking' | 'contracts';

export const MAGI_HISTORY_GROUPS = ['all', 'transfers', 'staking', 'contracts'] as const;

/**
 * Op types per tab, as the node's own `byType` filter spells them (verified
 * live, 2026-09-18: `byType: ["stake_hbd"]` returns only stake_hbd rows). `all`
 * is empty, meaning "send no filter" — never a hand-maintained union that would
 * silently drop an op type the chain adds later.
 */
export const MAGI_GROUP_OP_TYPES: Record<MagiHistoryGroup, readonly string[]> = {
  all: [],
  transfers: ['transfer', 'deposit', 'withdraw'],
  staking: ['stake_hbd', 'unstake_hbd', 'consensus_stake', 'consensus_unstake', 'stake', 'unstake'],
  contracts: ['call', 'call_contract']
};

export function parseMagiHistoryGroup(raw: unknown): MagiHistoryGroup | null {
  return typeof raw === 'string' && (MAGI_HISTORY_GROUPS as readonly string[]).includes(raw)
    ? (raw as MagiHistoryGroup)
    : null;
}

export interface MagiHistoryCounterparty {
  /** Display form: `@name` for a Hive account, a shortened address otherwise. */
  label: string;
  direction: 'to' | 'from';
  /** Lumen profile, when the counterparty is a Hive account. */
  href: string | null;
}

export interface MagiHistoryEntry {
  key: string;
  txId: string;
  /** ISO-8601 with a zone marker. */
  timestamp: string;
  labelKey: string;
  labelParams?: Record<string, string>;
  category: HistoryCategory;
  tone: HistoryTone;
  counterparty: MagiHistoryCounterparty | null;
  amountText: string | null;
  memo: string | null;
  status: 'confirmed' | 'pending' | 'failed';
}

const ASSET_DECIMALS: Record<string, number> = { hbd: 3, hive: 3, btc: 8, sats: 0 };

/** `hbd_savings` -> `hbd`; `HIVE` -> `hive`. */
function assetKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .split('_')[0];
}

function assetSymbol(raw: unknown): string {
  const key = assetKey(raw);
  if (!key) return '';
  return key === 'sats' ? 'sats' : key.toUpperCase();
}

/**
 * The wallet groups thousands with commas everywhere (`numberWithCommas`), and
 * this list sits under balances that do. Done here with a regex rather than
 * `Intl.NumberFormat` so the two never disagree in a locale whose separator
 * differs — and so this file keeps no dependency on the UI package.
 */
function withCommas(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * One amount, as text with its unit. Returns null when the value is missing or
 * unreadable — never "0", which on a money list is a claim.
 *
 * `preShifted` follows Altera's own fork: a NUMBER is in base units, a STRING
 * with a decimal point is already in whole units.
 */
export function formatMagiAmount(rawAmount: unknown, rawAsset: unknown): string | null {
  const key = assetKey(rawAsset);
  const decimals = ASSET_DECIMALS[key];
  if (decimals === undefined) return null;
  let big: Big;
  try {
    if (typeof rawAmount === 'number') {
      if (!Number.isFinite(rawAmount)) return null;
      big = new Big(rawAmount).div(new Big(10).pow(decimals));
    } else if (typeof rawAmount === 'string' && rawAmount.length > 0) {
      big = rawAmount.includes('.') ? new Big(rawAmount) : new Big(rawAmount).div(new Big(10).pow(decimals));
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const symbol = assetSymbol(rawAsset);
  const text = withCommas(big.abs().toFixed(decimals));
  return symbol ? `${text} ${symbol}` : text;
}

/** Base-unit ledger amounts always take the integer path. */
function formatLedgerAmount(amount: number, asset: string): string | null {
  return formatMagiAmount(amount, asset);
}

/** `hive:alice` -> `@alice`; `did:pkh:eip155:1:0xabc…` -> `0xabc…def`; `contract:vsc1…` -> `vsc1…`. */
export function displayMagiAccount(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('hive:')) return `@${raw.slice(5)}`;
  if (raw.startsWith('contract:')) return shortenMiddle(raw.slice(9));
  const address = raw.startsWith('did:pkh:') ? raw.split(':').pop() ?? raw : raw;
  return shortenMiddle(address);
}

function shortenMiddle(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function counterpartyFor(other: string, direction: 'to' | 'from'): MagiHistoryCounterparty | null {
  if (!other) return null;
  return {
    label: displayMagiAccount(other),
    direction,
    href: other.startsWith('hive:') ? `/@${other.slice(5)}` : null
  };
}

/**
 * A memo minus Altera's own correlation id. Altera writes `altera_id=<uuid>`
 * into the memo of everything it broadcasts and strips it back out before
 * display (transactions/Table/tr/Tr.svelte `memoNoId`); showing it here would
 * put another app's plumbing in a Lumen reader's ledger.
 */
export function cleanMagiMemo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!/(^|&)altera_id=/.test(raw)) return raw;
  try {
    const params = new URLSearchParams(raw);
    params.delete('altera_id');
    const rest = params.toString();
    return rest.length > 0 ? rest : null;
  } catch {
    return raw;
  }
}

function statusOf(tx: MagiTransaction): MagiHistoryEntry['status'] {
  if (tx.status === 'FAILED') return 'failed';
  if (tx.status === 'CONFIRMED') return 'confirmed';
  return 'pending';
}

/**
 * What a contract call moved, from the transaction's ledger: the legs between
 * this account and a contract. A swap's ledger also carries pool-internal legs
 * and the protocol fee to `pendulum:nodes`; those are not this account's money
 * moving, so they are not summed here.
 */
function contractCallAmount(tx: MagiTransaction, account: string): { text: string | null; tone: HistoryTone } {
  const paid = new Map<string, Big>();
  const received = new Map<string, Big>();
  for (const entry of tx.ledger) {
    const isContract = (value: string) => value.startsWith('contract:');
    if (entry.from === account && isContract(entry.to)) {
      add(paid, entry.asset, entry.amount);
    } else if (entry.to === account && isContract(entry.from)) {
      add(received, entry.asset, entry.amount);
    }
  }
  if (paid.size > 0) return { text: joinAmounts(paid), tone: 'debit' };
  if (received.size > 0) return { text: joinAmounts(received), tone: 'credit' };
  return { text: null, tone: 'neutral' };
}

function add(into: Map<string, Big>, asset: string, amount: number): void {
  const key = assetKey(asset);
  const current = into.get(key) ?? new Big(0);
  into.set(key, current.plus(amount));
}

function joinAmounts(sums: Map<string, Big>): string | null {
  const parts: string[] = [];
  for (const [asset, total] of sums) {
    const text = formatLedgerAmount(Number(total.toString()), asset);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

const LABEL_PREFIX = 'wallet.magi.history.types.';

/**
 * Contract id -> the name this app knows it by. Built by the caller from the
 * SAME env the rest of the feature is configured with, so a row can read
 * "Meritum: buy" instead of "Contract call: buy (vsc1Bisg…ZARt)" — the reader
 * has no way to know that id is the creator-token contract they just bought on,
 * and this app is the one place that does know.
 */
export type MagiContractNames = Readonly<Record<string, string>>;

/**
 * Describe one operation. `account` is the ledger account id whose wallet this
 * is (`hive:<name>` or a `did:pkh:…`), so "in" and "out" are relative to the
 * reader, exactly as on the Hive tab.
 */
export function describeMagiOperation(
  tx: MagiTransaction,
  op: MagiTransactionOp,
  account: string,
  contractNames: MagiContractNames = {}
): MagiHistoryEntry {
  const data = op.data;
  const from = typeof data.from === 'string' ? data.from : '';
  const to = typeof data.to === 'string' ? data.to : '';
  const amountText = formatMagiAmount(data.amount, data.asset);
  const status = statusOf(tx);
  const base = {
    key: `${tx.id}-${op.index}`,
    txId: tx.id,
    timestamp: tx.timestamp,
    memo: cleanMagiMemo(data.memo),
    status
  };
  /** A failed transaction moved nothing, so it never carries a + or a − sign. */
  const toneFor = (tone: HistoryTone): HistoryTone => (status === 'failed' ? 'neutral' : tone);

  switch (op.type) {
    case 'transfer': {
      const incoming = to === account && from !== account;
      const outgoing = from === account && to !== account;
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}${incoming ? 'transfer_received' : 'transfer_sent'}`,
        category: incoming ? 'in' : 'out',
        tone: toneFor(incoming ? 'credit' : outgoing ? 'debit' : 'neutral'),
        counterparty: incoming ? counterpartyFor(from, 'from') : counterpartyFor(to, 'to'),
        amountText
      };
    }
    case 'deposit': {
      // Hive L1 -> Magi. `to` is the Magi account being credited, which is not
      // always the reader (someone can fund another account).
      const incoming = to === account || to === '';
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}deposit`,
        category: incoming ? 'in' : 'out',
        tone: toneFor(incoming ? 'credit' : 'debit'),
        counterparty: incoming ? null : counterpartyFor(to, 'to'),
        amountText
      };
    }
    case 'withdraw': {
      // Magi -> Hive L1. Always leaves this account's Magi balance.
      //
      // ★ TWO LABELS, BECAUSE ONE OF THEM HAS A COUNTERPARTY. "Withdrew to
      // Hive" is right when the money lands back in the reader's own L1
      // account; with a different recipient the row would have read "Withdrew
      // to Hive to @someone", so that case says "Withdrew from Magi" and lets
      // the counterparty supply the "to".
      const other = to && to !== account ? counterpartyFor(to, 'to') : null;
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}${other ? 'withdraw_to' : 'withdraw'}`,
        category: 'out',
        tone: toneFor('debit'),
        counterparty: other,
        amountText
      };
    }
    case 'stake_hbd':
    case 'stake':
    case 'consensus_stake': {
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}${op.type === 'consensus_stake' ? 'consensus_stake' : 'stake'}`,
        category: 'power',
        tone: 'neutral',
        counterparty: to && to !== account ? counterpartyFor(to, 'to') : null,
        amountText
      };
    }
    case 'unstake_hbd':
    case 'unstake':
    case 'consensus_unstake': {
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}${op.type === 'consensus_unstake' ? 'consensus_unstake' : 'unstake'}`,
        category: 'power',
        tone: 'neutral',
        counterparty: null,
        amountText
      };
    }
    case 'call':
    case 'call_contract': {
      const action = typeof data.action === 'string' && data.action.length > 0 ? data.action : '';
      const contractId = typeof data.contract_id === 'string' ? data.contract_id : '';
      const known = contractNames[contractId];
      const moved = contractCallAmount(tx, account);
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}${known ? (action ? 'contract_action_known' : 'contract_call_known') : action ? 'contract_action' : 'contract_call'}`,
        labelParams: {
          ...(action ? { action } : {}),
          contract: known ?? shortenMiddle(contractId)
        },
        category: 'market',
        tone: toneFor(moved.tone),
        counterparty: null,
        amountText: moved.text
      };
    }
    default: {
      // An op type this wallet has never seen. Say what the chain called it
      // rather than dropping the row: a hidden movement is worse than an
      // unfamiliar name.
      return {
        ...base,
        labelKey: `${LABEL_PREFIX}other`,
        labelParams: { type: (op.type || 'operation').replace(/_/g, ' ') },
        category: 'other',
        tone: 'neutral',
        counterparty: null,
        amountText
      };
    }
  }
}

/**
 * Every row one transaction contributes, filtered to the active tab.
 *
 * ★ THE TAB FILTER IS APPLIED PER OP, not per transaction. The node's `byType`
 * matches a transaction if ANY of its operations matches, so a deposit that
 * funds a contract call comes back on the Transfers tab carrying its `call`
 * operation too — and rendering that call under "Transfers" would be a lie
 * about what the filter did.
 */
export function describeMagiTransaction(
  tx: MagiTransaction,
  account: string,
  group: MagiHistoryGroup = 'all',
  contractNames: MagiContractNames = {}
): MagiHistoryEntry[] {
  const wanted = MAGI_GROUP_OP_TYPES[group];
  return tx.ops
    .filter((op) => wanted.length === 0 || wanted.includes(op.type))
    .sort((a, b) => a.index - b.index)
    .map((op) => describeMagiOperation(tx, op, account, contractNames));
}

/**
 * The Magi explorer's page for a transaction, so every row has a verifiable
 * record behind it. Testnet-aware from the SAME net id the rest of the feature
 * is configured with (Altera does the same switch in src/lib/constants.ts) —
 * never a hardcoded mainnet host that would send a testnet reader to a page
 * that cannot show their transaction.
 */
export function magiExplorerTxUrl(txId: string, netId: string | null | undefined): string | null {
  if (!txId) return null;
  const testnet = typeof netId === 'string' && netId.startsWith('testnet');
  return `https://${testnet ? 'magi-test' : 'vsc'}.techcoderx.com/tx/${encodeURIComponent(txId)}`;
}
