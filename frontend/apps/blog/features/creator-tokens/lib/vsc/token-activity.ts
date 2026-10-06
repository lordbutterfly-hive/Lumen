import type { HistoryCategory } from '../../../wallet/lib/history-groups';

/**
 * Meritum token activity: who sent what, how much of it, to whom.
 *
 * Read from the Magi indexer's own event tables (creator_tokens_mappings.yaml),
 * the same Hasura instance the holders list, the chart and the delivery record
 * already read. Every token movement the contract makes is one of these ten
 * logs, and the balances view is literally their sum, so a list built from them
 * cannot disagree with the holders list above it.
 *
 * ★ PURE, AND NO CHAIN IMPORTS (type-only imports are erased). The query text,
 * the parsing, the paging arithmetic and the wording all live here so
 * `lib/__tests__/meritum-token-activity.test.ts` can drive them under plain
 * ts-node, the same split as features/wallet/lib/magi-history.ts.
 *
 * ★ AMOUNTS ARE STRINGS, FORMATTED WITHOUT FLOATS. A token amount is a decimal
 * token string ("8.58"; whole "2" before v6), an HBD amount is a base-unit
 * integer string ("9991" = 9.991 HBD). Both are formatted by string arithmetic,
 * and a token amount with more than two places is cut, never rounded up: a
 * ledger may show less precision, never more money.
 *
 * ★ PAGING IS A K-WAY MERGE WITH ONE CURSOR PER TABLE. Ten tables, one list.
 * Each page asks every table for its next `limit` rows after that table's own
 * cursor, merges them, keeps the newest `limit`, and moves each table's cursor
 * only past the rows it actually contributed. Rows a table returned but that
 * did not make the page are asked for again next time, so nothing is skipped
 * and nothing repeats, whatever the tables' relative volumes.
 */

export type TokenActivityGroup = 'all' | 'transfers' | 'trades' | 'orders';
export const TOKEN_ACTIVITY_GROUPS = ['all', 'transfers', 'trades', 'orders'] as const;

export type TokenActivitySource =
  | 'bought'
  | 'sold'
  | 'transferred'
  | 'matured'
  | 'asked'
  | 'answered'
  | 'declined'
  | 'reclaimed'
  | 'refunded'
  | 'pushed';

/**
 * Table and money columns per event. ONLY columns present on the live mainnet
 * Hasura (introspected 2026-10-06): the 2026-09-12 commission columns
 * (`commission_credits`, `commission_to`, `retained_to`) are in the YAML but
 * NOT on the deployed tables, and selecting a missing column fails the whole
 * query.
 */
const SOURCES: Record<TokenActivitySource, { table: string; columns: readonly string[] }> = {
  bought: { table: 'lumen_ct_bought_events', columns: ['creator', 'actor', 'minted', 'total_due'] },
  sold: { table: 'lumen_ct_sold_events', columns: ['creator', 'actor', 'sold', 'net'] },
  transferred: { table: 'lumen_ct_transferred_events', columns: ['creator', 'actor', 'recipient', 'amount'] },
  matured: { table: 'lumen_ct_matured_moved_events', columns: ['creator', 'sender', 'recipient', 'amount'] },
  asked: { table: 'lumen_ct_asked_events', columns: ['creator', 'actor', 'credits_spent'] },
  answered: { table: 'lumen_ct_answered_events', columns: ['creator', 'credits_to_creator'] },
  declined: { table: 'lumen_ct_declined_events', columns: ['creator', 'asker', 'credits'] },
  reclaimed: { table: 'lumen_ct_reclaimed_events', columns: ['creator', 'asker', 'credits'] },
  refunded: { table: 'lumen_ct_refunded_events', columns: ['creator', 'actor', 'credits', 'payout'] },
  pushed: { table: 'lumen_ct_refund_pushed_events', columns: ['creator', 'holder', 'credits_burned', 'payout'] }
};

const INDEXER_COLUMNS = ['indexer_id', 'indexer_block_height', 'indexer_ts', 'indexer_tx_hash'] as const;

/** Fixed order; also the tie-break between tables inside one block. */
export const ALL_SOURCES: readonly TokenActivitySource[] = [
  'bought',
  'sold',
  'transferred',
  'matured',
  'asked',
  'answered',
  'declined',
  'reclaimed',
  'refunded',
  'pushed'
];

/** Which tables each tab reads. The tabs are server-side filters, as on the Hive tab: a tab never hides rows out of a mixed page. */
export const GROUP_SOURCES: Record<TokenActivityGroup, readonly TokenActivitySource[]> = {
  all: ALL_SOURCES,
  transfers: ['transferred', 'matured'],
  trades: ['bought', 'sold', 'refunded', 'pushed'],
  orders: ['asked', 'answered', 'declined', 'reclaimed']
};

export function parseTokenActivityGroup(raw: unknown): TokenActivityGroup | null {
  return typeof raw === 'string' && (TOKEN_ACTIVITY_GROUPS as readonly string[]).includes(raw) ? (raw as TokenActivityGroup) : null;
}

/**
 * Whose activity. Both ids are LEDGER ids (`hive:<name>` or a `did:pkh:…`), the
 * form the contract writes into every log.
 *  - `token`: every movement of one creator's token (the /m/<handle> page).
 *  - `account`: every movement of any token where this account gained or lost
 *    tokens (the wallet's Meritum tab).
 */
export type TokenActivityScope = { kind: 'token'; creator: string } | { kind: 'account'; account: string };

export type SourceCursor = { block: number; id: number } | 'done';
/** A missing key means "from the newest row"; `done` means that table has nothing older. */
export type TokenActivityCursor = Partial<Record<TokenActivitySource, SourceCursor>>;

export const TOKEN_ACTIVITY_PAGE_SIZE = 12;

export interface TokenActivityEvent {
  source: TokenActivitySource;
  /** The indexer's per-table row id: unique within a table, and the tie-break inside a block. */
  id: number;
  block: number;
  /** ISO-8601 WITH a zone marker (the indexer writes UTC with none). */
  timestamp: string;
  /** The Magi transaction that emitted the log. */
  txId: string;
  creator: string;
  /** Where the tokens came from; '' when they came from the market (a buy) or an escrow. */
  from: string;
  /** Where the tokens went; '' when they left circulation (a sale, a cash-out). */
  to: string;
  /** Decimal token string as the contract wrote it. */
  tokens: string;
  /** HBD in base units: paid for a buy, received for a sale or a cash-out. */
  hbd: string | null;
}

export interface TokenActivityPage {
  events: TokenActivityEvent[];
  /** Null when every table is exhausted: the list has ended. */
  next: TokenActivityCursor | null;
}

// ───────────────────────────── the query ─────────────────────────────

type Where = Record<string, unknown>;

const eq = (value: string) => ({ _eq: value });

function scopeWhere(source: TokenActivitySource, scope: TokenActivityScope): Where {
  if (scope.kind === 'token') return { creator: eq(scope.creator) };
  const a = scope.account;
  switch (source) {
    case 'bought':
    case 'sold':
    case 'asked':
    case 'refunded':
      return { actor: eq(a) };
    case 'transferred':
      return { _or: [{ actor: eq(a) }, { recipient: eq(a) }] };
    case 'matured':
      return { _or: [{ sender: eq(a) }, { recipient: eq(a) }] };
    case 'answered':
      // The escrow is paid to the CREATOR. The asker already saw these tokens
      // leave when they ordered, so the asker side has no row here.
      return { creator: eq(a) };
    case 'declined':
    case 'reclaimed':
      // Paid back to the escrow's own ASKER, never to `actor` (a reclaim is
      // permissionless; the balances view makes the same distinction).
      return { asker: eq(a) };
    case 'pushed':
      return { holder: eq(a) };
  }
}

function cursorWhere(cursor: { block: number; id: number }): Where {
  return {
    _or: [
      { indexer_block_height: { _lt: cursor.block } },
      { indexer_block_height: { _eq: cursor.block }, indexer_id: { _lt: cursor.id } }
    ]
  };
}

/** The tables a page still has to ask, given the tab and the cursor. */
export function activeSources(group: TokenActivityGroup, cursor: TokenActivityCursor | null): TokenActivitySource[] {
  return GROUP_SOURCES[group].filter((source) => cursor?.[source] !== 'done');
}

/**
 * One GraphQL document for one page: an aliased root field per table still in
 * play, each with its own `where` passed as a VARIABLE (Hasura validates the
 * variables against the document and rejects undeclared ones, so the document
 * declares exactly the tables it reads).
 */
export function buildTokenActivityQuery(
  scope: TokenActivityScope,
  group: TokenActivityGroup,
  cursor: TokenActivityCursor | null,
  limit: number,
  contractId: string | null
): { query: string; variables: Record<string, unknown>; sources: TokenActivitySource[] } {
  const sources = activeSources(group, cursor);
  const declarations: string[] = ['$limit: Int!'];
  const fields: string[] = [];
  const variables: Record<string, unknown> = { limit };
  for (const source of sources) {
    const { table, columns } = SOURCES[source];
    const name = `w_${source}`;
    declarations.push(`$${name}: ${table}_bool_exp!`);
    const and: Where[] = [scopeWhere(source, scope)];
    // Scoped to OUR contract: the raw event tables carry the indexer's own
    // contract column (unlike the views, see hasura.ts), so another
    // deployment's rows can never leak in.
    if (contractId) and.push({ indexer_contract_id: eq(contractId) });
    // A holder-to-holder move only. Graduations ('' -> holder) and matured
    // burns (holder -> '') are already a buy or a sale row; the balances view
    // excludes them for the same reason.
    if (source === 'matured') and.push({ sender: { _neq: '' } }, { recipient: { _neq: '' } });
    const c = cursor?.[source];
    if (c && c !== 'done') and.push(cursorWhere(c));
    variables[name] = { _and: and };
    fields.push(
      `${source}: ${table}(where: $${name}, order_by: [{indexer_block_height: desc}, {indexer_id: desc}], limit: $limit) { ${[...columns, ...INDEXER_COLUMNS].join(' ')} }`
    );
  }
  const query = `query MeritumTokenActivity(${declarations.join(', ')}) {\n  ${fields.join('\n  ')}\n}`;
  return { query, variables, sources };
}

// ───────────────────────────── parsing ─────────────────────────────

function field(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[key] : undefined;
}

function str(row: unknown, key: string): string {
  const v = field(row, key);
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function int(row: unknown, key: string): number | null {
  const v = field(row, key);
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.length > 0 ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** The indexer writes `2026-10-05T17:10:51` (UTC, no zone). Without a marker, a browser reads it as LOCAL time. */
export function normalizeIndexerTimestamp(raw: string): string {
  if (!raw) return '';
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
}

/** One table row -> one event, with `from`/`to` meaning where the TOKENS went. Null for a row missing what makes it a row. */
export function eventFromRow(source: TokenActivitySource, row: unknown): TokenActivityEvent | null {
  const id = int(row, 'indexer_id');
  const block = int(row, 'indexer_block_height');
  if (id === null || block === null) return null;
  const base = {
    source,
    id,
    block,
    timestamp: normalizeIndexerTimestamp(str(row, 'indexer_ts')),
    txId: str(row, 'indexer_tx_hash'),
    creator: str(row, 'creator')
  };
  switch (source) {
    case 'bought':
      return { ...base, from: '', to: str(row, 'actor'), tokens: str(row, 'minted'), hbd: str(row, 'total_due') || null };
    case 'sold':
      return { ...base, from: str(row, 'actor'), to: '', tokens: str(row, 'sold'), hbd: str(row, 'net') || null };
    case 'transferred':
      return { ...base, from: str(row, 'actor'), to: str(row, 'recipient'), tokens: str(row, 'amount'), hbd: null };
    case 'matured':
      return { ...base, from: str(row, 'sender'), to: str(row, 'recipient'), tokens: str(row, 'amount'), hbd: null };
    case 'asked':
      // Into escrow WITH the creator; the creator is only paid on delivery.
      return { ...base, from: str(row, 'actor'), to: base.creator, tokens: str(row, 'credits_spent'), hbd: null };
    case 'answered':
      return { ...base, from: '', to: base.creator, tokens: str(row, 'credits_to_creator'), hbd: null };
    case 'declined':
      // `from` names who declined: the creator, whose order it was.
      return { ...base, from: base.creator, to: str(row, 'asker'), tokens: str(row, 'credits'), hbd: null };
    case 'reclaimed':
      return { ...base, from: '', to: str(row, 'asker'), tokens: str(row, 'credits'), hbd: null };
    case 'refunded':
      return { ...base, from: str(row, 'actor'), to: '', tokens: str(row, 'credits'), hbd: str(row, 'payout') || null };
    case 'pushed':
      return { ...base, from: str(row, 'holder'), to: '', tokens: str(row, 'credits_burned'), hbd: str(row, 'payout') || null };
  }
}

/** Hasura's `{data}` -> rows per table. Throws on a GraphQL error: a failed read is never an empty history. */
export function parseTokenActivityResponse(
  json: unknown,
  sources: readonly TokenActivitySource[]
): Partial<Record<TokenActivitySource, TokenActivityEvent[]>> {
  const errors = field(json, 'errors');
  if (Array.isArray(errors) && errors.length > 0) {
    const message = field(errors[0], 'message');
    throw new Error(`Meritum activity read: ${typeof message === 'string' ? message : 'GraphQL error'}`);
  }
  const data = field(json, 'data');
  if (typeof data !== 'object' || data === null) throw new Error('Meritum activity read: no data in the reply');
  const out: Partial<Record<TokenActivitySource, TokenActivityEvent[]>> = {};
  for (const source of sources) {
    const rows = field(data, source);
    // A table missing from an answered reply is a broken reply, not an empty
    // table: treating it as empty would end that table's history early.
    if (!Array.isArray(rows)) throw new Error(`Meritum activity read: ${source} missing from the reply`);
    out[source] = rows.map((row) => eventFromRow(source, row)).filter((e): e is TokenActivityEvent => e !== null);
  }
  return out;
}

// ───────────────────────────── paging ─────────────────────────────

const RANK: Record<TokenActivitySource, number> = Object.fromEntries(ALL_SOURCES.map((s, i) => [s, i])) as Record<TokenActivitySource, number>;

/**
 * Newest first: block, then a fixed table order, then the table's own id.
 * Restricted to one table this is exactly that table's query order (block
 * desc, id desc), which is what makes the per-table cursors sound.
 */
export function compareActivityEvents(a: TokenActivityEvent, b: TokenActivityEvent): number {
  if (a.block !== b.block) return b.block - a.block;
  if (a.source !== b.source) return RANK[a.source] - RANK[b.source];
  return b.id - a.id;
}

/**
 * Merge one round of per-table reads into a page.
 *
 * `fetched[s]` must be table `s`'s next rows after `cursor[s]`, newest first, at
 * most `limit` of them. The page is the newest `limit` of their union, which is
 * the newest `limit` of everything left: a table that returned a full `limit`
 * cannot hide an unread row that beats all `limit` of its own returned rows.
 */
export function mergeTokenActivityPage(
  fetched: Partial<Record<TokenActivitySource, TokenActivityEvent[]>>,
  sources: readonly TokenActivitySource[],
  cursor: TokenActivityCursor | null,
  limit: number
): TokenActivityPage {
  const all: TokenActivityEvent[] = [];
  for (const source of sources) all.push(...(fetched[source] ?? []));
  all.sort(compareActivityEvents);
  const events = all.slice(0, Math.max(0, limit));

  const next: TokenActivityCursor = { ...(cursor ?? {}) };
  let more = false;
  for (const source of sources) {
    const rows = fetched[source] ?? [];
    const taken = events.filter((e) => e.source === source);
    const last = taken[taken.length - 1];
    if (last) next[source] = { block: last.block, id: last.id };
    const exhausted = rows.length < limit && taken.length === rows.length;
    if (exhausted) next[source] = 'done';
    else more = true;
  }
  return { events, next: more ? next : null };
}

// ───────────────────────────── amounts ─────────────────────────────

function withCommas(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "8.58" -> "8.58", "2" -> "2.00", "1234.5" -> "1,234.50". Null for anything that is not a plain non-negative decimal. */
export function formatTokenAmount(raw: unknown): string | null {
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, '');
  const fraction = (m[2] ?? '').slice(0, 2).padEnd(2, '0');
  return `${withCommas(whole)}.${fraction}`;
}

/** HBD base units (3 places) -> "9.991 HBD". */
export function formatHbdBaseUnits(raw: unknown): string | null {
  const text = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const padded = text.replace(/^0+(?=\d)/, '').padStart(4, '0');
  return `${withCommas(padded.slice(0, -3))}.${padded.slice(-3)} HBD`;
}

const DID_HEAD = 6;
const DID_TAIL = 4;

/**
 * `hive:alice` -> `@alice`; a wallet DID -> `0xB41fEE…980B`. The same
 * shortening `live/adapt.ts` `displayHandle` uses for holders (copied, not
 * imported, to keep this file free of that module's imports), with the `@`
 * the rest of the wallet puts in front of a Hive name.
 */
export function displayTokenAccount(account: string): string {
  if (!account) return '';
  if (account.startsWith('hive:')) return `@${account.slice('hive:'.length)}`;
  const address = /^did:pkh:[^:]+:[^:]+:(.+)$/.exec(account)?.[1];
  if (!address) return account;
  if (address.length <= DID_HEAD + DID_TAIL + 3) return address;
  return `${address.slice(0, DID_HEAD)}…${address.slice(-DID_TAIL)}`;
}

/** `/@alice` for a Hive account; null for a wallet, which has no Lumen profile URL. */
export function tokenAccountHref(account: string): string | null {
  const name = account.startsWith('hive:') ? account.slice('hive:'.length) : '';
  return /^[a-z][a-z0-9.-]{1,15}$/.test(name) ? `/@${name}` : null;
}

/** "8.00 @lordbutterfly tokens": the amount AND which token, for lists that mix tokens. */
export function namedTokenAmount(rawTokens: unknown, creator: string): string | null {
  const amount = formatTokenAmount(rawTokens);
  if (amount === null) return null;
  const name = displayTokenAccount(creator);
  return name ? `${amount} ${name} tokens` : `${amount} tokens`;
}

// ───────────────────────────── rows ─────────────────────────────

/** A label is words and accounts; the renderer turns each account into a profile link. */
export type ActivityLabelPart = { text: string } | { account: string };

export interface TokenActivityEntry {
  key: string;
  txId: string;
  timestamp: string;
  category: HistoryCategory;
  tone: 'credit' | 'debit' | 'neutral';
  label: ActivityLabelPart[];
  amountText: string | null;
  /** One plain line under the date: what was paid or received in HBD, or what happened to an order. */
  detail: string | null;
}

/**
 * - `token`: the public ledger of one token. Nobody is "you", so no row is a
 *   credit or a debit: amounts are plain numbers, and the label names both sides.
 * - `account`: one reader's own movements. Signs and colours are relative to
 *   that account, exactly as on the Hive tab.
 */
export type TokenActivityView = { kind: 'token' } | { kind: 'account'; account: string };

const t = (text: string): ActivityLabelPart => ({ text });
const who = (account: string): ActivityLabelPart => ({ account });

export function describeTokenActivity(event: TokenActivityEvent, view: TokenActivityView): TokenActivityEntry {
  const hbd = event.hbd !== null ? formatHbdBaseUnits(event.hbd) : null;
  const base = { key: `${event.source}-${event.id}`, txId: event.txId, timestamp: event.timestamp };

  if (view.kind === 'token') {
    const amountText = (() => {
      const a = formatTokenAmount(event.tokens);
      return a === null ? null : `${a} tokens`;
    })();
    const row = (category: HistoryCategory, label: ActivityLabelPart[], detail: string | null = null): TokenActivityEntry => ({
      ...base,
      category,
      tone: 'neutral',
      label,
      amountText,
      detail
    });
    switch (event.source) {
      case 'bought':
        return row('in', [who(event.to), t(' bought')], hbd ? `Paid ${hbd}` : null);
      case 'sold':
        return row('out', [who(event.from), t(' sold')], hbd ? `Got ${hbd}` : null);
      case 'transferred':
      case 'matured':
        return row('market', [who(event.from), t(' sent to '), who(event.to)]);
      case 'asked':
        return row('other', [who(event.from), t(' placed an order')]);
      case 'answered':
        return row('reward', [who(event.creator), t(' delivered an order')]);
      case 'declined':
        return row('other', [who(event.to), t(' got tokens back')], `${displayTokenAccount(event.creator)} declined the order`);
      case 'reclaimed':
        return row('other', [who(event.to), t(' got tokens back')], 'The order was not delivered in time');
      case 'refunded':
        return row('out', [who(event.from), t(' cashed out')], hbd ? `Got ${hbd}` : null);
      case 'pushed':
        return row('out', [who(event.from), t(' was paid out')], hbd ? `Got ${hbd}` : null);
    }
  }

  const me = view.account;
  const amountText = namedTokenAmount(event.tokens, event.creator);
  const row = (
    category: HistoryCategory,
    tone: TokenActivityEntry['tone'],
    label: ActivityLabelPart[],
    detail: string | null = null
  ): TokenActivityEntry => ({ ...base, category, tone, label, amountText, detail });

  switch (event.source) {
    case 'bought':
      return row('in', 'credit', [t('Bought')], hbd ? `Paid ${hbd}` : null);
    case 'sold':
      return row('out', 'debit', [t('Sold')], hbd ? `Got ${hbd}` : null);
    case 'transferred':
    case 'matured': {
      const outgoing = event.from === me && event.to !== me;
      const incoming = event.to === me && event.from !== me;
      if (incoming) return row('in', 'credit', [t('Received from '), who(event.from)]);
      return row(outgoing ? 'out' : 'market', outgoing ? 'debit' : 'neutral', [t('Sent to '), who(event.to)]);
    }
    case 'asked':
      return row('out', 'debit', [t('Ordered from '), who(event.creator)]);
    case 'answered':
      return row('reward', 'credit', [t('Got paid for an order')]);
    case 'declined':
      return row('in', 'credit', [t('Order declined by '), who(event.creator)], 'Your tokens came back');
    case 'reclaimed':
      return row('in', 'credit', [t('Order not delivered in time')], 'Your tokens came back');
    case 'refunded':
      return row('out', 'debit', [t('Cashed out')], hbd ? `Got ${hbd}` : null);
    case 'pushed':
      return row('out', 'debit', [t('Paid out when the market closed')], hbd ? `Got ${hbd}` : null);
  }
}

// ───────────────────────────── Magi rows ─────────────────────────────

/**
 * A Meritum `transfer` call's payload, as the Magi node returns it: a JSON
 * STRING `{"creator","to","amount"}` (measured on mainnet 2026-10-06, tx
 * ba3a4d54…). Null for anything else. Used by the wallet's Magi tab, whose rows
 * otherwise read amounts from the ledger, which a token transfer never touches.
 */
export function meritumTransferPayload(raw: unknown): { creator: string; to: string; amount: string } | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const creator = field(value, 'creator');
  const to = field(value, 'to');
  const amount = field(value, 'amount');
  if (typeof creator !== 'string' || !creator || typeof to !== 'string' || !to) return null;
  const amountText = typeof amount === 'number' ? String(amount) : amount;
  if (typeof amountText !== 'string' || formatTokenAmount(amountText) === null) return null;
  return { creator, to, amount: amountText };
}
