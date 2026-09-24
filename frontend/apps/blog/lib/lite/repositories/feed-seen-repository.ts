import { query } from '../db/pool';

/**
 * ★★★★ SEEN-POST SUPPRESSION — THE IMPRESSION AGGREGATE (2026-08-15).
 *
 * Migration: `0036_feed_seen.sql`, which carries the full argument for why this
 * is a NEW table rather than a column on `lumen_feed_served`. The short version:
 * the log's 8,508 existing rows were written under a definition that no longer
 * applies (a 3-minute poll was recording pages nobody looked at, at ~31 for 1),
 * the log silently truncates at 2,000 rows per viewer, and it has no engagement
 * baseline. This table is the derived, disposable, bounded thing the ranker
 * reads; the log stays the append-only audit trail with its own second consumer.
 *
 * ★★★ WHAT THE RANKER DOES WITH IT, so nobody has to guess from here. recsys
 * reads THIS TABLE DIRECTLY over `LUMEN_LITE_DATABASE_URL` — the DSN it already
 * holds and already opens for lite votes/reblogs (`recsys/io/seen_log.py`). No
 * new transport, no ingestion job, and — critically — no second answer to "has
 * this reader seen this", which is the failure mode this codebase has already
 * shipped twice with engagement counts.
 *
 * ★★★ CONTRACT C1 — WHAT MAY WRITE HERE.
 *
 * An impression counts ONLY on foreground delivery to a reader. Never at build,
 * never during a warm rebuild, never on a probe. That is enforced by PLACEMENT,
 * not by documentation: the only caller of `recordFeedSeen` is `recordFeedServe`
 * (`lib/feed/feed-cache.ts`), which is itself called from exactly two lines, both
 * inside the serve branches of `/api/feed/for-you` and both already guarded by
 * `if (!probe)`. The warmer (`lib/feed/viewer-warmer.ts`) calls the builder and
 * `writeViewerFeed` and nothing else — it does not import this module, and it
 * must never start.
 *
 * A feed assembled in the background and never delivered was seen by nobody.
 * Under a 2-impression rule, getting that wrong means a reader who never opened
 * the app has their whole feed suppressed after two warm cycles.
 */

/** One delivered post, with the two facts suppression needs beyond the key. */
export interface SeenItem {
  /** `author/permlink` — the SERVED identity (a lite post uses its display name). */
  postKey: string;
  /**
   * `@author/permlink` — recsys's `Post.key`, the RANKED identity.
   *
   * ★ CONTRACT C8, AND THE ONLY REASON SUPPRESSION WORKS ON OUR OWN CONTENT. For
   * a Lumen-native post `postKey` uses the writer's DISPLAY HANDLE while recsys
   * ranks under their `lumen_user_id` ULID — different strings, so a suppression
   * set built from `postKey` matches zero lite posts, forever, with no error.
   * Proven against real rows 2026-08-15: 46 of 8,508 served rows are lite and
   * every one is handle-keyed (`bravouyuce/lumen-01kzchxgtzzg4ef6v9kyb694de`,
   * whose ranked key is `@01KZAC6C92G3MJ7QV8BN3B82EA/lumen-...`), and
   * `WHERE post_key LIKE '@%'` returns 0.
   *
   * `null` when the delivery carried no matching RecsysPost (a chain top-up).
   */
  rankedKey: string | null;
  /**
   * Distinct NON-LITE engagers this post carried at THIS serve — the
   * resurrection baseline.
   *
   * ★ `null` is UNKNOWN, never 0. An unknown baseline means growth cannot be
   * evaluated, which the ranker resolves toward SHOWING the post. Writing 0 for
   * "we did not receive a number" would silently turn that into the strictest
   * possible reading of the least reliable data.
   */
  engagers: number | null;
  /** 0-based position in the delivered page. */
  position: number;
}

export interface RecordSeenResult {
  /** Rows inserted or updated. */
  written: number;
}

/**
 * Record one delivered page against the aggregate.
 *
 * ★ ONE STATEMENT, SAME SHAPE AS THE LOG'S WRITE. `unnest` over parallel arrays,
 * not an anonymous composite — `(a, b) = ANY($1)` raises `FeatureNotSupported:
 * input of anonymous composite types is not implemented` at bind time against a
 * real PostgreSQL, which this codebase shipped once and only caught by executing
 * it. Every array below is bound natively.
 *
 * ★ CALLED DETACHED, never awaited by a request. A reader waits for nothing.
 */
export async function recordFeedSeen(
  viewer: string,
  items: SeenItem[]
): Promise<RecordSeenResult> {
  if (!viewer || items.length === 0) return { written: 0 };

  const result = await query(
    `INSERT INTO lumen_feed_seen AS s
            (viewer, post_key, ranked_key, impressions, engagers_at_last_serve, best_position)
     SELECT $1, t.post_key, t.ranked_key, 1, t.engagers, t.position
       FROM unnest($2::text[], $3::text[], $4::int[], $5::int[])
            AS t(post_key, ranked_key, engagers, position)
         ON CONFLICT (viewer, post_key) DO UPDATE
        SET impressions    = LEAST(s.impressions + 1, 32767),
            last_served_at = now(),
            -- A known ranked key is never clobbered by a later NULL: a chain
            -- top-up delivering the same post must not erase the identity
            -- suppression joins on.
            ranked_key     = COALESCE(EXCLUDED.ranked_key, s.ranked_key),
            -- ★★★ ALWAYS RE-ARMED, AND THAT IS THE WHOLE RESURRECTION DESIGN.
            -- The baseline is "what it had when I last showed it to you", so
            -- every serve moves it up and a second resurrection costs another
            -- full growth step. Impressions are never reset, so a post that
            -- stops growing stays suppressed permanently while one that keeps
            -- taking off keeps coming back, each time at a higher price. NULL
            -- never clobbers a known baseline, for the same reason as above.
            engagers_at_last_serve =
              COALESCE(EXCLUDED.engagers_at_last_serve, s.engagers_at_last_serve),
            best_position  = LEAST(s.best_position, EXCLUDED.best_position)`,
    [
      viewer,
      items.map((i) => i.postKey),
      items.map((i) => i.rankedKey),
      items.map((i) => i.engagers),
      items.map((i) => i.position)
    ]
  );
  return { written: result.rowCount ?? 0 };
}

export interface SeenRatioRow {
  viewer: string;
  distinctPosts: number;
  /** Rows of the pages that CHANGED, in the window (see `seenImpressionRatios`). */
  impressions: number;
  /** `impressions / distinctPosts` — THE guard number. */
  perPost: number;
  /** Every recorded delivery in the window, changed or not. */
  deliveries: number;
  /** Deliveries in the last 3 hours. The volume guard reads THIS, see below. */
  recentDeliveries: number;
}

/**
 * ★★★ THE GUARD'S PANEL — impressions per DISTINCT post, per viewer, last 24h.
 *
 * This exists because the failure it detects ALREADY SHIPPED AND RAN FOR SIX
 * DAYS: a 3-minute poll re-fetched page 1 through the recording path, the
 * counter read 31-40 impressions per distinct post for the three heaviest
 * viewers, and nothing anywhere said so. The reason nobody noticed is that
 * nobody had a reason to run the query. A number on a panel gets looked at.
 *
 * Under a rule that suppresses at 2 impressions, a reader cannot legitimately
 * see the same post more than a small handful of times a day. If this has not
 * fallen to a low single digit after the probe fix, the instrument is still
 * wrong and suppression MUST NOT be armed on top of it.
 *
 * One indexed aggregate per call. Intended for `/health` and for the
 * before/after measurement, not for the request path.
 */
/*
 * ★★★ MEASURED FROM THE SERVED LOG, ONE WINDOW, CHANGED PAGES ONLY (2026-09-24).
 *
 * This used to read `sum(impressions) / count(*)` from `lumen_feed_seen` over rows
 * touched in the window. Two things were wrong with that, both diagnosed in
 * LUMEN-DOCS/FEED-REPEATS-ROOT-CAUSE-2026-09-18.md and left unfixed until now:
 *
 *  1. `impressions` is a LIFETIME count (8-day TTL), so a "per day" ratio carried
 *     days of history: antisocialist read 7.11 from two deliveries in 24h.
 *  2. A reload inside the stored feed's freshness window returns the byte-identical
 *     page, and every such reload stamped all ~30 posts again. A person who opens
 *     home often therefore crossed 8 "per day" while the ranking could not move.
 *
 * The owner's account crossed it on 2026-09-15, got every seen row tainted, and
 * has had NO suppression since: recsys filters tainted rows out (seen_log.py), so
 * one post held #1 for 25-35 deliveries at a time. A tainted viewer's feed cannot
 * rotate, so the ratio could never fall and the sweep could never clear it.
 *
 * Now: impressions come from `lumen_feed_served` inside the window only, and a
 * delivery counts only when its page differs from the viewer's previous delivery.
 * Measured on production before this shipped (24h): owner 27 deliveries, 13
 * changed pages, 113 posts -> 10.15 old measure, 3.81 this one; every other
 * viewer 1.00-1.67. Suppression itself still counts every delivery (the reader did
 * see the page); only this guard stops treating an unchanged reload as evidence of
 * a broken recorder.
 *
 * ★ WHAT THE GUARD STILL CATCHES. The bug it was written for, a background poll
 * recording page 1 every 3 minutes, delivers identical pages, which this ratio no
 * longer counts. So the guard also bounds delivery VOLUME, over the last 3 hours
 * (`recentDeliveries`, see `hardRecentDeliveriesBound`). Not 24 hours: the served
 * log keeps only the newest 2,000 rows per viewer (`sweepServedFeeds`), so a poll's
 * 24h count is trimmed to ~44-66 deliveries and a daily bound would never fire;
 * 3 hours of it survives the trim.
 */
export async function seenImpressionRatios(withinHours = 24): Promise<SeenRatioRow[]> {
  const hours = Math.max(1, Math.trunc(withinHours));
  const { rows } = await query<{
    viewer: string;
    distinct_posts: string;
    impressions: string;
    deliveries: string;
    recent_deliveries: string;
  }>(
    `WITH pages AS (
       SELECT viewer, served_at,
              string_agg(post_key, ',' ORDER BY "position") AS sig,
              count(*) AS n
         FROM lumen_feed_served
        WHERE served_at > now() - ($1::int * INTERVAL '1 hour')
        GROUP BY viewer, served_at
     ), marked AS (
       SELECT viewer, n, served_at,
              sig IS DISTINCT FROM lag(sig) OVER (PARTITION BY viewer ORDER BY served_at) AS changed
         FROM pages
     ), per_viewer AS (
       SELECT viewer,
              COALESCE(sum(n) FILTER (WHERE changed), 0) AS impressions,
              count(*) AS deliveries,
              count(*) FILTER (WHERE served_at > now() - INTERVAL '3 hours') AS recent_deliveries
         FROM marked
        GROUP BY viewer
     ), posts AS (
       SELECT viewer, count(DISTINCT post_key) AS distinct_posts
         FROM lumen_feed_served
        WHERE served_at > now() - ($1::int * INTERVAL '1 hour')
        GROUP BY viewer
     )
     SELECT v.viewer, p.distinct_posts, v.impressions, v.deliveries, v.recent_deliveries
       FROM per_viewer v JOIN posts p USING (viewer)
      ORDER BY v.impressions::numeric / NULLIF(p.distinct_posts, 0) DESC`,
    [hours]
  );
  return rows.map((r) => {
    const distinctPosts = Number(r.distinct_posts) || 0;
    const impressions = Number(r.impressions) || 0;
    return {
      viewer: r.viewer,
      distinctPosts,
      impressions,
      perPost: distinctPosts === 0 ? 0 : impressions / distinctPosts,
      deliveries: Number(r.deliveries) || 0,
      recentDeliveries: Number(r.recent_deliveries) || 0
    };
  });
}

/** Over either hard bound: the viewer's recording is treated as broken. */
export function isOverHardBound(row: SeenRatioRow): boolean {
  return row.perPost > hardRatioBound() || row.recentDeliveries > hardRecentDeliveriesBound();
}

/**
 * ★★★ MARK A VIEWER'S AGGREGATE AS "DO NOT SUPPRESS".
 *
 * Set when the ratio above passes the hard bound — i.e. when something that is
 * not a reader is recording. `recsys/io/seen_log.py` filters tainted rows out of
 * the read entirely, so the viewer's feed silently reverts to the pre-suppression
 * one.
 *
 * ★ A COUNTER THAT HAS PROVABLY LOST ITS MEANING MUST STOP BEING A RANKING
 * INPUT, and the safe degrade is repetition, never an empty feed. This is the
 * direction that costs a reader a repeated post rather than a blank page.
 */
export async function markViewerTainted(viewer: string): Promise<number> {
  if (!viewer) return 0;
  const result = await query(
    `UPDATE lumen_feed_seen SET tainted = true
      WHERE viewer = $1 AND tainted = false`,
    [viewer]
  );
  return result.rowCount ?? 0;
}

/*
 * ★ THERE IS DELIBERATELY NO `seenPressure()` HELPER HERE (2026-08-15).
 *
 * "Distinct eligible posts remaining" — the starvation instrument the design
 * calls for — is published by the RANKER, once per build, at INFO:
 *
 *   seen: viewer=… eligible=… fresh=… repeats=… suppressed=… resurrected=…
 *         baseline_unknown=… exploration_exempt=… valve_fired=… floor=… served=…
 *
 * `fresh` IS the number, and it is live. A TypeScript twin of it here would have
 * to restate `suppress_after_impressions` — a threshold recsys owns — in a
 * second language, and two computations of the same ranking constant that can
 * disagree is the precise failure this package has already shipped twice with
 * engagement counts (`pipeline.py`, at `engagement_counts`).
 *
 * The durable operator query lives in `0036_feed_seen.sql`'s footer, where it
 * cannot drift from the schema it reads.
 */

export interface SeenSweepOptions {
  ttlDays: number;
}

export interface SeenSweepResult {
  expired: number;
  untainted: number;
}

/**
 * ★ THE SWEEP, AND WHY IT IS CHEAP.
 *
 * ONE indexed range delete on `lumen_feed_seen_last_idx (last_served_at)`. The
 * per-viewer index leads on `viewer`, so a global time predicate could not use
 * it and would seq-scan — which is exactly why the migration creates both.
 *
 * There is deliberately NO per-viewer row cap here, unlike the served log's
 * 2,000. This table is bounded by DISTINCT POSTS SEEN IN THE WINDOW — measured
 * at 50-66 for the three heaviest readers over six days — so a cap would be a
 * bound that never binds, and a cap that never binds is a cap that silently
 * starts binding the day traffic changes. The TTL is the whole bound.
 *
 * ★ THE UNTAINT PASS. `tainted` is set when a viewer's counter provably stopped
 * meaning anything. It must not be permanent: whatever was over-recording is
 * fixed by a deploy, not by the passage of time, but the ROWS that carry the bad
 * counts age out on the TTL — so a viewer whose window has rolled clean gets
 * suppression back. Clearing it here, on the same schedule, is what stops a
 * one-off spike costing a reader the feature forever.
 */
export async function sweepFeedSeen(opts: SeenSweepOptions): Promise<SeenSweepResult> {
  const ttlDays = Math.max(1, Math.trunc(opts.ttlDays));

  const expired = await query(
    // Interval built from an integer we just clamped and multiplied server-side,
    // never string-concatenated into the SQL.
    `DELETE FROM lumen_feed_seen WHERE last_served_at < now() - ($1::int * INTERVAL '1 day')`,
    [ttlDays]
  );

  // ★ THE SAME MEASURE AS THE GUARD (2026-09-24). This had its own copy of the
  // old lifetime-count ratio, so fixing the guard alone would still have left a
  // tainted reader tainted. One function decides both "taint" and "clear".
  const stillOver = (await seenImpressionRatios(24)).filter(isOverHardBound).map((r) => r.viewer);
  const untainted = await query(
    `UPDATE lumen_feed_seen SET tainted = false
      WHERE tainted = true
        AND NOT (viewer = ANY($1::text[]))`,
    [stillOver]
  );

  return {
    expired: expired.rowCount ?? 0,
    untainted: untainted.rowCount ?? 0
  };
}

/**
 * Above this many impressions per DISTINCT post per day, a viewer's counter has
 * provably stopped measuring a reader.
 *
 * ★ THIS NUMBER IS CHOSEN, NOT MEASURED, AND SAYS SO. It is anchored on the rule
 * itself — a post suppressed after 2 impressions cannot legitimately reach 4 in
 * a day, and 8 is a doubling of that — but the post-probe-fix distribution does
 * not exist yet, because the probe fix landed today. Take the distribution from
 * `seenImpressionRatios` after a week of the corrected instrument and replace
 * this. Treat the current value as a placeholder with a loud failure mode, not
 * as a measurement.
 */
export function hardRatioBound(): number {
  const raw = Number(process.env.FEED_SEEN_HARD_IMPRESSIONS_PER_POST_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

/** The WARN bound — logged, never acted on. See `hardRatioBound`. */
export function warnRatioBound(): number {
  const raw = Number(process.env.FEED_SEEN_MAX_IMPRESSIONS_PER_POST_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

/**
 * Above this many recorded deliveries in 3 hours, something that is not a person is
 * asking for the feed. Measured on production 2026-09-24 over every viewer's retained
 * served log: the most any real reader had in any 3 hours was 13 (the owner; next
 * 8). A 3-minute poll records 60 in 3 hours, and still 44 after the 2,000-row trim
 * with 45-post pages. 30 sits above the first with a 2x margin and below the second.
 */
export function hardRecentDeliveriesBound(): number {
  const raw = Number(process.env.FEED_SEEN_HARD_DELIVERIES_PER_3H);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}
