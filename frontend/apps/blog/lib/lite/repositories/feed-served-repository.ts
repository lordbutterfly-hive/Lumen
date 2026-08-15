import { query } from '../db/pool';

/**
 * THE SERVED LOG (table `lumen_feed_served`, migration 0027).
 *
 * ★ WHY IT EXISTS. Measured 2026-08-08 and adjudicated in
 * `O:/LUMEN-DOCS/FEED-BALANCE-RULING-2026-08-08.md` §7: two consecutive /feed
 * calls returned a BYTE-IDENTICAL top 20, and 19-20 of those 20 posts are still
 * eligible tomorrow. A reader who opens the app three times a day therefore gets
 * zero new information on visits 2 and 3, and every discovery budget in the
 * ruling ("4 slots for popularity, 2 for newcomers") silently becomes a budget
 * for ONE PAGE A DAY rather than for the feed. Nothing recorded what a reader
 * had already been shown, so nothing could tell the difference.
 *
 * ★ WHAT THIS IS NOT. It is not the demotion. The `0.85^impressions` rule lives
 * in the ranker and is deliberately absent here — this module is the INSTRUMENT
 * the demotion will be built against and measured on. `countImpressions` is the
 * number that rule will consume; what is done with it is not this file's call.
 *
 * ★ IT RECORDS, IT DOES NOT INTERPRET. Every serve is written with its own
 * `served_at`, so a consumer can pick any coalescing window after the fact
 * (`countImpressions` takes one). The one interpretation applied at WRITE time
 * is a short page-level minimum interval, and it exists to reject machine noise
 * — a component remount or a window-focus refetch is not a second reading of
 * the page. See `recordServedPage`.
 *
 * Rebuildable by observation, exactly like `lumen_feed_store`: losing this table
 * costs a colder demotion for a few days, never data. That is what licenses the
 * blunt bounds in `sweepServedFeeds`.
 */

/** One post as the reader actually received it. */
export interface ServedItem {
  /** `author/permlink` — the SERVED identity (a lite post uses its display name). */
  postKey: string;
  /** 0-based position in the delivered page. */
  position: number;
  /** The recsys lane, or null when the stored feed predates lane recording. */
  source: string | null;
  /**
   * `@author/permlink` — the RANKED identity (migration 0036).
   *
   * ★ THE LOG CARRIES IT SO THE AGGREGATE IS REBUILDABLE FROM THE LOG, which is
   * the claim `0036_feed_seen.sql` makes and this field is what makes it true.
   * `lumen_feed_seen` is derived and disposable; without these two columns here,
   * losing it would mean losing history rather than losing a cache.
   *
   * Optional so a caller that has no ranked identity in scope stays valid —
   * absent is recorded as NULL, i.e. UNKNOWN.
   */
  rankedKey?: string | null;
  /**
   * Distinct non-lite engagers at this serve — the resurrection baseline.
   * See `rankedKey`. NULL is UNKNOWN, never 0.
   */
  engagers?: number | null;
}

export interface ServedRow extends ServedItem {
  viewer: string;
  servedAt: Date;
}

interface Row {
  viewer: string;
  post_key: string;
  served_at: Date;
  position: number;
  source: string | null;
}

function mapRow(r: Row): ServedRow {
  return {
    viewer: r.viewer,
    postKey: r.post_key,
    servedAt: r.served_at,
    position: Number(r.position) || 0,
    source: r.source
  };
}

export interface RecordServedPageInput {
  viewer: string;
  items: ServedItem[];
  /**
   * Skip the write entirely when this viewer already has a serve recorded
   * within this many milliseconds. 0 disables it. See below for why it is a
   * PAGE-level rule and not a per-post one.
   */
  minIntervalMs: number;
  /**
   * ★★★ WRITE THE TWO COLUMNS MIGRATION 0036 ADDS (`ranked_key`,
   * `engagers_at_serve`). DEFAULT FALSE, AND THE DEFAULT IS LOAD-BEARING.
   *
   * Migrations in this app are an EXPLICIT OPS STEP, not a boot step —
   * `run-migrations.ts` says so in its own header ("intentionally NOT wired into
   * the request path"). So the code can, and routinely will, be running against
   * a database that has not had 0036 applied yet.
   *
   * If this statement named those columns unconditionally, that window would
   * turn every serve into an `UndefinedColumn` error. The caller catches it and
   * logs a warning, so the visible symptom would be: THE SERVED LOG SILENTLY
   * STOPS RECORDING — taking the feed instrument AND the author-facing "your
   * posts landed in N feeds" number down with it, with nothing but a warn line
   * to say so. That is the same shape of silent, deploy-ordering failure this
   * table's own history is full of.
   *
   * So the columns are written only when the caller has affirmatively turned the
   * feature on (`FEED_SEEN_RECORD=yes`), which is the deliberate act that also
   * requires the migration. Off, this statement is byte-identical to the
   * pre-2026-08-15 one and cannot care whether 0036 exists.
   */
  includeSeenColumns?: boolean;
}

export interface RecordServedPageResult {
  /** Rows written. 0 means the write was coalesced into a recent one. */
  recorded: number;
  coalesced: boolean;
}

/**
 * Record one delivered page.
 *
 * ★ ONE STATEMENT, AND THE COALESCE TEST IS INSIDE IT. A read-then-write would
 * race two concurrent tabs into a double record; `NOT EXISTS` evaluated by the
 * server in the same statement cannot. All rows land with the same `now()` — the
 * transaction timestamp — which is what makes a serve event addressable later as
 * `served_at = max(served_at)` without inventing a batch id column.
 *
 * ★ WHY THE MINIMUM INTERVAL IS PER PAGE, NOT PER POST. A per-post rule would
 * suppress the 18 posts a reader has just seen and keep the 2 that are new,
 * leaving a two-row "page" in the log and destroying the ability to ask what a
 * page CONTAINED. Suppressing the whole page keeps every recorded page whole and
 * costs at most one page per window; a human does not consume two distinct feed
 * pages inside 60 seconds, but a remount, a StrictMode double-render or a
 * window-focus refetch produces several in one second and none of them is a
 * reading.
 *
 * ★ WHAT IT DOES NOT DO: it does not dedupe by CONTENT. Two identical pages 10
 * minutes apart are two impressions, because the reader was shown the post
 * twice — that repetition is the entire subject of the ruling and hiding it in
 * the instrument would be measuring our own excuse.
 *
 * Best-effort under exact concurrency: two requests whose transactions start in
 * the same instant can both pass `NOT EXISTS` and both record. The primary key
 * absorbs the degenerate case where their timestamps are also identical.
 */
export async function recordServedPage(
  input: RecordServedPageInput
): Promise<RecordServedPageResult> {
  const { viewer, items } = input;
  if (!viewer || items.length === 0) return { recorded: 0, coalesced: false };

  const gapMs = Math.max(0, Math.trunc(input.minIntervalMs));
  // ★ THE `served_at <= now()` HALF OF THE WINDOW: A ROW FROM THE FUTURE MAY NOT
  // SUPPRESS THE PRESENT. Caught by running it, 2026-08-08 — this box's clock
  // JUMPS. The Postgres container was measured 3m24s ahead of the host and then
  // snapped back, so a page recorded during the forward excursion sat in the
  // table stamped LATER than now(). With only a lower bound, every subsequent
  // serve was coalesced away until real time caught up: the log went silent for
  // minutes, which reads exactly like "the reader stopped reading". An upper
  // bound costs nothing and turns an open-ended blackout into one skipped page.
  // ★ THE COALESCE WINDOW, SHARED BY BOTH VARIANTS. Kept as one string so the
  // two statements below cannot drift on the half that decides whether a page is
  // recorded at all — only on which columns it carries.
  const coalesceWindow = `
      WHERE $5::bigint = 0
         OR NOT EXISTS (
              SELECT 1 FROM lumen_feed_served x
               WHERE x.viewer = $1
                 AND x.served_at > now() - ($5::bigint * INTERVAL '1 millisecond')
                 -- Clock jumped forward and back: see the note above.
                 AND x.served_at <= now()
            )
     ON CONFLICT DO NOTHING`;

  const params: unknown[] = [
    viewer,
    items.map((i) => i.postKey),
    items.map((i) => i.position),
    // A null lane is recorded as a null lane. Not recording the row would cost
    // an impression, which is the one thing this table must never get wrong.
    items.map((i) => i.source),
    gapMs
  ];
  // ★ `ranked_key` / `engagers_at_serve` exist only after migration 0036 — see
  // `includeSeenColumns` for why naming them unconditionally would silently
  // kill this log on any deploy that runs ahead of the migration.
  let sql = `INSERT INTO lumen_feed_served (viewer, post_key, served_at, "position", source)
     SELECT $1, t.post_key, now(), t.position, t.source
       FROM unnest($2::text[], $3::int[], $4::text[]) AS t(post_key, position, source)${coalesceWindow}`;
  if (input.includeSeenColumns) {
    params.push(
      items.map((i) => i.rankedKey ?? null),
      items.map((i) => i.engagers ?? null)
    );
    sql = `INSERT INTO lumen_feed_served
            (viewer, post_key, served_at, "position", source, ranked_key, engagers_at_serve)
     SELECT $1, t.post_key, now(), t.position, t.source, t.ranked_key, t.engagers
       FROM unnest($2::text[], $3::int[], $4::text[], $6::text[], $7::int[])
            AS t(post_key, position, source, ranked_key, engagers)${coalesceWindow}`;
  }

  const result = await query(sql, params);
  const recorded = result.rowCount ?? 0;
  return { recorded, coalesced: recorded === 0 };
}

/**
 * The viewer's last delivered page, in served order.
 *
 * Answers "what did this reader last actually see", which before migration 0027
 * could only be answered by re-requesting the feed over HTTP and hoping nothing
 * had changed in between.
 */
export async function listLastServedPage(viewer: string): Promise<ServedRow[]> {
  if (!viewer) return [];
  const { rows } = await query<Row>(
    `SELECT viewer, post_key, served_at, "position", source
       FROM lumen_feed_served
      WHERE viewer = $1
        AND served_at = (SELECT max(served_at) FROM lumen_feed_served WHERE viewer = $1)
      ORDER BY "position"`,
    [viewer]
  );
  return rows.map(mapRow);
}

export interface LaneSlots {
  source: string | null;
  slots: number;
}

/**
 * Lane composition of the viewer's last delivered page — the §7 target table's
 * left-hand column, from storage instead of from eight live HTTP calls.
 */
export async function laneCompositionOfLastServedPage(viewer: string): Promise<LaneSlots[]> {
  if (!viewer) return [];
  const { rows } = await query<{ source: string | null; slots: string }>(
    `SELECT source, count(*)::text AS slots
       FROM lumen_feed_served
      WHERE viewer = $1
        AND served_at = (SELECT max(served_at) FROM lumen_feed_served WHERE viewer = $1)
      GROUP BY source
      ORDER BY count(*) DESC, source NULLS LAST`,
    [viewer]
  );
  return rows.map((r) => ({ source: r.source, slots: Number(r.slots) || 0 }));
}

/**
 * Everything this viewer has been shown since `sinceHours` ago, newest first.
 *
 * This is the "what has this viewer seen recently" read the
 * `(viewer, served_at DESC)` index exists for — the cheap membership test a
 * ranker wants before it decides whether a candidate is news.
 */
export async function listSeenKeysSince(viewer: string, sinceHours: number): Promise<string[]> {
  if (!viewer) return [];
  const hours = Math.max(1, Math.trunc(sinceHours));
  const { rows } = await query<{ post_key: string }>(
    `SELECT post_key
       FROM lumen_feed_served
      WHERE viewer = $1
        AND served_at > now() - ($2::int * INTERVAL '1 hour')
      GROUP BY post_key
      ORDER BY max(served_at) DESC`,
    [viewer, hours]
  );
  return rows.map((r) => r.post_key);
}

export interface ImpressionStats {
  /** Every recorded serve of this post to this viewer inside the window. */
  impressions: number;
  /**
   * Serves separated by at least `coalesceSeconds` — i.e. distinct viewing
   * occasions rather than raw deliveries. The demotion should almost certainly
   * use THIS, but the choice is the consumer's and both are returned.
   */
  sessions: number;
  lastServedAt: Date;
  /** Best (lowest) position it has ever occupied for this viewer. */
  bestPosition: number;
}

export interface ImpressionQuery {
  /** How far back to look. Default 3 days = recsys's own sourcing window. */
  withinDays?: number;
  /** Two serves closer than this count as one occasion. Default 300s. */
  coalesceSeconds?: number;
}

/**
 * How many times each of `postKeys` has been shown to `viewer`.
 *
 * ★ THIS IS THE NUMBER THE DEMOTION CONSUMES, and the reason it returns two of
 * them: `impressions` is the raw truth as recorded, `sessions` collapses serves
 * that are close enough together to be one reading. A rule of the form
 * `0.85^n` is extremely sensitive to which one it is fed — n=5 is 0.44, n=10 is
 * 0.20 — so the instrument hands over both and refuses to pick.
 *
 * The window function makes `sessions` EXACT (gap since the previous serve of
 * the same post), not a fixed-grid bucket count that would split two serves one
 * second apart across a boundary.
 */
export async function countImpressions(
  viewer: string,
  postKeys: string[],
  opts: ImpressionQuery = {}
): Promise<Map<string, ImpressionStats>> {
  const out = new Map<string, ImpressionStats>();
  if (!viewer || postKeys.length === 0) return out;
  const withinDays = Math.max(1, Math.trunc(opts.withinDays ?? 3));
  const coalesceSeconds = Math.max(0, Math.trunc(opts.coalesceSeconds ?? 300));

  const { rows } = await query<{
    post_key: string;
    impressions: string;
    sessions: string;
    last_served_at: Date;
    best_position: number;
  }>(
    `SELECT post_key,
            count(*)::text AS impressions,
            count(*) FILTER (
              WHERE prev IS NULL OR served_at - prev >= ($4::int * INTERVAL '1 second')
            )::text AS sessions,
            max(served_at) AS last_served_at,
            min("position")::int AS best_position
       FROM (
         SELECT post_key, served_at, "position",
                lag(served_at) OVER (PARTITION BY post_key ORDER BY served_at) AS prev
           FROM lumen_feed_served
          WHERE viewer = $1
            AND post_key = ANY($2::text[])
            AND served_at > now() - ($3::int * INTERVAL '1 day')
       ) t
      GROUP BY post_key`,
    [viewer, postKeys, withinDays, coalesceSeconds]
  );

  for (const r of rows) {
    out.set(r.post_key, {
      impressions: Number(r.impressions) || 0,
      sessions: Number(r.sessions) || 0,
      lastServedAt: r.last_served_at,
      bestPosition: Number(r.best_position) || 0
    });
  }
  return out;
}

export interface ServedSweepOptions {
  /** Drop anything served longer ago than this. */
  ttlDays: number;
  /** Keep at most this many rows per viewer, newest first. */
  maxRowsPerViewer: number;
  /** Global backstop, newest first. */
  maxRows: number;
}

export interface ServedSweepResult {
  expired: number;
  perViewerOverCap: number;
  overCap: number;
}

/**
 * Bound the log. THREE limits, because they fail in three different ways and no
 * one of them covers the others:
 *
 *   TTL              recsys sources from a 3-day window, so a post older than
 *                    that cannot be re-served and its history cannot inform any
 *                    demotion. The default 7 days leaves a week for the weekly
 *                    balance probe.
 *   PER-VIEWER CAP   the bound `lumen_feed_store` does not need and this table
 *                    cannot do without. There, one viewer is one row and a
 *                    global cap is fair. Here rows-per-viewer grows with how
 *                    often somebody loads the feed, so under a single shared
 *                    ceiling one heavy or automated viewer evicts every other
 *                    reader's history — per-user state behind a global-only
 *                    limit is a griefing primitive, not a bound.
 *   GLOBAL CAP       the disk backstop as viewer COUNT grows, which neither of
 *                    the above covers.
 *
 * Off the request path and throttled by the caller. `ctid` is safe as the delete
 * key here because these rows are append-only and never updated, so it cannot
 * move between the subquery and the delete.
 *
 * HONEST LIMIT: the per-viewer pass aggregates the whole table to find which
 * viewers are over the cap. At the scale this runs at (a 10-minute throttle,
 * low millions of rows) that is cheaper than the machinery to avoid it; if the
 * table ever grows past that, this belongs in a scheduled job with a
 * high-water-mark, not in a sweep fired after a feed write.
 */
export async function sweepServedFeeds(opts: ServedSweepOptions): Promise<ServedSweepResult> {
  const ttlDays = Math.max(1, Math.trunc(opts.ttlDays));
  const perViewer = Math.max(1, Math.trunc(opts.maxRowsPerViewer));
  const maxRows = Math.max(1, Math.trunc(opts.maxRows));

  const expired = await query(
    // Interval built from an integer we just clamped and multiplied server-side,
    // never string-concatenated into the SQL.
    `DELETE FROM lumen_feed_served WHERE served_at < now() - ($1::int * INTERVAL '1 day')`,
    [ttlDays]
  );

  const perViewerOverCap = await query(
    `DELETE FROM lumen_feed_served s
      USING (
        SELECT ctid,
               row_number() OVER (PARTITION BY viewer ORDER BY served_at DESC, "position") AS rn
          FROM lumen_feed_served
         WHERE viewer IN (
           SELECT viewer FROM lumen_feed_served GROUP BY viewer HAVING count(*) > $1
         )
      ) t
      WHERE s.ctid = t.ctid AND t.rn > $1`,
    [perViewer]
  );

  const overCap = await query(
    `DELETE FROM lumen_feed_served
      WHERE ctid IN (
        SELECT ctid FROM lumen_feed_served ORDER BY served_at DESC OFFSET $1
      )`,
    [maxRows]
  );

  return {
    expired: expired.rowCount ?? 0,
    perViewerOverCap: perViewerOverCap.rowCount ?? 0,
    overCap: overCap.rowCount ?? 0
  };
}

/**
 * Forget one viewer's served history.
 *
 * Not called by the feed today; it is the erasure hook a per-user delete needs,
 * and a log of what a named person read is exactly the kind of table that must
 * have one from the day it is created rather than the day it is asked for.
 */
export async function deleteServedHistory(viewer: string): Promise<number> {
  if (!viewer) return 0;
  const result = await query('DELETE FROM lumen_feed_served WHERE viewer = $1', [viewer]);
  return result.rowCount ?? 0;
}
