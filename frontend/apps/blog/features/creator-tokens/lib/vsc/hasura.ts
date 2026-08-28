/**
 * The Magi indexer client — Hasura GraphQL over the views in
 * `creator-tokens/magi-indexer/creator_tokens_views.yaml`.
 *
 * WHAT THIS REPLACES. Three reads (wallet, my-asks, delivery record) used to
 * `fetch()` REST endpoints on an indexer that had no HTTP server and never
 * would: paths like `/holders/:h/positions` were invented in a comment and
 * called into nothing. They degraded honestly, so nobody noticed — but three
 * whole screens could never work.
 *
 * WHY HASURA AND NOT OUR OWN SERVER. `magi-mongo-indexer` is the official
 * vsc-eco service: it reads contract logs straight from the node's MongoDB,
 * normalises them into Postgres via a per-contract YAML mapping, and serves them
 * as GraphQL with subscriptions. Altera runs against it in production. We
 * contribute a mapping file and get the whole read side; the alternative was
 * writing and hosting a second indexer to do the same job.
 *
 * SHAPE NOTE: Hasura auto-derives one query field per view, and every scalar
 * arrives as a STRING when the underlying column is numeric/text. Every number
 * below is parsed explicitly rather than trusted — see `num`.
 */

/** One row of `lumen_ct_balances` — the holder -> creators reverse index. */
export interface HasuraBalanceRow {
  creator: string;
  tokens: number;
}

/** One row of `lumen_ct_my_asks`. */
export interface HasuraAskRow {
  creator: string;
  seq: number;
  status: 'pending' | 'answered' | 'declined' | 'reclaimed';
  offeringId: number;
  askedBlock: number;
  /** The buyer's own score for this job, or null if unrated. */
  rating: number | null;
}

/** One row of `lumen_ct_delivery_record`. Every count is real; nulls mean "no data", never zero. */
export interface HasuraDeliveryRow {
  creator: string;
  /** Block of the creator's LATEST registration — a re-registered market is a new incarnation, not an old one. 0 when unknown. */
  registeredBlock: number;
  answeredCount: number;
  missedCount: number;
  declinedCount: number;
  /** null when nothing has resolved — a creator nobody has asked has no completion rate, and 0% would read as "fails everything". */
  completionPct: number | null;
  medianResponseBlocks: number | null;
  /** null when UNRATED. Never coalesce to 0 or 5 — unrated is not the same as either. */
  avgRating: number | null;
  ratingCount: number;
}

/** One row of `lumen_ct_price_history`. `supplyAfter` -> price via the ported curve math, never a second copy of the formula. */
export interface HasuraPricePoint {
  block: number;
  supplyAfter: number;
  side: 'buy' | 'sell';
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Nullable numeric: preserves the difference between "no data" and zero, which is the whole point of several of these columns. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowsOf(data: unknown, key: string): unknown[] {
  if (typeof data !== 'object' || data === null) return [];
  const v = (data as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

function field(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[key] : undefined;
}

export class MagiIndexerClient {
  /** Base URL of the Hasura instance, e.g. https://indexer.magi.milohpr.com — the /v1/graphql path is appended here. */
  private readonly endpoint: string;
  private readonly contractId: string;

  constructor(baseUrl: string, contractId: string) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/graphql`;
    this.contractId = contractId;
  }

  /**
   * NOT scoped to `indexer_contract_id` — that column does not exist on any of
   * the five `lumen_ct_*` views on this Hasura instance (confirmed live via
   * introspection against https://indexer.testnet.magi.milohpr.com/v1/graphql,
   * 2026-08-11). Every query used to filter on it and every one of them failed
   * with `field 'indexer_contract_id' not found in type: '..._bool_exp'`.
   *
   * This is safe for the same reason it looked dangerous: this Hasura instance
   * is per-network (one deployment = one testnet), and today it is also
   * effectively per-contract in practice, so there is no second contract's rows
   * to leak here. `this.contractId` is kept as a field on the client (set from
   * the constructor, unchanged) purely as dormant plumbing for the day scoping
   * comes back — but it is NOT included in the `variables` sent over the wire
   * below. That is not optional: this Hasura instance validates the variables
   * payload strictly and rejects any variable that isn't declared by the query
   * document, even ones no field references — `{"errors":[{"message":
   * "unexpected variables in variableValues: contractId", ...}]}` — confirmed
   * live, 2026-08-11. So every query below now declares only the `$vars` it
   * actually uses, and `query()` must forward `variables` unmodified.
   *
   * IF MULTI-CONTRACT SCOPING EVER APPEARS (either this Hasura instance starts
   * serving more than one Magi creator-tokens deployment, or the upstream
   * mapping adds a real `indexer_contract_id`/`contract_id` column to these
   * views), every query below MUST add both: a `$contractId: String!` to its
   * signature AND `contractId: this.contractId` back into the variables object
   * passed to `query()`, plus the matching `where:` filter, or reads will
   * silently mix rows across contracts again. Check the live schema with an
   * introspection query before re-adding it — don't guess the column name.
   */
  private async query(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) throw new Error(`magi indexer: HTTP ${res.status}`);
    const json: unknown = await res.json();
    const errors = field(json, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`magi indexer: ${JSON.stringify(errors[0])}`);
    }
    return field(json, 'data');
  }

  async balancesOf(holder: string): Promise<HasuraBalanceRow[]> {
    const data = await this.query(
      `query Balances($holder: String!) {
         lumen_ct_balances(where: {holder: {_eq: $holder}}) {
           creator tokens
         }
       }`,
      { holder }
    );
    return rowsOf(data, 'lumen_ct_balances').map((r) => ({
      creator: String(field(r, 'creator') ?? ''),
      tokens: num(field(r, 'tokens'))
    }));
  }

  async asksOf(asker: string): Promise<HasuraAskRow[]> {
    const data = await this.query(
      `query MyAsks($asker: String!) {
         lumen_ct_my_asks(where: {asker: {_eq: $asker}}, order_by: {asked_block: desc}) {
           creator seq status offering_id asked_block rating
         }
       }`,
      { asker }
    );
    return rowsOf(data, 'lumen_ct_my_asks').map((r) => ({
      creator: String(field(r, 'creator') ?? ''),
      seq: num(field(r, 'seq')),
      status: (String(field(r, 'status') ?? 'pending') as HasuraAskRow['status']) ?? 'pending',
      offeringId: num(field(r, 'offering_id')),
      askedBlock: num(field(r, 'asked_block')),
      rating: numOrNull(field(r, 'rating'))
    }));
  }

  async deliveryOf(creator: string): Promise<HasuraDeliveryRow | null> {
    const data = await this.query(
      `query Delivery($creator: String!) {
         lumen_ct_delivery_record(where: {creator: {_eq: $creator}}) {
           creator registered_block answered_count missed_count declined_count completion_pct median_response_blocks avg_rating rating_count
         }
       }`,
      { creator }
    );
    const rows = rowsOf(data, 'lumen_ct_delivery_record');
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      creator: String(field(r, 'creator') ?? creator),
      registeredBlock: num(field(r, 'registered_block')),
      answeredCount: num(field(r, 'answered_count')),
      missedCount: num(field(r, 'missed_count')),
      declinedCount: num(field(r, 'declined_count')),
      completionPct: numOrNull(field(r, 'completion_pct')),
      medianResponseBlocks: numOrNull(field(r, 'median_response_blocks')),
      avgRating: numOrNull(field(r, 'avg_rating')),
      ratingCount: num(field(r, 'rating_count'))
    };
  }

  /** Price history as SUPPLY points. The caller applies the ported curve formula — see the view's own doc for why the price is not stored. */
  async priceHistoryOf(creator: string, limit = 200): Promise<HasuraPricePoint[]> {
    const data = await this.query(
      `query PriceHistory($creator: String!, $limit: Int!) {
         lumen_ct_price_history(where: {creator: {_eq: $creator}}, order_by: {block: desc}, limit: $limit) {
           block supply_after side
         }
       }`,
      { creator, limit }
    );
    // ★★ `desc` + reverse, NOT `asc` (2026-08-28). `asc` with a LIMIT takes the
    // OLDEST `limit` rows, so the moment a market passes 200 trades its chart
    // silently froze on ancient history: the newest trades were never fetched,
    // the last plotted point stopped being the current price, and the price
    // change derived from the same array inherited the same staleness. It fails
    // exactly when a creator succeeds, and it fails quietly — a full-looking
    // chart of real points, none of them recent.
    // `desc` fetches the newest `limit`; the reverse below restores the
    // oldest -> newest order every caller expects (`readPriceHistory` maps
    // straight through, and both the chart and `priceChangeOf` read [0] as the
    // start and [n-1] as now).
    return rowsOf(data, 'lumen_ct_price_history').reverse().map((r) => ({
      block: num(field(r, 'block')),
      supplyAfter: num(field(r, 'supply_after')),
      side: field(r, 'side') === 'sell' ? 'sell' : 'buy'
    }));
  }

  /**
   * The indexer's own ingest position. Hasura exposes `indexer_health` from the
   * upstream magi-mongo-indexer deployment (confirmed live against
   * https://indexer.testnet.magi.milohpr.com/v1/graphql, 2026-08-25).
   *
   * Takes no variables — see `query()`'s note: this instance rejects any
   * variable the document does not declare, so the object stays empty rather
   * than carrying an unused `contractId`.
   *
   * Returns nulls rather than throwing on an empty result set. A missing health
   * row means "cannot tell", which the caller renders as unknown; it must not
   * take down a discovery read that otherwise succeeded.
   */
  async health(): Promise<{ lastUpdate: string | null; latestBlockHeight: number | null }> {
    const data = await this.query(
      `query IndexerHealth {
         indexer_health { last_update latest_block_height }
       }`,
      {}
    );
    const rows = rowsOf(data, 'indexer_health');
    if (rows.length === 0) return { lastUpdate: null, latestBlockHeight: null };
    const r = rows[0];
    const ts = field(r, 'last_update');
    return {
      lastUpdate: typeof ts === 'string' && ts.length > 0 ? ts : null,
      latestBlockHeight: numOrNull(field(r, 'latest_block_height'))
    };
  }

  /** The ranked creator list. Ordering lives in the VIEW, deliberately — so a client cannot quietly re-rank on price or volume. */
  async discovery(limit = 60): Promise<HasuraDeliveryRow[]> {
    const data = await this.query(
      `query Discovery($limit: Int!) {
         lumen_ct_discovery(limit: $limit) {
           creator registered_block answered_count missed_count declined_count completion_pct median_response_blocks avg_rating rating_count
         }
       }`,
      { limit }
    );
    return rowsOf(data, 'lumen_ct_discovery').map((r) => ({
      creator: String(field(r, 'creator') ?? ''),
      registeredBlock: num(field(r, 'registered_block')),
      answeredCount: num(field(r, 'answered_count')),
      missedCount: num(field(r, 'missed_count')),
      declinedCount: num(field(r, 'declined_count')),
      completionPct: numOrNull(field(r, 'completion_pct')),
      medianResponseBlocks: numOrNull(field(r, 'median_response_blocks')),
      avgRating: numOrNull(field(r, 'avg_rating')),
      ratingCount: num(field(r, 'rating_count'))
    }));
  }
}
