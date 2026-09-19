import 'server-only';
import { Connection, Request as TdsRequest, type ConnectionConfiguration } from 'tedious';

/**
 * ════ HIVESQL: THE CHAIN AS A DATABASE ════
 *
 * HiveSQL is a DHF-funded, read-only SQL Server mirror of the whole chain. It answers
 * in one query what HAF needs a bounded page-walk for, and it answers two questions
 * HAF cannot answer at all.
 *
 * ★★★ THIS IS WHY THE OWNER WAS RIGHT TWICE. I first said downvotes-received needed an
 * indexer; HAF disproved that. Then I said mutes-received had no reverse lookup
 * anywhere, because HAF indexes a `custom_json` against its sender. HiveSQL has a
 * `Mutes(muter, muted)` table. Measured 2026-09-19: @lordbutterfly is muted by 27
 * accounts and appears on 9 blacklists — both zero by every other route I tried.
 *
 * ★★ WHAT EACH QUERY COSTS, MEASURED, because the shape of this module follows from it:
 *
 *     per-account mutes + blacklists          264 ms   -> fine on demand
 *     most-muted board, stake-weighted        2.6 s    -> cache it, refresh often
 *     per-account downvotes, 12 months       20.4 s    -> batch only
 *     most-downvoted board, 3 months         80.2 s    -> nightly, never on demand
 *     (a 12-month downvoted board exceeded the 60 s request timeout entirely)
 *
 * So `queryFast` and `querySlow` are separate functions with separate timeouts, and
 * the callers are forced to say which one they are. Nothing in a render path may call
 * `querySlow`.
 *
 * ★ READ-ONLY BY CONSTRUCTION, TWICE OVER. The HiveSQL login has no write grant, and
 * this module exposes no parameterised writer — `query` takes a statement and returns
 * rows. Account names are never interpolated: they go through TDS parameters, so a
 * name is a value and can never become syntax.
 *
 * ★ CREDENTIALS COME FROM THE ENVIRONMENT AND NOWHERE ELSE. They live in `.env.blog`
 * locally (gitignored) and `/opt/lumen/.env` on the server. Absent, every call here
 * returns null and the feature degrades to what HAF and the RPC can do — it does not
 * throw, and it does not log the password.
 */

export function hiveSqlConfigured(): boolean {
  return Boolean(process.env.HIVESQL_USER && process.env.HIVESQL_PASSWORD);
}

function config(): ConnectionConfiguration {
  return {
    server: process.env.HIVESQL_SERVER || 'vip.hivesql.io',
    authentication: {
      type: 'default',
      options: {
        userName: process.env.HIVESQL_USER,
        password: process.env.HIVESQL_PASSWORD
      }
    },
    options: {
      database: process.env.HIVESQL_DATABASE || 'DBHive',
      port: 1433,
      encrypt: false,
      trustServerCertificate: true,
      connectTimeout: 15000,
      requestTimeout: 30000
    }
  } as ConnectionConfiguration;
}

export interface SqlParam {
  name: string;
  /** TDS type, from tedious' TYPES. Kept loose so callers stay readable. */
  type: unknown;
  value: unknown;
}

/**
 * ★★ ONE CONNECTION PER QUERY, CLOSED IN A `finally`. A pool would be better for a
 * hot path and this has no hot path: every caller is a cache miss that happens at most
 * once per account per day. A leaked connection against somebody else's free service
 * is a worse failure than a 200 ms reconnect.
 */
async function run<T>(sql: string, params: SqlParam[], timeoutMs: number): Promise<T[] | null> {
  if (!hiveSqlConfigured()) return null;

  const cfg = config();
  (cfg.options as { requestTimeout?: number }).requestTimeout = timeoutMs;

  return new Promise<T[] | null>((resolve) => {
    let settled = false;
    const finish = (value: T[] | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const connection = new Connection(cfg);
    const hardStop = setTimeout(() => {
      try {
        connection.close();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs + 5000);

    connection.on('error', () => {
      clearTimeout(hardStop);
      // ★ CLOSE IT. An error after connect leaves the socket open otherwise, and this
      // is somebody else's free service.
      try {
        connection.close();
      } catch {
        /* already gone */
      }
      finish(null);
    });

    connection.on('connect', (err) => {
      if (err) {
        clearTimeout(hardStop);
        finish(null);
        return;
      }
      const rows: T[] = [];
      const request = new TdsRequest(sql, (error) => {
        clearTimeout(hardStop);
        try {
          connection.close();
        } catch {
          /* already gone */
        }
        finish(error ? null : rows);
      });
      for (const p of params) request.addParameter(p.name, p.type as never, p.value as never);
      request.on('row', (columns: { metadata: { colName: string }; value: unknown }[]) => {
        const row: Record<string, unknown> = {};
        for (const c of columns) row[c.metadata.colName] = c.value;
        rows.push(row as T);
      });
      connection.execSql(request);
    });

    connection.connect();
  });
}

/**
 * ★★★ `null` MEANS "WE COULD NOT ASK", `[]` MEANS "WE ASKED AND THE ANSWER IS NONE",
 * AND COLLAPSING THE TWO IS HOW THIS FEATURE TELLS ITS WORST LIE (found by adversarial
 * review, 2026-09-19).
 *
 * `hiveSqlConfigured()` only checks that the env vars EXIST. Wrong credentials, a
 * lapsed subscription, or vip.hivesql.io being down all return `null` here — and the
 * board turned that into `rows: []`, which the reader sees as **"Nothing to confess."
 * Indexed 2026-09-19 00:59**. A positive, freshly timestamped claim that nobody on
 * Hive is muted, produced by the most likely production failure there is. The
 * `unconfigured` branch only fires when the vars are absent, which is the one case
 * that will never happen on the server.
 *
 * Every caller must now distinguish the two. They are different types, so the compiler
 * makes it impossible not to.
 */

/** For queries measured under a second. Safe to await on a cache miss. */
export function queryFast<T>(sql: string, params: SqlParam[] = []): Promise<T[] | null> {
  return run<T>(sql, params, 8000);
}

/**
 * For the board aggregates. **Never call this from a render or an API route that a
 * reader is waiting on** — see the measurements at the top of this file.
 */
export function querySlow<T>(sql: string, params: SqlParam[] = []): Promise<T[] | null> {
  return run<T>(sql, params, 240000);
}
