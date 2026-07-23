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
