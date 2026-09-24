/**
 * The bell's Meritum rows, and the rule that decides which rows are UNREAD.
 *
 * An order on Meritum is a CHAIN event: the creator-token contract escrows the
 * buyer's tokens (`Ask`), and the creator either delivers (`Answer` — there is no
 * separate accept step, the answer IS the delivery), declines (`Decline`, full
 * refund) or lets the deadline pass (`Reclaim`, by anyone). The buyer may then
 * `Rate` an answered order once, 1-5. None of that is in the Lumen DB beside
 * follows and DMs, but all of it belongs in the same bell, so these rows are
 * read from the Magi indexer's views of the contract's own logs
 * (`creator-tokens/magi-indexer/creator_tokens_views.yaml`) and shaped exactly
 * like the follow and DM rows.
 *
 * Pure: no chain, no DB, no React, no Next. The route
 * (`app/api/lite/notifications/route.ts`) fetches and hands the JSON in; the
 * header hook (`use-lumen-notifications.ts`) owns the storage and hands the
 * marks in. The unit test imports this directly.
 */

export type LumenNotificationType =
  | 'follow'
  | 'dm'
  /** Somebody bought this reader's Meritum. */
  | 'buy'
  /** Seller: somebody ordered one of this reader's services. */
  | 'order'
  /** Buyer: the reader's own order is on chain, waiting for the creator. */
  | 'order_placed'
  /** Buyer: the creator answered — the order is delivered and paid. */
  | 'delivered'
  /** Buyer: the creator declined and the tokens came back. */
  | 'declined'
  /** Seller: the buyer scored a delivery. */
  | 'rated'
  /** Seller: a buyer reclaimed after the deadline; the contract wrote a miss. */
  | 'missed'
  /** Somebody reblogged this reader's post with a comment (quote reblog spec v2 7.7). */
  | 'quote';

export interface LumenNotificationRow {
  /**
   * The identity of the EVENT, not of the row's text: `<type>:<creator>:<seq>`
   * for an escrow event (the contract's own key, `e|<creator>|<seq>`), the tx
   * hash for a buy, the follower or sender plus time for a Lumen row. This is
   * what the per-device "seen" set is keyed by — see `isUnread` for why a
   * timestamp alone was not enough.
   */
  id: string;
  type: LumenNotificationType;
  msg: string;
  /** Site-relative, no leading slash; the panel prefixes `/`. */
  url: string;
  /** ISO-8601 WITH a zone marker. The indexer's naive UTC gets its `Z` here. */
  date: string;
  /**
   * The account that caused the event, without the leading `@`, and only when
   * it is a Hive name the bell can draw a face from. A wallet identity has no
   * hosted avatar, so it is left out and the panel draws the Meritum mark.
   */
  actor?: string;
  source: 'lumen';
}

/** The rows that are about Meritum — the ones the panel marks with the laurel. */
export const MERITUM_TYPES: ReadonlySet<LumenNotificationType> = new Set<LumenNotificationType>([
  'buy',
  'order',
  'order_placed',
  'delivered',
  'declined',
  'rated',
  'missed'
]);

/** Where a seller goes to act on an order: the Studio inbox, Requests sub-tab. */
export const SELLER_INBOX_URL = 'creators/studio?section=inbox&tab=requests';
/** Where a buyer sees their own orders: the wallet's Meritum tab, asks list. */
/** /wallet/tokens is a permanent redirect to the wallet's Meritum tab; `view=asks` lands on the Asks sub-tab. */
export const BUYER_ASKS_URL = 'wallet?tab=meritum&view=asks';

// ── The indexer's rows, as Hasura returns them ──────────────────────────────
// Every numeric column arrives as a JSON number for `numeric` views and as a
// STRING for base-unit money columns; both are parsed explicitly, never trusted.

export interface BoughtEvent {
  creator: string;
  actor: string;
  minted: string;
  total_due: string;
  indexer_ts: string;
  indexer_tx_hash: string;
}
export interface AskedEvent {
  creator: string;
  actor: string;
  seq: number | string;
  offering_id: number | string;
  credits_spent: string;
  indexer_ts: string;
}
export interface AnsweredEvent {
  creator: string;
  seq: number | string;
  answer_hash: string;
  indexer_ts: string;
}
export interface DeclinedEvent {
  creator: string;
  asker: string;
  seq: number | string;
  indexer_ts: string;
}
export interface ReclaimedEvent {
  creator: string;
  actor: string;
  asker: string;
  seq: number | string;
  indexer_ts: string;
}
export interface RatedEvent {
  creator: string;
  actor: string;
  seq: number | string;
  score: number | string;
  indexer_ts: string;
}
export interface OfferingTitleRow {
  offering_id: number | string;
  title: string;
}

/** The `data` of `MERITUM_NOTIFICATIONS_QUERY`, plus `delivered` from the second query. */
export interface MeritumNotificationData {
  bought?: BoughtEvent[];
  ordered?: AskedEvent[];
  placed?: AskedEvent[];
  declined?: DeclinedEvent[];
  rated?: RatedEvent[];
  /** Reclaims against the reader's markets: a customer took their tokens back after a missed deadline. */
  missed?: ReclaimedEvent[];
  offerings?: OfferingTitleRow[];
  renamed?: OfferingTitleRow[];
  delivered?: AnsweredEvent[];
}

/** Each list is bounded on its own; the bell shows the newest few, never a history. */
export const EVENT_LIMIT = 20;
export const BUY_LIMIT = 15;
export const OFFERING_LIMIT = 50;

/**
 * ONE round trip for everything keyed by the reader's own identities. `$keys`
 * serves both roles at once — the same account sells (creator = key) and buys
 * (actor/asker = key) — so Hasura's multi-root-field query answers the seller
 * half and the buyer half together. Every field is filtered to the deployed
 * contract: the indexer holds every incarnation of the contract it has ever
 * tracked, and a testnet buy must not ring a mainnet bell.
 *
 * `offerings`/`renamed` carry the service TITLE so an order row can name what
 * was ordered. The contract logs the title on create and again on every title
 * change (`SetOfferingTitle`), so the later `renamed` row wins — both lists come
 * back oldest-first for exactly that reason.
 */
export const MERITUM_NOTIFICATIONS_QUERY = `query MeritumNotifications($keys: [String!], $contract: String!) {
  bought: lumen_ct_bought_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${BUY_LIMIT}
  ) { creator actor minted total_due indexer_ts indexer_tx_hash }
  ordered: lumen_ct_asked_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator actor seq offering_id credits_spent indexer_ts }
  placed: lumen_ct_asked_events(
    where: { actor: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator actor seq offering_id credits_spent indexer_ts }
  declined: lumen_ct_declined_events(
    where: { asker: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator asker seq indexer_ts }
  rated: lumen_ct_rated_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator actor seq score indexer_ts }
  missed: lumen_ct_reclaimed_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator actor asker seq indexer_ts }
  offerings: lumen_ct_offering_created_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: asc }
    limit: ${OFFERING_LIMIT}
  ) { offering_id title }
  renamed: lumen_ct_offering_updated_events(
    where: { creator: { _in: $keys }, indexer_contract_id: { _eq: $contract } }
    order_by: { indexer_ts: asc }
    limit: ${OFFERING_LIMIT}
  ) { offering_id title }
}`;

/**
 * The buyer's "delivered" rows need a SECOND round trip, and it cannot be
 * folded into the first: `lumen_ct_answered_events` carries the creator and
 * the seq but NOT the asker (the contract's `answered` log names who answered,
 * not who asked), so "answered events that belong to MY asks" is a join through
 * the reader's own `asked` rows — which only the first answer knows. The where
 * clause is built by `deliveredWhere` from those rows and passed as a variable.
 */
export const DELIVERED_FOR_ASKS_QUERY = `query DeliveredForAsks($where: lumen_ct_answered_events_bool_exp!) {
  delivered: lumen_ct_answered_events(
    where: $where
    order_by: { indexer_ts: desc }
    limit: ${EVENT_LIMIT}
  ) { creator seq answer_hash indexer_ts }
}`;

/**
 * `{creator, seq} IN (the reader's asks)` for the contract, or null when the
 * reader has never asked anyone — then the second query is not sent at all.
 */
export function deliveredWhere(placed: readonly AskedEvent[], contract: string): Record<string, unknown> | null {
  const pairs = placed
    .slice(0, EVENT_LIMIT)
    .map((a) => ({ creator: { _eq: a.creator }, seq: { _eq: num(a.seq) } }))
    .filter((p) => p.creator._eq && Number.isFinite(p.seq._eq));
  if (pairs.length === 0) return null;
  return { _and: [{ indexer_contract_id: { _eq: contract } }, { _or: pairs }] };
}

// ── Display helpers ────────────────────────────────────────────────────────

/** HBD carries 3 decimals; the indexer stores base units as strings. */
export const hbd = (baseUnits: string): number => Number(baseUnits || '0') / 1000;

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : Number(v ?? '');
  return Number.isFinite(n) ? n : Number.NaN;
};

/** The indexer stores naive UTC, like the chain does. Say so, or the bell sorts it by the reader's own timezone offset. */
export const zoned = (ts: string): string => (ts.endsWith('Z') || ts.includes('+') ? ts : `${ts}Z`);

/** A Hive account's handle, or undefined for a wallet identity — the only kind of name the bell can draw a face from. */
export const faceOf = (key: string): string | undefined => (key.startsWith('hive:') ? key.slice('hive:'.length) : undefined);

/**
 * How an account reads in a sentence: `@alice` for a Hive account; a wallet DID
 * collapses to the `0xB41fEE…980B` shortening every wallet UI uses (same rule
 * as `features/creator-tokens/live/adapt.ts displayHandle`, kept out of this
 * module's imports so it stays chain-free). NEVER put this in a URL.
 */
export function mention(key: string): string {
  const hive = faceOf(key);
  if (hive) return `@${hive}`;
  const address = /^did:pkh:[^:]+:[^:]+:(.+)$/.exec(key)?.[1];
  if (!address) return key;
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── The rows ───────────────────────────────────────────────────────────────

/**
 * Every Meritum row for a reader who owns `keys` (their contract account ids:
 * `hive:<name>` for a Hive session, the bound wallets' `did:pkh:…` for a lite
 * one). Self-dealing never rings: a creator buying or asking their own market
 * (the launch first-buy, a top-up, a test order) is dropped on both sides.
 *
 * Order of the result is not meaningful — the route sorts the merged list.
 */
export function meritumNotificationRows(data: MeritumNotificationData, keys: readonly string[]): LumenNotificationRow[] {
  const mine = new Set(keys);
  const rows: LumenNotificationRow[] = [];

  // The reader's own market page, where a creator goes to see what just
  // happened to their supply and price. `/creators/<h>` still redirects, but
  // the page moved to `/m/<h>` and a bell should not bounce.
  const ownHandle = faceOf(keys[0] ?? '') ?? keys[0] ?? '';

  for (const b of data.bought ?? []) {
    if (mine.has(b.actor)) continue;
    const tokens = num(b.minted) || 0;
    rows.push({
      id: `buy:${b.creator}:${b.indexer_tx_hash}`,
      type: 'buy',
      // Reads like every other row: actor first, then what they did.
      msg: `${mention(b.actor)} bought ${tokens === 1 ? 'a' : tokens} Meritum of yours for $${hbd(b.total_due).toFixed(2)}`,
      url: `m/${ownHandle}`,
      date: zoned(b.indexer_ts),
      actor: faceOf(b.actor),
      source: 'lumen'
    });
  }

  // Later title changes override the created title: both lists arrive oldest-first.
  const titles = new Map<number, string>();
  for (const o of [...(data.offerings ?? []), ...(data.renamed ?? [])]) {
    const id = num(o.offering_id);
    if (Number.isFinite(id) && o.title) titles.set(id, o.title);
  }

  for (const a of data.ordered ?? []) {
    if (mine.has(a.actor)) continue;
    const title = titles.get(num(a.offering_id));
    const tokens = num(a.credits_spent) || 0;
    rows.push({
      id: `order:${a.creator}:${num(a.seq)}`,
      type: 'order',
      msg: `${mention(a.actor)} ordered your ${title ? `"${title}"` : 'service'} for ${plural(tokens, 'token')}`,
      url: SELLER_INBOX_URL,
      date: zoned(a.indexer_ts),
      actor: faceOf(a.actor),
      source: 'lumen'
    });
  }

  for (const a of data.placed ?? []) {
    if (mine.has(a.creator)) continue;
    rows.push({
      id: `order_placed:${a.creator}:${num(a.seq)}`,
      type: 'order_placed',
      msg: `Your request to ${mention(a.creator)} is placed and waiting for their answer`,
      url: BUYER_ASKS_URL,
      date: zoned(a.indexer_ts),
      actor: faceOf(a.creator),
      source: 'lumen'
    });
  }

  for (const d of data.delivered ?? []) {
    if (mine.has(d.creator)) continue;
    rows.push({
      id: `delivered:${d.creator}:${num(d.seq)}`,
      type: 'delivered',
      msg: `${mention(d.creator)} delivered your request`,
      url: BUYER_ASKS_URL,
      date: zoned(d.indexer_ts),
      actor: faceOf(d.creator),
      source: 'lumen'
    });
  }

  for (const d of data.declined ?? []) {
    if (mine.has(d.creator)) continue;
    rows.push({
      id: `declined:${d.creator}:${num(d.seq)}`,
      type: 'declined',
      msg: `${mention(d.creator)} declined your request and refunded your tokens`,
      url: BUYER_ASKS_URL,
      date: zoned(d.indexer_ts),
      actor: faceOf(d.creator),
      source: 'lumen'
    });
  }

  for (const r of data.rated ?? []) {
    if (mine.has(r.actor)) continue;
    const score = num(r.score);
    if (!Number.isFinite(score)) continue;
    rows.push({
      id: `rated:${r.creator}:${num(r.seq)}`,
      type: 'rated',
      msg: `${mention(r.actor)} rated your delivery ${score} of 5 stars`,
      url: SELLER_INBOX_URL,
      date: zoned(r.indexer_ts),
      actor: faceOf(r.actor),
      source: 'lumen'
    });
  }

  // A reclaim is the one ending the creator never chose and was never shown:
  // the buyer took their tokens back after the deadline and the contract wrote
  // a miss against the record. Said plainly, because a record that changes
  // without a word is how a creator finds out from their own falling completion rate.
  for (const r of data.missed ?? []) {
    if (mine.has(r.asker)) continue;
    rows.push({
      id: `missed:${r.creator}:${num(r.seq)}`,
      type: 'missed',
      msg: `${mention(r.asker)} reclaimed their tokens after the deadline passed; a miss is on your record`,
      url: SELLER_INBOX_URL,
      date: zoned(r.indexer_ts),
      actor: faceOf(r.asker),
      source: 'lumen'
    });
  }
  return rows;
}

// ── Unread: which rows THIS device has not shown yet ───────────────────────

/**
 * ★★★ A TIMESTAMP CUTOFF CANNOT COUNT A ROW THAT ARRIVES LATE (2026-09-21,
 * owner: "someone bought" shows in the list but never puts the number on the
 * bell).
 *
 * The read mark used to be ONE number, the wall-clock time this device last
 * opened the bell, and a row was unread iff `row.date > seenAt`. Both halves of
 * that are right on their own and wrong together:
 *
 *   * `row.date` is BLOCK time. The indexer stamps each event with the Hive
 *     block's own timestamp (verified: `indexer_ts` of the test order equals
 *     `get_block_header` for its block to the second), and a buy reaches the
 *     bell only after the contract output is final and the indexer has parsed
 *     it — minutes after the block, on a bad day more.
 *   * The list is cached for 60s (`staleTime`) and refetched on navigation, so
 *     even with a perfect indexer the rows on screen are up to a minute old.
 *
 * So a reader who opens the bell at 17:02 marks `seenAt = 17:02`, and the buy
 * that happened at 17:00 but reached the list at 17:04 carries a date BEFORE
 * the mark. It renders in the panel, it sorts correctly, and it is never
 * unread — the badge is silent for exactly the row the reader most wants to
 * hear about. Any row whose block time precedes the last open is lost the same
 * way, whatever its type.
 *
 * The mark is therefore a SET OF ROW IDS: a row is unread until this device
 * has shown it, whatever its timestamp says. The old cutoff is kept only for
 * a row that carries no id (a response from before ids existed), and as a
 * one-time seed so the upgrade does not resurrect months-old follows as new.
 */
export interface SeenMarks {
  /** Ids this device has shown, oldest first, capped at `SEEN_IDS_CAP`. */
  ids: string[];
  /** The old cutoff (ms since epoch). Still the rule for a row without an id. */
  seenAt: number;
}

/**
 * Enough to remember every row the route can return several times over (it
 * bounds each list at 15-30 and there are eight of them), so a row never falls
 * off the set while it is still on screen; small enough that the JSON stays a
 * few KB in localStorage.
 */
export const SEEN_IDS_CAP = 300;

type MarkableRow = { id?: string; date: string };

export function isUnread(row: MarkableRow, marks: SeenMarks): boolean {
  if (row.id) return !marks.ids.includes(row.id);
  const at = new Date(row.date).getTime();
  return Number.isFinite(at) && at > marks.seenAt;
}

export function unreadCount(rows: readonly MarkableRow[], marks: SeenMarks): number {
  const seen = new Set(marks.ids);
  let n = 0;
  for (const row of rows) {
    if (row.id ? !seen.has(row.id) : isUnread(row, marks)) n++;
  }
  return n;
}

/**
 * The marks after the panel opened over `rows`: every id on screen joins the
 * set (already-known ids move to the newest end, so the cap evicts what has
 * been off screen longest), and the cutoff advances to `now` for id-less rows.
 */
export function marksAfterOpen(rows: readonly { id?: string }[], marks: SeenMarks, now: number): SeenMarks {
  const shown = rows.map((r) => r.id).filter((id): id is string => !!id);
  const onScreen = new Set(shown);
  const kept = marks.ids.filter((id) => !onScreen.has(id));
  const ids = [...kept, ...Array.from(onScreen)];
  return { ids: ids.slice(Math.max(0, ids.length - SEEN_IDS_CAP)), seenAt: Math.max(marks.seenAt, now) };
}

/**
 * The one-time seed for a device that has a timestamp mark but no id set yet:
 * everything the old rule already counted as seen stays seen, so the upgrade
 * is silent for a reader who was up to date, and everything else — including
 * the late-arriving rows the old rule lost — is unread once, as it should be.
 */
export function marksFromLegacy(rows: readonly MarkableRow[], seenAt: number): SeenMarks {
  const ids = rows
    .filter((r) => {
      if (!r.id) return false;
      const at = new Date(r.date).getTime();
      return Number.isFinite(at) && at <= seenAt;
    })
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string')
    .slice(-SEEN_IDS_CAP);
  return { ids, seenAt };
}
