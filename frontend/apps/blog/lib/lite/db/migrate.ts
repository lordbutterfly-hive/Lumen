import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from '@ui/lib/logging';
import { getPool } from './pool';

/**
 * Minimal forward-only SQL migration runner. Applies every `*.sql` file in
 * ./migrations (lexicographic order) that has not been applied yet, each inside
 * its own transaction, recording applied ids in `_lite_migrations`.
 *
 * Intended to be invoked from an ops script (e.g. `tsx lib/lite/db/run-migrations.ts`)
 * or a guarded admin route — NOT from the Next.js request path. The .sql files
 * are read from disk relative to this module.
 */

const logger = getLogger('app');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _lite_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM _lite_migrations');
  const applied = new Set(rows.map((r) => r.id));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _lite_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      logger.info('Applied lite migration %s', file);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(error, `Lite migration failed: ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }
  return ran;
}
