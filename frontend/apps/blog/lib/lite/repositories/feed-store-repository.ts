// TYPE-ONLY on purpose: a lite repository has no business pulling the wax
// runtime into its module graph just to name the shape it stores.
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { query } from '../db/pool';

/**
 * DURABLE per-viewer ranked feeds (table `lumen_feed_store`, migration 0026).
 *
 * ★ WHY A TABLE AND NOT A MAP. The assembled feed used to live in an in-process
 * `Map` in `lib/feed/feed-cache.ts`. Measured 2026-08-08, a cold ranked build
 * costs 7.2s (steevc) to 16.3s (lordbutterfly), and recsys's own viewer cache
 * expires after 300s — so every deploy, restart or crash sent every reader back
 * to the full cold cost, and a reader returning the next day paid it again. The
 * owner's requirement is that the wait happens ONCE, ever. Only something that
 * outlives the process can deliver that.
 *
 * Rebuildable by definition: losing this table costs latency, never data. That
 * is what licenses the blunt bounds below (`sweepStoredFeeds`) — a cache is
 * allowed to forget, and one that cannot is a disk-space bug waiting to happen.
 */

/**
 * WHICH LANE PUT THIS POST ON THE PAGE, and what it scored.
 *
 * ★ THE ANSWER THE STORE USED TO THROW AWAY (2026-08-08, ruling §7). recsys
 * returns a `source` per post — `in_network`, `oon_interest`, `oon_engaged`,
 * `exploration`, `popular_fallback`, … — and a score decomposition whose
 * `final` is the number that ordered the page. Both existed ONLY inside the
 * transient HTTP response: string-matching every stored row showed
 * `has_oon_interest = f`, `has_in_network = f`, `has_exploration = f`. Nobody
 * could say what a feed had CONTAINED, and the weekly balance probe was making
 * eight live 8-35s HTTP calls to rediscover it.
 *
 * Kept in its own `lanes` column rather than inside `entries` — see migration
 * 0027 for the argument, of which the load-bearing half is that `entries` is a
 * ~287KB TOAST-compressed blob and a lane query must never have to de-TOAST it.
 */
export interface FeedLane {
  /** `author/permlink`, the same form as `keys`. */
  key: string;
  /** The recsys lane, or null when recsys did not name one for this post. */
  source: string | null;
  /** `score.final` — the number that decided the order. */
  score: number;
  /** 0-based position in the BUILT page (the served position can differ). */
  rank: number;
}

export interface StoredFeed {
  viewer: string;
  /** FEED_STORE_VERSION at build time — see `sweepStoredFeeds` and feed-cache.ts. */
  feedVersion: string;
  /** How many posts recsys said it ranked, carried through verbatim. */
  ranked: number;
  /** The `limit` this copy was assembled for. */
  builtLimit: number;
  /** The ranked order, as `author/permlink`. */
  keys: string[];
  /** The assembled feed, exactly as the route serves it. */
  entries: Entry[];
  /** Parallel to `keys`: which lane surfaced each post, and what it scored. */
  lanes: FeedLane[];
  builtAt: Date;
}

interface Row {
  viewer: string;
  feed_version: string;
  ranked: number;
  built_limit: number;
  keys: unknown;
  entries: unknown;
  lanes: unknown;
  built_at: Date;
}

/**
 * Read the lane array back defensively.
 *
 * ★ EVERY ROW WRITTEN BEFORE MIGRATION 0027 HAS `[]` HERE, and that is a
 * supported state, not a corrupt one — the column defaults to `[]` precisely so
 * that no `feed_version` bump (and therefore no rebuild for every reader) is
 * needed to introduce it. A lane-less row still serves, and the serve log
 * records its posts with `source: null` until the row's next ordinary rebuild.
 */
function mapLanes(raw: unknown): FeedLane[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedLane[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const lane = item as { key?: unknown; source?: unknown; score?: unknown; rank?: unknown };
    if (typeof lane.key !== 'string' || lane.key.length === 0) continue;
    out.push({
      key: lane.key,
      source: typeof lane.source === 'string' && lane.source ? lane.source : null,
      score: Number(lane.score) || 0,
      rank: Number(lane.rank) || 0
    });
  }
  return out;
}

function mapRow(r: Row): StoredFeed {
  return {
    viewer: r.viewer,
    feedVersion: r.feed_version,
    ranked: Number(r.ranked) || 0,
    builtLimit: Number(r.built_limit) || 0,
    // Defensive on all three JSONB columns: a hand-edited or half-written row
    // must degrade to "nothing stored" (the reader rebuilds) rather than throw
    // on the serve path and take the whole feed down with it.
    keys: Array.isArray(r.keys) ? (r.keys as string[]) : [],
    entries: Array.isArray(r.entries) ? (r.entries as Entry[]) : [],
    lanes: mapLanes(r.lanes),
    builtAt: r.built_at
  };
}

export async function findStoredFeed(viewer: string): Promise<StoredFeed | null> {
  if (!viewer) return null;
  const { rows } = await query<Row>(
    `SELECT viewer, feed_version, ranked, built_limit, keys, entries, lanes, built_at
       FROM lumen_feed_store
      WHERE viewer = $1`,
    [viewer]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface PutStoredFeedInput {
  viewer: string;
  feedVersion: string;
  ranked: number;
  builtLimit: number;
  keys: string[];
  entries: Entry[];
  /** Optional so a caller with no lane information writes `[]`, never garbage. */
  lanes?: FeedLane[];
}

/**
 * Upsert one viewer's feed. `built_at` is stamped to now() on every write —
 * this row IS the freshness clock, so an update that kept an old timestamp
 * would make a brand-new build look stale and rebuild forever.
 */
export async function putStoredFeed(input: PutStoredFeedInput): Promise<void> {
  await query(
    `INSERT INTO lumen_feed_store (viewer, feed_version, ranked, built_limit, keys, entries, lanes, built_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
     ON CONFLICT (viewer) DO UPDATE
          SET feed_version = EXCLUDED.feed_version,
              ranked       = EXCLUDED.ranked,
              built_limit  = EXCLUDED.built_limit,
              keys         = EXCLUDED.keys,
              entries      = EXCLUDED.entries,
              lanes        = EXCLUDED.lanes,
              built_at     = now()`,
    [
      input.viewer,
      input.feedVersion,
      input.ranked,
      input.builtLimit,
      JSON.stringify(input.keys),
      JSON.stringify(input.entries),
      // `lanes` is written on EVERY upsert, including as `[]`. Leaving the old
      // array in place on a rebuild would be worse than having none: the lanes
      // would describe a page that is no longer stored, and every composition
      // query would silently report the previous build's balance as this one's.
      JSON.stringify(input.lanes ?? [])
    ]
  );
}

/**
 * Hard-retire one viewer's stored feed.
 *
 * Used when something that FEEDS the ranking changed underneath it — today,
 * saving new interests. Deliberately a DELETE and not a staleness flag: a
 * stale row is still served instantly (that is the whole design), and serving a
 * reader the feed built from the preferences they just replaced is precisely the
 * bug that made "Tune your feed" look dead. After this, the viewer has nothing
 * stored, so they rebuild — behind the picker's own spinner, where they have
 * already been told their feed is being built.
 */
export async function deleteStoredFeed(viewer: string): Promise<void> {
  if (!viewer) return;
  await query('DELETE FROM lumen_feed_store WHERE viewer = $1', [viewer]);
}

export interface SweepOptions {
  /** Drop feeds not rebuilt in this many days. */
  ttlDays: number;
  /** Keep at most this many rows, newest `built_at` first. */
  maxRows: number;
  /**
   * When set, also drop every row whose `feed_version` differs — the HARD
   * retire for a weight change so large that serving the previous order once is
   * worse than a spinner. Off by default: the owner's stated bar for a weight
   * change is that the update be INVISIBLE, and the soft path (serve the old
   * copy, rebuild behind the reader) is what delivers that.
   */
  purgeOtherVersions?: string;
}

export interface SweepResult {
  expired: number;
  overCap: number;
  wrongVersion: number;
}

/**
 * Bound the table. Two independent limits, because they fail differently:
 *
 *   TTL      a feed nobody has come back for in `ttlDays` is worthless — the
 *            posts in it have paid out and the ranker has moved on entirely.
 *   ROW CAP  the backstop for the case the TTL cannot cover: a lot of readers
 *            inside the window. At the measured ~287KB/row (limit=20) the
 *            default 5,000 keeps this near 1.4GB.
 *
 * Cheap enough to run inline after a build, and throttled by the caller so it
 * runs at most once every few minutes per process.
 */
export async function sweepStoredFeeds(opts: SweepOptions): Promise<SweepResult> {
  const ttlDays = Math.max(1, Math.trunc(opts.ttlDays));
  const maxRows = Math.max(1, Math.trunc(opts.maxRows));

  const expired = await query(
    // Interval built from an integer we just clamped, multiplied server-side —
    // never string-concatenated into the SQL.
    `DELETE FROM lumen_feed_store WHERE built_at < now() - ($1::int * INTERVAL '1 day')`,
    [ttlDays]
  );

  const overCap = await query(
    `DELETE FROM lumen_feed_store
      WHERE viewer IN (
        SELECT viewer FROM lumen_feed_store ORDER BY built_at DESC OFFSET $1
      )`,
    [maxRows]
  );

  let wrongVersion = 0;
  if (opts.purgeOtherVersions) {
    const purged = await query('DELETE FROM lumen_feed_store WHERE feed_version <> $1', [
      opts.purgeOtherVersions
    ]);
    wrongVersion = purged.rowCount ?? 0;
  }

  return {
    expired: expired.rowCount ?? 0,
    overCap: overCap.rowCount ?? 0,
    wrongVersion
  };
}
