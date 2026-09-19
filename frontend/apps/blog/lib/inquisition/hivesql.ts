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
 * ════ THE GATE ════
 *
 * ★★★ AT MOST `MAX_INFLIGHT` CONNECTIONS TO HIVESQL AT ONCE, PER WORKER, AND A CALLER
 * THAT CANNOT GET IN GIVES UP RATHER THAN QUEUEING (added after adversarial review,
 * 2026-09-19).
 *
 * "One connection per query" is fine when every caller is a once-a-day cache miss. It
 * stops being fine the moment a caller can be driven by a stranger: `/api/inquisition/
 * record/<name>` accepts any name matching `^[a-z0-9.-]{3,16}$`, and a name with no
 * account returns `null`, which the cache deliberately refuses to store. So a `curl`
 * loop over made-up names was one new TDS login per request, forever, against a
 * DHF-funded free service we use under a single subscription. The rate limiter in
 * `request-budget.ts` is the first gate; this is the one that holds when that gate is
 * wrong, and it is the one that also covers our own background builds running on three
 * workers at once.
 *
 * ★★ FAILING FAST IS THE POINT. An unbounded queue just moves the pile-up from the
 * database to this process and hands every waiting reader a four-minute tab. `null`
 * here means exactly what it means everywhere else in this module — "we could not ask"
 * — and every caller already has to distinguish that from "the answer is none".
 */
/**
 * ★★★ TWO LANES, AND THIS IS NOT A REFINEMENT — A SINGLE SHARED GATE BROKE THE PROFILE
 * STRIP THE FIRST TIME IT RAN (2026-09-19).
 *
 * With one pool of four, opening the dashboard starts four board builds at once, every
 * slot is taken, and the next per-account read — an armed reader's profile — waits two
 * seconds, gives up, and renders "The record could not be read." While the database was
 * perfectly healthy. A background job had starved a reader.
 *
 * So background aggregates and reader-facing lookups do not compete. They have separate
 * counters, the slow lane is deliberately the smaller one, and a reader's query can
 * always get in. Worst case is five concurrent connections per worker, fifteen across
 * the cluster, which is a reasonable thing to ask of a service we do not pay for.
 */
const SLOW_LANE = 2;
/*
 * ★★★ SIX, BECAUSE ONE READER TAKES TWO. A single armed profile issues `profileRecord`
 * and `voteLedger` concurrently through `Promise.all`, and both are reader-lane queries.
 * At three slots that is two readers to saturation: the third arrives, waits its three
 * seconds, gives up, and the profile renders "The record could not be read." against a
 * database that was answering fine. Found by audit, and it is the same self-inflicted
 * starvation that a background build caused earlier from the other direction.
 */
const FAST_LANE = 6;
/**
 * ★★★ AND THE QUEUE HAS TO BE LONGER THAN THE WORK, WHICH 120s WAS NOT. Observed
 * 2026-09-19: opening the dashboard starts five builds, the two slow-lane slots go to the
 * downvote aggregate (80s) and the inquisitor walk (~90s), and the KE board sat in the
 * queue, timed out at two minutes, and reported itself **unavailable** against a database
 * that was answering perfectly well. A build that gives up looks identical to a build the
 * database refused. Ten minutes is longer than any query here can take, so the only thing
 * that can now produce `unavailable` is a real failure.
 *
 * ★★ A READER GIVES UP; A BACKGROUND BUILD QUEUES. Three seconds is the difference
 * between a strip that fills and a strip that lies, and nobody is watching a build, so
 * it can afford to wait its turn — which is the behaviour we actually want against
 * somebody else's database: the aggregates run one or two at a time instead of all at
 * once. A build that gave up quickly would be indistinguishable from a build the
 * database refused, and would put an available board into a minute of cooldown for no
 * reason at all.
 */
const FAST_WAIT_MS = 3000;
const SLOW_WAIT_MS = 600000;

const GATE_SLOT = Symbol.for('lumen.inquisition.hivesql.gate.v2');
const gate = ((globalThis as Record<symbol, unknown>)[GATE_SLOT] ??= { fast: 0, slow: 0 }) as {
  fast: number;
  slow: number;
};

type Lane = 'fast' | 'slow';

async function acquire(lane: Lane): Promise<boolean> {
  const limit = lane === 'fast' ? FAST_LANE : SLOW_LANE;
  const deadline = Date.now() + (lane === 'fast' ? FAST_WAIT_MS : SLOW_WAIT_MS);
  for (;;) {
    if (gate[lane] < limit) {
      gate[lane] += 1;
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function release(lane: Lane): void {
  gate[lane] = Math.max(0, gate[lane] - 1);
}

/**
 * ★★ ONE CONNECTION PER QUERY, CLOSED IN A `finally`. A pool would be better for a
 * hot path and this has no hot path: every caller is a cache miss that happens at most
 * once per account per day. A leaked connection against somebody else's free service
 * is a worse failure than a 200 ms reconnect.
 */
async function run<T>(sql: string, params: SqlParam[], timeoutMs: number, lane: Lane): Promise<T[] | null> {
  if (!hiveSqlConfigured()) return null;
  if (!(await acquire(lane))) return null;
  try {
    return await connectAndRun<T>(sql, params, timeoutMs);
  } finally {
    release(lane);
  }
}

async function connectAndRun<T>(sql: string, params: SqlParam[], timeoutMs: number): Promise<T[] | null> {
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
  return run<T>(sql, params, 8000, 'fast');
}

/**
 * ★★★ THE READER LANE, WITH A REALISTIC CEILING, AND ITS ABSENCE SILENTLY EMPTIED THREE
 * COLUMNS (2026-09-19).
 *
 * The vote ledger pulls every root post an account has written with its `active_votes`
 * blob: 883 posts and ~8 MB for @lordbutterfly, measured at **12.1 seconds**. It was
 * issued through `queryFast`, whose ceiling is 8 seconds, so it timed out on every single
 * call and returned `null` — and `null` is correctly treated as "we could not ask", so
 * REMOVED, the top-three downvoters and SELF-REWARD all rendered as "not computed" on
 * every profile. Nothing errored and nothing logged; the figures were simply never there.
 *
 * It belongs on the FAST lane regardless, because a reader is waiting for it: the slow
 * lane queues behind background board builds for up to ten minutes, which would be worse
 * than the timeout. Three slots, a minute of headroom, and the result is cached for a day.
 */
export function queryReader<T>(sql: string, params: SqlParam[] = []): Promise<T[] | null> {
  return run<T>(sql, params, 60000, 'fast');
}

/**
 * For the board aggregates. **Never call this from a render or an API route that a
 * reader is waiting on** — see the measurements at the top of this file.
 */
export function querySlow<T>(sql: string, params: SqlParam[] = []): Promise<T[] | null> {
  return run<T>(sql, params, 240000, 'slow');
}

/**
 * ★★★ A BACKGROUND QUERY WITH ITS OWN CEILING, SO ONE GIANT CANNOT STARVE THE REST.
 *
 * The per-account money pass runs down a board's rows under a wall-clock budget. On
 * `querySlow`'s 240s ceiling the first two rows — @spaminator with 1,769,154 downvotes
 * and @mack-bot with 558,579 — consumed eight of the ten available minutes between them
 * and produced nothing, so 28 of 30 rows reported a dash. Most accounts take ~19s; the
 * outliers are two orders of magnitude worse. Capping each attempt means the budget is
 * spent on rows that can actually finish, and the ones that cannot say so.
 */
export function queryCapped<T>(sql: string, params: SqlParam[], timeoutMs: number): Promise<T[] | null> {
  return run<T>(sql, params, timeoutMs, 'slow');
}
