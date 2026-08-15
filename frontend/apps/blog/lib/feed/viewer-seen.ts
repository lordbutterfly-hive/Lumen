import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '@/blog/lib/lite/config';
import { query } from '@/blog/lib/lite/db/pool';

const logger = getLogger('app');

/**
 * ★★★ "WHEN WAS THIS READER HERE" — the warmer's activity signal, and the ONE
 * table it is allowed to come from (2026-08-15, table `lumen_feed_viewer_seen`,
 * migration 0035).
 *
 * The full argument for why this is a new table rather than a reuse of
 * `built_at` (self-poisoning: the warmer writes it) or of `lumen_feed_served`
 * (activity is not an impression) is in the migration, which is where a reader
 * looking at the schema will be. The short version, because it governs every
 * function in this file:
 *
 *   `lumen_feed_served`      what was this reader SHOWN — a delivered post
 *   `lumen_feed_viewer_seen` when was this reader HERE   — a foreground request
 *
 * ★★★ THE BOUNDARY THAT MUST NOT MOVE. Nothing in this module writes to, reads
 * from, or imports the served log, and nothing in the warm path may. A later
 * feature suppresses a post after it has been served twice; a warm build that
 * recorded serves would mark a whole page seen for a reader who saw none of it,
 * and two warm cycles would suppress a reader's entire feed before they ever
 * opened the app.
 */

/** What a foreground request knows about the viewer, from the sealed session. */
export interface ViewerSeenInput {
  viewer: string;
  isLite: boolean;
  /** Empty for a Hive-keyed reader — stored as NULL. */
  userId: string;
}

/** A viewer the warmer may rebuild, with the identity the session resolved. */
export interface WarmCandidate {
  viewer: string;
  isLite: boolean;
  userId: string;
}

function storeEnabled(): boolean {
  return Boolean(liteConfig.databaseUrl);
}

/**
 * ★ THE ACTIVITY LOG IS ONLY WRITTEN WHEN SOMETHING READS IT.
 *
 * Added 2026-08-15 after a regression sweep caught this against the live DB: a
 * fresh lite account created on the CONTROL app — every feed flag unset — still
 * landed a `lumen_feed_viewer_seen` row after a single `/api/feed/for-you` call.
 * `storeEnabled()` alone is not a feature gate; `liteConfig.databaseUrl` is
 * baseline config for lite accounts generally, so "flags off" deployments were
 * taking a new per-request Postgres write with no way to turn it off.
 *
 * And nothing read it. This table has exactly one consumer chain —
 * `listViewersToWarm` and `sweepViewerSeen`, both called only from
 * `viewer-warmer.ts`, which is itself gated on `FEED_WARM_ENABLED === 'yes'`.
 * With the warmer off the rows accumulated for no reader at all.
 *
 * The flag is read here rather than imported from `viewer-warmer.ts` on
 * purpose: that module imports FROM this one, so depending on it back would be
 * a cycle. Both spellings must stay in step — see `warmConfig()` there.
 */
function warmerWantsActivityLog(): boolean {
  return (process.env.FEED_WARM_ENABLED || '').toLowerCase() === 'yes';
}

/**
 * Record that this viewer was here, on THIS request.
 *
 * ★ SYNCHRONOUS SIGNATURE, DETACHED WRITE — deliberately the same shape as
 * `recordFeedServe` and `invalidateViewerFeed`. A reader must never wait on
 * telemetry and an activity-log outage must never cost a feed, so the caller
 * does not await this and a failure is logged rather than thrown at nobody.
 *
 * ★ CALLED ON EVERY FOREGROUND BRANCH, WHICH IS THE ENTIRE POINT. The one call
 * site sits above the branch tree in `serveForYou`, before the paging and topic
 * early returns, for the same reason the block filter lives in a wrapper: this
 * route answers from six places and a branch that forgets does not fail loudly.
 * If this were hooked to the personal-ranked branches only it would inherit
 * exactly the blindness it exists to cure — those are the branches a stale
 * reader never reaches.
 *
 * ★ AND NOT ON A MACHINE POLL. The caller withholds it for `probe=1` requests;
 * see the note on the probe flag in the route. One rule, one meaning: a probe
 * is not a reader looking at a page, so it records neither an impression nor a
 * visit. The cost of that choice is bounded and self-correcting — a reader whose
 * only contact in the whole active window was a background poll is not warmed
 * until they actually load the page again, and the load itself re-marks them.
 */
export function noteViewerSeen(input: ViewerSeenInput): void {
  const { viewer, isLite, userId } = input;
  if (!viewer || !storeEnabled() || !warmerWantsActivityLog()) return;

  void query(
    `INSERT INTO lumen_feed_viewer_seen (viewer, last_seen_at, is_lite, user_id)
          VALUES ($1, now(), $2, $3)
     ON CONFLICT (viewer) DO UPDATE
          SET last_seen_at = now(),
              -- Re-stamped on every visit rather than left at its first value: a
              -- lite reader who upgrades to a Hive account keeps the same viewer
              -- string (their handle), and a warm build using the stale tier
              -- would rank them through the wrong branch of collectViewerState
              -- for as long as the row survived.
              is_lite     = EXCLUDED.is_lite,
              user_id     = EXCLUDED.user_id`,
    [viewer, isLite, userId || null]
  ).catch((error) => logger.warn('viewer-seen: upsert failed for %s: %o', viewer, error));
}

export interface WarmSelection {
  /** How recently a viewer must have been here to be worth warming. */
  activeMs: number;
  /** Only rebuild a row older than this (or missing entirely). */
  warmAfterMs: number;
  /** Hard ceiling on how many viewers one cycle may take. */
  batch: number;
}

interface CandidateRow {
  viewer: string;
  is_lite: boolean;
  user_id: string | null;
}

/**
 * The viewers one warm cycle should rebuild, most-recently-active first.
 *
 * ★ `built_at IS NULL` IS DELIBERATE, and it is what makes the "trending now,
 * ranked on your next load" promise real rather than aspirational: a viewer who
 * has been here but has NO stored row is exactly the first-visit case, and they
 * are the ones the patience cut hands a trending page to.
 *
 * ★ ORDER BY last_seen_at DESC — the reader most likely to return next is the
 * one who was just here. With a batch smaller than the backlog this is also what
 * stops a cycle spending its whole budget on the least likely returner.
 *
 * Index-supported on both sides: `lumen_feed_viewer_seen_recent_idx` for the
 * window and the ordering, `lumen_feed_store`'s primary key for the join.
 */
export async function listViewersToWarm(opts: WarmSelection): Promise<WarmCandidate[]> {
  if (!storeEnabled()) return [];
  const activeMs = Math.max(1, Math.trunc(opts.activeMs));
  const warmAfterMs = Math.max(0, Math.trunc(opts.warmAfterMs));
  const batch = Math.max(0, Math.trunc(opts.batch));
  if (batch === 0) return [];

  const { rows } = await query<CandidateRow>(
    `SELECT s.viewer, s.is_lite, s.user_id
       FROM lumen_feed_viewer_seen s
       LEFT JOIN lumen_feed_store f ON f.viewer = s.viewer
      WHERE s.last_seen_at > now() - ($1::bigint * INTERVAL '1 millisecond')
        AND (f.built_at IS NULL OR f.built_at < now() - ($2::bigint * INTERVAL '1 millisecond'))
      ORDER BY s.last_seen_at DESC
      LIMIT $3`,
    [activeMs, warmAfterMs, batch]
  );

  return rows.map((r) => ({
    viewer: r.viewer,
    isLite: Boolean(r.is_lite),
    userId: r.user_id ?? ''
  }));
}

/**
 * Drop rows for viewers nobody has seen in `ttlDays`.
 *
 * They can never be selected again — the active window is measured in hours —
 * so this is pure bookkeeping, and it exists because a structure that is only
 * ever written to is real growth on a long-lived process. Same argument as
 * `pruneGenerations` in feed-cache.ts, which was added after exactly that was
 * missed once already.
 */
export async function sweepViewerSeen(ttlDays: number): Promise<number> {
  if (!storeEnabled()) return 0;
  const days = Math.max(1, Math.trunc(ttlDays));
  const result = await query(
    // Interval built from an integer we just clamped and multiplied server-side,
    // never string-concatenated into the SQL.
    `DELETE FROM lumen_feed_viewer_seen WHERE last_seen_at < now() - ($1::int * INTERVAL '1 day')`,
    [days]
  );
  return result.rowCount ?? 0;
}

/**
 * Forget one viewer's activity record. Not called by the feed today; it is the
 * erasure hook a per-user delete needs, and a log of when a named person was
 * here must have one from the day it is created.
 */
export async function deleteViewerSeen(viewer: string): Promise<number> {
  if (!viewer || !storeEnabled()) return 0;
  const result = await query('DELETE FROM lumen_feed_viewer_seen WHERE viewer = $1', [viewer]);
  return result.rowCount ?? 0;
}
