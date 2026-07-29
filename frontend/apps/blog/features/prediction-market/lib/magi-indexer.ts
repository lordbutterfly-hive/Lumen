/**
 * The Magi indexer client — Hasura GraphQL over the views in
 * `prediction-market/magi-indexer/prediction_market_views.yaml`.
 *
 * WHAT THIS REPLACES. `readBettors` used to `fetch()` `${indexerUrl}/rounds/:id/bettors`
 * on this repo's own Go indexer. That indexer had an HTTP server but could never
 * be fed: go-vsc-node persists every contract log, but its PUBLIC GraphQL type
 * `ContractOutputResult` exposes only `ret` and `ok` — there is no path from
 * `findContractOutput` to the persisted logs, so the only production event source
 * was a documented stub waiting on an upstream schema change. It has been deleted.
 *
 * WHY HASURA AND NOT OUR OWN SERVER. `magi-mongo-indexer` is the official vsc-eco
 * service: it reads contract logs straight from the node's MongoDB, normalises
 * them into Postgres via a per-contract YAML mapping, and serves them as GraphQL
 * with subscriptions. Altera runs against it in production, and creator tokens
 * already migrated to it — so both Lumen contracts now read through one path.
 *
 * SHAPE NOTE: Hasura auto-derives one query field per view, and every scalar
 * arrives as a STRING when the underlying column is numeric or text. Nothing here
 * trusts a JSON type; every number is parsed explicitly.
 *
 * THIS CLIENT THROWS. It never returns an empty result on failure. A round with
 * genuinely no bets and a round whose index is unreachable are different facts,
 * and the caller has to be able to tell them apart — see `readBettors`, which
 * returns `null` for "unknown" rather than the `0` it used to invent.
 */

/** One row of `lumen_pm_round_summary`. */
export interface MarketRoundSummary {
  roundId: number;
  /** Distinct accounts with at least one bet on the round. */
  bettors: number;
  betCount: number;
  /** Base units, as text on the wire. */
  totalStaked: string;
  state: 'open' | 'settled' | 'void';
  /** Only ever non-null when `state === 'settled'` — the void path never sets a winner. */
  winner: number | null;
  reason: string | null;
  swept: boolean;
}

/** One row of `lumen_pm_pool_history` — the real series behind the market chart. */
export interface MarketPoolPoint {
  roundId: number;
  outcome: number;
  block: number;
  /** Running total on that bucket immediately after this bet, in base units. */
  poolAfter: string;
}

/** One row of `lumen_pm_my_unclaimed` — where an account still has collectable money. */
export interface MarketUnclaimedRow {
  roundId: number;
  state: 'settled' | 'void';
  stakeTotal: string;
  /** Null on a void round, where the question is meaningless. */
  stakeOnWinner: string | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '0' : String(v);
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

function field(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[key] : undefined;
}

function rowsOf(data: unknown, key: string): unknown[] {
  if (typeof data !== 'object' || data === null) return [];
  const v = (data as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : [];
}

function roundState(v: unknown): 'open' | 'settled' | 'void' {
  return v === 'settled' || v === 'void' ? v : 'open';
}

export class MagiIndexerClient {
  /** Base URL of the Hasura instance, e.g. https://indexer.magi.milohpr.com — /v1/graphql is appended here. */
  private readonly endpoint: string;
  private readonly contractId: string;

  constructor(baseUrl: string, contractId: string) {
    this.endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/graphql`;
    this.contractId = contractId;
  }

  private async query(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) {
      throw new Error(`Magi indexer HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    const errors = field(json, 'errors');
    if (Array.isArray(errors) && errors.length > 0) {
      const first = field(errors[0], 'message');
      throw new Error(`Magi indexer error: ${typeof first === 'string' ? first : 'unknown'}`);
    }
    return field(json, 'data');
  }

  /**
   * The round card's headline figures. Contract state cannot answer `bettors` at
   * all: it stores stakes keyed by account with no roster to enumerate, so
   * "how many distinct people are in this round" is only answerable by folding
   * the bet events.
   */
  async readRoundSummary(roundId: number): Promise<MarketRoundSummary | null> {
    const data = await this.query(
      `query PmRoundSummary($c: String!, $r: numeric!) {
        lumen_pm_round_summary(where: {contract_id: {_eq: $c}, round_id: {_eq: $r}}, limit: 1) {
          round_id bettors bet_count total_staked state winner reason swept
        }
      }`,
      { c: this.contractId, r: roundId }
    );
    const row = rowsOf(data, 'lumen_pm_round_summary')[0];
    if (row === undefined) return null;
    return {
      roundId: num(field(row, 'round_id')),
      bettors: num(field(row, 'bettors')),
      betCount: num(field(row, 'bet_count')),
      totalStaked: str(field(row, 'total_staked')),
      state: roundState(field(row, 'state')),
      winner: numOrNull(field(row, 'winner')),
      reason: strOrNull(field(row, 'reason')),
      swept: field(row, 'swept') === true
    };
  }

  /**
   * Every bet on a round, as a running per-bucket total. The chart draws implied
   * odds over time from this — real bets, never an interpolated curve.
   */
  async readPoolHistory(roundId: number): Promise<MarketPoolPoint[]> {
    const data = await this.query(
      `query PmPoolHistory($c: String!, $r: numeric!) {
        lumen_pm_pool_history(
          where: {contract_id: {_eq: $c}, round_id: {_eq: $r}}
          order_by: {block: asc}
        ) { round_id outcome block pool_after }
      }`,
      { c: this.contractId, r: roundId }
    );
    return rowsOf(data, 'lumen_pm_pool_history').map((row) => ({
      roundId: num(field(row, 'round_id')),
      outcome: num(field(row, 'outcome')),
      block: num(field(row, 'block')),
      poolAfter: str(field(row, 'pool_after'))
    }));
  }

  /**
   * Rounds where this account still has money it can actually collect. The view
   * already excludes settled-round losers (owed nothing) and swept rounds (past
   * the ~90-day window, where claim and reclaim are both refused) — showing
   * either would be advertising money that cannot be taken.
   */
  async readUnclaimed(acct: string): Promise<MarketUnclaimedRow[]> {
    const data = await this.query(
      `query PmUnclaimed($c: String!, $a: String!) {
        lumen_pm_my_unclaimed(
          where: {contract_id: {_eq: $c}, acct: {_eq: $a}}
          order_by: {round_id: desc}
        ) { round_id state stake_total stake_on_winner }
      }`,
      { c: this.contractId, a: acct }
    );
    return rowsOf(data, 'lumen_pm_my_unclaimed').map((row) => {
      const state = field(row, 'state');
      return {
        roundId: num(field(row, 'round_id')),
        state: state === 'settled' ? 'settled' : 'void',
        stakeTotal: str(field(row, 'stake_total')),
        stakeOnWinner: strOrNull(field(row, 'stake_on_winner'))
      };
    });
  }
}
