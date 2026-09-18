/**
 * One Magi account's transaction history, read through the same-origin proxy.
 *
 * ★ WHY THIS EXISTS (owner, 2026-09-18: "the magi tab lacks any transactions
 * from magi. take that from altera"). The wallet's Magi tab showed balances and
 * nothing else — a reader could see 12.655 HBD on Magi and had no way to find
 * out where it came from, on the tab that is the whole point of holding money
 * there. Altera has shown this list since its first release
 * (altera-app/src/routes/(authed)/transactions): `findTransaction` on the node's
 * own GraphQL API, filtered `byAccount`, paged by `offset`. Same query here.
 *
 * ★ THE SHAPES BELOW ARE MEASURED, NOT INFERRED (against the live mainnet node
 * vsc.techcoderx.com, 2026-09-18):
 *  - `ops[].data.amount` is a STRING with decimals ("11.000", "0.226") for
 *    `transfer` / `withdraw` / `stake_hbd`, and an INTEGER IN BASE UNITS (175 =
 *    0.175 HBD) for `deposit`. Altera's own row hits the same fork
 *    (`typeof data.amount == 'number'` ⇒ pre-shifted); a formatter that assumes
 *    one form silently prints a deposit 1000x too large.
 *  - `ledger[].amount` is always base units.
 *  - `anchr_ts` has NO timezone marker and `first_seen` does. Both are UTC.
 *  - op types in the wild: `call`, `deposit`, `withdraw`, `transfer`,
 *    `stake_hbd` (and its `unstake_hbd` / `consensus_*` siblings).
 *  - `status` is CONFIRMED | INCLUDED | UNCONFIRMED | FAILED.
 *
 * ★ A FAILED READ IS NOT AN EMPTY HISTORY (the rule every Magi read in this app
 * follows, magi-balance.ts:26-29). Everything here throws rather than resolving
 * to [].
 */

/**
 * ★ EXPORTED so the same-origin proxy can allowlist it by exact string —
 * `app/api/creator-tokens/gql/route.ts` imports this by identity, the same
 * single-source-of-truth arrangement it has with every other query constant, so
 * the proxy and this caller can never drift.
 *
 * `byType` is nullable on purpose: the tab bar passes a list of op types for a
 * filtered tab and null for "All", and the node treats a null filter as
 * unfiltered (verified live). One query string, four tabs — an allowlist keyed
 * on exact text cannot afford a query per tab.
 */
export const MAGI_TRANSACTIONS_QUERY = `query MagiAccountTransactions($account: String!, $limit: Int!, $offset: Int!, $byType: [String!]) {
  findTransaction(filterOptions: { byAccount: $account, limit: $limit, offset: $offset, byType: $byType }) {
    id
    anchr_height
    anchr_ts
    first_seen
    status
    type
    ledger { amount asset from memo to type }
    ops { data index type }
  }
}`;

export type MagiTransactionStatus = 'CONFIRMED' | 'INCLUDED' | 'UNCONFIRMED' | 'FAILED';

export interface MagiLedgerEvent {
  /** Base units (3 decimals for HBD/HIVE). Can be negative. */
  amount: number;
  /** e.g. `hbd`, `hive`, `hbd_savings`. */
  asset: string;
  from: string;
  to: string;
  type: string;
  memo: string | null;
}

export interface MagiTransactionOp {
  index: number;
  type: string;
  /** Raw payload; the shape depends on `type` (see this file's header). */
  data: Record<string, unknown>;
}

export interface MagiTransaction {
  id: string;
  /** Hive L1 block this was anchored in. 0 when it has not been anchored yet. */
  anchorHeight: number;
  /** ISO-8601 WITH a zone marker — normalised here, never at the edge. */
  timestamp: string;
  status: MagiTransactionStatus;
  /** Where the transaction came from: `hive` (an L1 custom_json) or `vsc`. */
  origin: string;
  ledger: MagiLedgerEvent[];
  ops: MagiTransactionOp[];
}

/** Same-origin proxy every Magi read goes through; the node is never dialled from the browser. */
const CREATOR_TOKENS_GQL_PROXY_PATH = '/api/creator-tokens/gql';

/** The node's own ceiling is 100; a wallet page never needs a page that big. */
export const MAGI_TRANSACTIONS_PAGE_SIZE = 12;
/** Offset paging cannot run forever; past this the reader belongs on the explorer. */
export const MAGI_TRANSACTIONS_MAX_OFFSET = 600;

function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Hive and Magi both send `2026-09-16T18:12:18` with no zone marker for
 * `anchr_ts`, and per the ECMAScript spec a string in that shape is parsed as
 * LOCAL time — which on a ledger can move a transaction to the wrong calendar
 * day. `first_seen` already carries its `Z`. Altera normalises the same way
 * (txStores.ts `getTimestamp`).
 */
export function normalizeMagiTimestamp(anchorTs: unknown, firstSeen: unknown): string {
  const raw = asString(anchorTs) || asString(firstSeen);
  if (!raw) return '';
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
}

const STATUSES: readonly string[] = ['CONFIRMED', 'INCLUDED', 'UNCONFIRMED', 'FAILED'];

/** Parse the node's `{data}` envelope. Exported so a test can drive it without a network. */
export function parseMagiTransactions(json: unknown): MagiTransaction[] {
  const errors = prop(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const first = prop(errors[0], 'message');
    throw new Error(`Magi transactions read: ${typeof first === 'string' ? first : 'GraphQL error'}`);
  }
  const list = prop(prop(json, 'data'), 'findTransaction');
  // `findTransaction` is nullable in the schema; null means "no rows", and the
  // caller can tell that from a throw because this only ever returns for a
  // response the node actually answered.
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('Magi transactions read: findTransaction was not a list');

  const out: MagiTransaction[] = [];
  for (const raw of list) {
    const id = asString(prop(raw, 'id'));
    if (!id) continue;
    const statusRaw = asString(prop(raw, 'status'));
    const ledgerRaw = prop(raw, 'ledger');
    const opsRaw = prop(raw, 'ops');
    out.push({
      id,
      anchorHeight: asNumber(prop(raw, 'anchr_height')),
      timestamp: normalizeMagiTimestamp(prop(raw, 'anchr_ts'), prop(raw, 'first_seen')),
      status: (STATUSES.includes(statusRaw) ? statusRaw : 'UNCONFIRMED') as MagiTransactionStatus,
      origin: asString(prop(raw, 'type')),
      ledger: Array.isArray(ledgerRaw)
        ? ledgerRaw
            .filter((entry) => entry !== null && entry !== undefined)
            .map((entry) => ({
              amount: asNumber(prop(entry, 'amount')),
              asset: asString(prop(entry, 'asset')),
              from: asString(prop(entry, 'from')),
              to: asString(prop(entry, 'to')),
              type: asString(prop(entry, 'type')),
              memo: typeof prop(entry, 'memo') === 'string' && asString(prop(entry, 'memo')).length > 0 ? asString(prop(entry, 'memo')) : null
            }))
        : [],
      ops: Array.isArray(opsRaw)
        ? opsRaw
            .filter((op) => op !== null && op !== undefined)
            .map((op) => ({
              index: asNumber(prop(op, 'index')),
              type: asString(prop(op, 'type')),
              data: (typeof prop(op, 'data') === 'object' && prop(op, 'data') !== null
                ? (prop(op, 'data') as Record<string, unknown>)
                : {})
            }))
        : []
    });
  }
  return out;
}

export interface ReadMagiTransactionsOptions {
  limit?: number;
  offset?: number;
  /** Op types to ask the node for; omit or empty for every type. */
  types?: readonly string[];
}

/**
 * Read one page of an account's Magi transactions. `account` must already be a
 * ledger account id (`hive:<name>` or a `did:pkh:…`) — `toMagiAccountId` in
 * magi-assets.ts is the one place that normalisation happens.
 */
export async function readMagiTransactions(
  account: string,
  { limit = MAGI_TRANSACTIONS_PAGE_SIZE, offset = 0, types }: ReadMagiTransactionsOptions = {}
): Promise<MagiTransaction[]> {
  if (!account) throw new Error('Magi transactions read: no account given');
  const res = await fetch(CREATOR_TOKENS_GQL_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: MAGI_TRANSACTIONS_QUERY,
      variables: {
        account,
        limit,
        offset,
        byType: types && types.length > 0 ? [...types] : null
      }
    }),
    cache: 'no-store'
  });
  if (res.status === 429) throw new Error('Magi transactions read: rate limited, try again in a moment');
  if (!res.ok) throw new Error(`Magi transactions read: HTTP ${res.status}`);
  return parseMagiTransactions(await res.json());
}
