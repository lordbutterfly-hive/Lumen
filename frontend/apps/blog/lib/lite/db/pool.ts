import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';

/**
 * Single shared Postgres pool for the lite-account backend (spec §4: one
 * centrally-owned datastore, not one per feature). Lazily constructed so that
 * importing lite code in an environment without a DB does not crash at load —
 * it only errors when a query is actually attempted.
 *
 * Server-side only.
 *
 * ★★★ ONE POOL PER PROCESS, NOT PER WEBPACK LAYER (2026-09-06, module-copies
 * build map R3). Next compiles this file once per layer — `rsc` (pages, app
 * route handlers) and `instrument` (instrumentation.ts and everything it
 * imports, which reaches this file through `warm-server-caches.ts` ->
 * `feed-prefetch.ts` -> `engagement-repository.ts`'s `mergeLumenEngagement`
 * during the home-feed boot warm) — so a module-level `let pool` used to mean
 * two Pools, each capped at `liteConfig.dbPoolMax`, in the SAME process: proven
 * live, two Pool instances at `Runtime.queryObjects(Pool.prototype)`, doubling
 * the worst-case connection budget per worker from `dbPoolMax` to
 * `2 x dbPoolMax`. `pg` is already loaded as a single external module
 * (`server-external-packages.json`), so `Pool`'s class identity is already
 * shared across both copies — only the INSTANCE needs to be.
 */

const logger = getLogger('app');

const POOL_SLOT = Symbol.for('lumen.lite.pgPool.v1');

interface PoolSlot {
  pool: Pool | null;
}

function poolSlot(): PoolSlot {
  const carrier = globalThis as typeof globalThis & { [POOL_SLOT]?: PoolSlot };
  carrier[POOL_SLOT] ??= { pool: null };
  return carrier[POOL_SLOT];
}

export function getPool(): Pool {
  const slot = poolSlot();
  if (slot.pool) return slot.pool;
  if (!liteConfig.databaseUrl) {
    throw new Error('LITE_DATABASE_URL is not set — lite-account datastore is unconfigured');
  }
  slot.pool = new Pool({
    connectionString: liteConfig.databaseUrl,
    max: liteConfig.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // ★ FIX-DOS, 2026-09-08 (DOS-04). Neither timeout above bounds a statement that is
    // ALREADY RUNNING on a checked-out connection — `connectionTimeoutMillis` only
    // bounds waiting for a free connection, `idleTimeoutMillis` only an idle, checked-in
    // one. `statement_timeout` is sent as a Postgres startup parameter (see `pg`'s own
    // `connection-parameters.js`), so it applies to every connection this pool ever
    // opens, before the first query runs on it — not a per-query `SET` that could be
    // skipped. See `liteConfig.dbStatementTimeoutMs`'s own doc for the measurement and
    // the reason 2000ms matches this database's existing Python readers.
    statement_timeout: liteConfig.dbStatementTimeoutMs
  });
  slot.pool.on('error', (err) => logger.error(err, 'Lite DB pool error'));
  return slot.pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/**
 * `query`, but with a PER-STATEMENT `statement_timeout` override instead of
 * the pool's default (`liteConfig.dbStatementTimeoutMs`, 2000ms — see DOS-04
 * in `getPool()` above).
 *
 * ★ FIX-DOS-04-REVISED, 2026-09-08. DOS-04's pool-level cap protects the
 * request path, but at least one legitimate off-request-path job
 * (`sweepServedFeeds` in `feed-served-repository.ts`, whose own doc comment
 * says it "aggregates the whole table" at "low millions of rows") can
 * genuinely need more than 2s and must not be silently and permanently
 * broken by the pool default — see `liteConfig.dbSweepStatementTimeoutMs`'s
 * own doc for why.
 *
 * Uses `SET LOCAL` (transaction-scoped) rather than a session-level `SET`:
 * `SET LOCAL` automatically reverts at COMMIT/ROLLBACK, so there is no way
 * for an overridden timeout to leak onto the connection once it goes back to
 * the pool — unlike a bare `SET statement_timeout = …` on a checked-out
 * client, which `pg` does NOT auto-reset on release, and which a thrown error
 * (skipping a matching `RESET`) would leave permanently applied to whichever
 * request next happens to check out that same physical connection.
 *
 * `timeoutMs` must be a trusted, internally-controlled number — never
 * user input — because Postgres's `SET`/`SET LOCAL` do not accept bind
 * parameters, so the value is interpolated directly into the statement.
 */
export async function queryWithTimeout<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] | undefined,
  timeoutMs: number
): Promise<QueryResult<T>> {
  const ms = Math.max(0, Math.trunc(timeoutMs));
  return withTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${ms}`);
    return client.query<T>(text, params);
  });
}

/**
 * A query runner. Repository functions that may need to take part in a transaction
 * accept one of these instead of calling `query` directly: pass nothing for the pool,
 * or `execOn(client)` to join an open transaction.
 */
export type Exec = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

/** Bind a transaction client as an {@link Exec}. */
export function execOn(client: PoolClient): Exec {
  return <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
    client.query<T>(text, params);
}

/** Run `fn` inside a single BEGIN/COMMIT transaction; ROLLBACK on throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (rollbackError) {
      // Release WITH the error when the rollback itself fails: that DISCARDS the
      // connection instead of returning one that may still be inside a transaction to
      // the pool. The original error is what propagates — the rollback's is incidental.
      client.release(rollbackError as Error);
    }
    throw error;
  }
}

/**
 * Run `fn` while holding a Postgres advisory lock, or skip it if another process
 * holds the lock. Returns null when the lock could not be taken.
 *
 * Needed by the publisher: the 3-second broadcast pacer is a process-local variable,
 * so two overlapping drains (likely once a backlog exists, since one drain call can
 * run ~84 seconds) would each believe it was safe to broadcast and collide on Hive's
 * reply interval. Job claiming is already multi-worker safe; pacing was the only
 * thing that wasn't.
 */
export async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key]
    );
    if (!rows[0]?.locked) return null;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
