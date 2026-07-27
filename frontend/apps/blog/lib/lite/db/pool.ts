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
 */

const logger = getLogger('app');

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  if (!liteConfig.databaseUrl) {
    throw new Error('LITE_DATABASE_URL is not set — lite-account datastore is unconfigured');
  }
  pool = new Pool({
    connectionString: liteConfig.databaseUrl,
    max: liteConfig.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on('error', (err) => logger.error(err, 'Lite DB pool error'));
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Run `fn` inside a single BEGIN/COMMIT transaction; ROLLBACK on throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
