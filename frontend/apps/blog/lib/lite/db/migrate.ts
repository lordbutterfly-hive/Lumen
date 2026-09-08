import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';

/**
 * Minimal forward-only SQL migration runner. Applies every `*.sql` file in
 * ./migrations (lexicographic order) that has not been applied yet, each inside
 * its own transaction, recording applied ids in `_lite_migrations`.
 *
 * Intended to be invoked from an ops script (e.g. `tsx lib/lite/db/run-migrations.ts`)
 * or a guarded admin route — NOT from the Next.js request path. The .sql files
 * are read from disk relative to this module.
 *
 * ★ FIX-DOS-04-REVISED, 2026-09-08. Runs on a DEDICATED, private `pg.Client` —
 * never `getPool()`, the shared pool every request-path route also draws from.
 *
 * DOS-04 gave that shared pool a `statement_timeout: liteConfig.dbStatementTimeoutMs`
 * (2000ms, see `pool.ts`) as a Postgres STARTUP parameter, so it binds every
 * connection the pool ever opens, before the first query runs on it. Migrations
 * used to run through `pool.connect()` — the SAME pool, so the SAME 2000ms cap —
 * and 28 of the 41 real migration files in ./migrations run `CREATE INDEX`
 * (several more do a one-off backfill `UPDATE`), which routinely exceeds 2s once
 * a table has real rows. PROVEN on this fix's own scratch overlay: a synthetic
 * migration containing `SELECT pg_sleep(3)` (standing in for a slow CREATE
 * INDEX/backfill) was killed at 2473ms by statement_timeout (57014), ROLLBACK,
 * and `runMigrations()` threw — the WHOLE migration run aborted, which would
 * have broken the very next production deploy's migration step.
 *
 * A dedicated `Client` — connected fresh here, always `.end()`ed in `finally`,
 * never returned to the shared pool — has no `statement_timeout` at all (the
 * Postgres server-side default, unlimited, unless the server itself sets one),
 * so a legitimately slow DDL/backfill statement now runs to completion exactly
 * as it did before DOS-04. This was chosen over the alternative of checking out
 * a shared-pool connection and running `SET statement_timeout = 0` on it: that
 * connection eventually goes back to the pool via `client.release()`, and `pg`
 * does not auto-RESET session-level `SET`s on release — a migration that threw
 * between the `SET` and a matching `RESET` (exactly the failure path a broken
 * migration takes) would silently leak an UNLIMITED statement_timeout onto that
 * pooled connection forever, quietly defeating DOS-04's request-path protection
 * for whatever request next happens to check it out. A private connection that
 * is never pooled has no such leak surface, and this path is already ops-only
 * (see `run-migrations.ts`'s own doc comment), never request-path, so the cost
 * of a private connection here is negligible.
 *
 * DOS-04's protection for the REQUEST path (`getPool()`/`query()`/`withTransaction`
 * in `pool.ts`) is UNCHANGED by this file — this only exempts the migration
 * runner, not the app.
 */

const logger = getLogger('app');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export async function runMigrations(): Promise<string[]> {
  if (!liteConfig.databaseUrl) {
    throw new Error('LITE_DATABASE_URL is not set — lite-account datastore is unconfigured');
  }
  const client = new Client({ connectionString: liteConfig.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _lite_migrations (
         id TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );

    const { rows } = await client.query<{ id: string }>('SELECT id FROM _lite_migrations');
    const applied = new Set(rows.map((r) => r.id));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
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
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}
