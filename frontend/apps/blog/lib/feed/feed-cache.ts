import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '@/blog/lib/lite/config';
import {
  deleteStoredFeed,
  findStoredFeed,
  putStoredFeed,
  sweepStoredFeeds
} from '@/blog/lib/lite/repositories/feed-store-repository';
import type { FeedLane } from '@/blog/lib/lite/repositories/feed-store-repository';
import {
  recordServedPage,
  sweepServedFeeds,
  type ServedItem
} from '@/blog/lib/lite/repositories/feed-served-repository';

export type { FeedLane };

const logger = getLogger('app');

/**
 * The per-viewer ranked-feed cache: process memory in front of a DURABLE
 * Postgres store (`lumen_feed_store`, migration 0026).
 *
 * ★ WHY IT MOVED OUT OF THE ROUTE (2026-08-08). A Next route file may export
 * only route handlers, so while this lived inside `/api/feed/for-you` there was
 * no way for anything else to invalidate it. Saving new interests relied on the
 * BROWSER remembering to re-request with `?refresh=1` — and a tester walked the
 * real "Tune your feed" flow, watched the save succeed in the database, and got
 * the pre-change feed back marked `cache: fresh`. From the reader's chair, the
 * picker did nothing. The server changes the preference, so the server drops the
 * feed: see `invalidateViewerFeed`.
 *
 * ★★★ WHY IT NOW HAS A SECOND TIER (2026-08-08). The Map alone could not meet
 * the owner's actual requirement — "it can load once, for as long as needed...
 * but then it cannot load every time. it has to be instantly accessible." A
 * process-local Map dies on every deploy and restart, and recsys's own viewer
 * cache expires after 300s, so the reader who came back later paid the FULL cold
 * cost again: measured today 7.2s (steevc), 9.3s (melinda010100), 13.2s (gtg),
 * 16.3s (lordbutterfly). "Load once" has to mean once, so the assembled feed is
 * written to Postgres, and memory becomes what it should always have been — a
 * round-trip saver in front of the real store, not the store itself.
 *
 * The two tiers report themselves separately (`origin`), because a response
 * served from disk after a restart is a different claim than one served from a
 * warm process, and the route says which it was.
 *
 * HONEST LIMIT, unchanged from the previous note: single-flight and the memory
 * tier are per-process. On a multi-process deployment N processes can each hold
 * a copy and each start one rebuild. The DURABLE tier is shared, so the
 * expensive part (a cold build) still happens roughly once — but strict
 * cross-process single-flight would need an advisory lock, and this deployment
 * is single-process.
 */

export interface CachedFeed {
  entries: Entry[];
  /** The ranked count recsys reported. */
  ranked: number;
  /** `built_at`, as epoch ms. */
  at: number;
  /** The `limit` this copy was assembled for. */
  builtLimit: number;
  /** FEED_STORE_VERSION at build time. */
  version: string;
  /** Which tier answered — reported to the client, never guessed. */
  origin: 'memory' | 'store';
  /**
   * Which lane surfaced each post, parallel to `entries` by KEY (not by index —
   * the serve path re-filters and re-slices, so index parity does not survive).
   * Empty for a row stored before migration 0027; see `recordFeedServe`.
   */
  lanes: FeedLane[];
}

/**
 * Under this age a stored feed is served with no upstream work at all. Over it,
 * it is STILL SERVED INSTANTLY and rebuilt behind the reader.
 */
export const FEED_FRESH_MS = 5 * 60_000;

/**
 * ★★★ THE AGE AT WHICH A STORED FEED STOPS COUNTING AS A RANKING (2026-08-14).
 *
 * MEASURED, signed in as `lordbutterfly`, against the running build: page 1 came
 * back `source:"recsys" ranked:45 served:30 cache:"stale-revalidating"` with
 * `builtAt:"2026-08-11T01:58:53.011Z"` — 71.4 HOURS old — and `builtAt` did not
 * move across four calls in eighteen seconds. Newest post in the set 73.9h,
 * median 98.0h. The same box, logged OUT, answered `trending-fallback` with a
 * newest post of 1.6h and a median of 15.0h. **The signed-in owner's feed was
 * three days old and a stranger's was current.**
 *
 * ★ WHY THE ROUTE COULD NOT SEE IT. The stored branch labels every copy
 * `source: 'recsys'` regardless of age, and the client's banner reads exactly
 * `source === 'recsys' ? null : …`. So the one signal that a ranking is three
 * days stale — `builtAt`, sitting in the same payload — was serialised, sent,
 * and read by nobody. A frozen artifact was indistinguishable from a fresh one
 * to every consumer.
 *
 * ★★ WHY THIS IS NOT THE `FEED_STALE_MS` THE OWNER DELETED. The comment that
 * stood here said "THERE IS DELIBERATELY NO UPPER SERVING CUTOFF ANY MORE",
 * because the old 24h cliff made the route rebuild SYNCHRONOUSLY past it — the
 * reader who came back after a day sat through the full 7-16s cold build again.
 * That is the behaviour the owner rejected, and it is NOT what this
 * reintroduces. Past this ceiling the reader waits for NOTHING: they are served
 * the trending fallback, which is cached and measured in milliseconds, while the
 * ranked rebuild continues behind them exactly as before. The rule the owner
 * actually set — "once a viewer has a stored feed they are never made to wait
 * again" — is intact. What changes is only WHAT a hopelessly old artifact is
 * called and whether it is still passed off as this reader's live ranking.
 *
 * ★ TWO HOURS, and env-tunable. Long enough that the ordinary
 * stale-while-revalidate window (`FEED_FRESH_MS` → here) still absorbs a ranker
 * that is briefly slow, restarting, or rate-limited, so a healthy deployment
 * never sees this path. Short enough that "my feed is yesterday's" cannot happen
 * silently. The failure this closes is unbounded by nature — a dead upstream
 * produces a stale flag that no amount of waiting clears — so the ceiling has to
 * be an absolute one, not a multiple of the refresh interval.
 */
export function feedStaleMs(): number {
  const raw = Number(process.env.FEED_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 60_000;
}

/** Memory tier size. The durable tier's bound is FEED_STORE_MAX_ROWS. */
const FEED_MAX_VIEWERS = 5_000;

/**
 * Stamp every stored feed with this, and treat a mismatch as STALE.
 *
 * ★ THE INVALIDATION HOOK THE WEIGHT CHANGE NEEDS. Viewer-affinity is being
 * switched on in the ranker right now, which means stored feeds go stale in
 * CONTENT while `built_at` still looks recent. Bumping FEED_STORE_VERSION
 * retires all of them at once, with no migration and no truncate.
 *
 * Mismatch is SOFT on purpose — the old copy is still served instantly and
 * rebuilt behind the reader — because the owner's bar for a weight change is
 * "those slight updates should be invisible", and a spinner is the opposite of
 * invisible. Set FEED_STORE_PURGE_OLD_VERSIONS=yes for the hard version.
 */
export function feedVersion(): string {
  return process.env.FEED_STORE_VERSION || 'v1';
}

/** Is the durable tier usable at all? Absent DB = memory-only, never a crash. */
function storeEnabled(): boolean {
  return Boolean(liteConfig.databaseUrl);
}

const feedCache = new Map<string, CachedFeed>();

/* ------------------------------------------------------------------ */
/* Durable-write ordering                                              */
/* ------------------------------------------------------------------ */

/**
 * One in-order chain of durable mutations per viewer, plus a tombstone for the
 * window in which a delete is still queued.
 *
 * ★ WHY THIS EXISTS AT ALL. `invalidateViewerFeed` must stay SYNCHRONOUS (its
 * caller does not await it), so its durable DELETE is detached — and two
 * detached operations against the same row have no defined order. Two concrete
 * ways that bites, both of which reinstate the "Tune your feed did nothing" bug
 * in DURABLE storage rather than in a Map:
 *
 *   1. Invalidate then rebuild: the rebuild's INSERT lands first and the queued
 *      DELETE then wipes the feed that was just built correctly.
 *   2. Invalidate then read: a concurrent request reads the not-yet-deleted row
 *      and PROMOTES it back into memory, where it will be served as `fresh` for
 *      the next five minutes — built from the interests the reader replaced.
 *
 * Chaining fixes (1): operations run in call order. The tombstone fixes (2):
 * while a delete is outstanding, the store is treated as already empty.
 */
const durableChain = new Map<string, Promise<void>>();
const pendingInvalidation = new Set<string>();

function enqueueDurable(viewer: string, op: () => Promise<void>): Promise<void> {
  const previous = durableChain.get(viewer) ?? Promise.resolve();
  const next = previous.then(op).catch((error) => {
    logger.warn('feed-cache: durable operation failed for %s: %o', viewer, error);
  });
  durableChain.set(viewer, next);
  void next.finally(() => {
    if (durableChain.get(viewer) === next) durableChain.delete(viewer);
  });
  return next;
}

function memoryPut(viewer: string, feed: CachedFeed): void {
  if (!feedCache.has(viewer) && feedCache.size >= FEED_MAX_VIEWERS) {
    const oldest = feedCache.keys().next().value;
    if (oldest !== undefined) feedCache.delete(oldest);
  }
  feedCache.set(viewer, feed);
}

/**
 * Read a viewer's feed: memory first, then the durable store.
 *
 * A store hit is promoted into memory so the round-trip is paid once per process
 * per viewer, not once per request — the rows are hundreds of KB.
 */
export async function readViewerFeed(viewer: string): Promise<CachedFeed | undefined> {
  if (!viewer) return undefined;

  const hot = feedCache.get(viewer);
  if (hot) return hot;

  if (!storeEnabled()) return undefined;
  // A delete is queued for this viewer: whatever is still on disk is retired,
  // and reading it would promote a superseded feed straight back into memory.
  if (pendingInvalidation.has(viewer)) return undefined;

  const era = viewerGeneration(viewer);
  try {
    const stored = await findStoredFeed(viewer);
    if (!stored || stored.entries.length === 0) return undefined;
    // The read straddled an invalidation — the row we just fetched belongs to an
    // era the reader has already left.
    if (viewerGeneration(viewer) !== era || pendingInvalidation.has(viewer)) return undefined;
    const feed: CachedFeed = {
      entries: stored.entries,
      ranked: stored.ranked,
      at: stored.builtAt.getTime(),
      builtLimit: stored.builtLimit,
      version: stored.feedVersion,
      origin: 'store',
      lanes: stored.lanes
    };
    // ★ `origin` describes THIS read, not the feed's ancestry. The promoted copy
    // is stamped `memory` because every read after this one is answered by the
    // Map — leaving it as `store` made a 50ms in-process hit report itself as a
    // database round-trip for the rest of the process's life, which is a lie in
    // the direction that makes the system look slower than it is. Caught by
    // running it: three consecutive requests all claimed `stored-fresh`.
    memoryPut(viewer, { ...feed, origin: 'memory' });
    return feed;
  } catch (error) {
    // A store outage must cost latency, never the feed. The caller falls through
    // to a build exactly as it would for a first-time viewer.
    logger.warn('feed-cache: durable read failed for %s: %o', viewer, error);
    return undefined;
  }
}

/**
 * What `writeViewerFeed` needs.
 *
 * ★ `startedAtGeneration` IS NOT OPTIONAL DECORATION. Builds now outlive the
 * request that started them (that is the whole point — see `buildOnce`), which
 * opens a race the in-process Map never had: a rebuild kicked off by a page load
 * can still be running when the reader saves new interests, and would then
 * write a feed built from the preferences they just REPLACED — resurrecting, in
 * durable storage this time, the exact "Tune your feed did nothing" bug this
 * module's header was written about. A build stamps the generation it started
 * in; `invalidateViewerFeed` bumps it; a stamped write from a superseded
 * generation is dropped on the floor.
 */
export interface WriteViewerFeedInput {
  viewer: string;
  entries: Entry[];
  ranked: number;
  builtLimit: number;
  /**
   * Which lane surfaced each post, and what it scored. Required rather than
   * optional ON PURPOSE: the whole point of ruling §7 is that this was being
   * dropped silently, and an optional field is a field that gets forgotten by
   * the next caller. Pass `[]` deliberately if you genuinely have none.
   */
  lanes: FeedLane[];
  startedAtGeneration?: number;
}

/**
 * Persist a freshly assembled feed to BOTH tiers.
 *
 * Memory is written first and synchronously, so the request that triggered the
 * build can be answered from it even if Postgres is slow or down.
 *
 * (Object argument since 2026-08-08: with `lanes` there are five values plus a
 * fence, and a positional list that long is a place for a caller to quietly
 * transpose two of them.)
 */
export async function writeViewerFeed(input: WriteViewerFeedInput): Promise<void> {
  const { viewer, entries, ranked, builtLimit, lanes, startedAtGeneration } = input;
  if (!viewer) return;
  if (startedAtGeneration !== undefined && startedAtGeneration !== viewerGeneration(viewer)) {
    logger.info(
      'feed-cache: discarding a superseded build for %s (built in generation %d, now %d)',
      viewer,
      startedAtGeneration,
      viewerGeneration(viewer)
    );
    return;
  }
  const version = feedVersion();
  memoryPut(viewer, {
    entries,
    ranked,
    at: Date.now(),
    builtLimit,
    version,
    origin: 'memory',
    lanes
  });

  if (!storeEnabled()) return;
  // Queued behind any outstanding DELETE for this viewer, so a rebuild that
  // finishes while an invalidation is still in flight cannot be wiped by it.
  await enqueueDurable(viewer, async () => {
    await putStoredFeed({
      viewer,
      feedVersion: version,
      ranked,
      builtLimit,
      keys: entries.map((e) => `${e.author}/${e.permlink}`),
      entries,
      lanes
    });
    void maybeSweep();
  });
}

/* ------------------------------------------------------------------ */
/* The served log                                                      */
/* ------------------------------------------------------------------ */

/**
 * ★★★ RECORD WHAT A READER WAS ACTUALLY SHOWN (2026-08-08, ruling §7).
 *
 * Measured that night: two consecutive /feed calls returned a BYTE-IDENTICAL top
 * 20, and 19-20 of 20 posts survive to tomorrow. A reader who opens the app
 * three times a day gets zero new information on visits 2 and 3, and every
 * discovery budget in §7 ("4 slots for popularity, 2 for newcomers") is really a
 * budget for ONE PAGE A DAY. Nothing recorded it, so nothing could see it.
 *
 * ★ CALLED ON SERVE, NOT ON BUILD, AND THAT IS THE WHOLE DESIGN. A feed
 * assembled in the background and never delivered was not seen by anyone — the
 * route starts builds that outlive the request precisely so a reader who gave up
 * still gets a stored feed, and counting those as impressions would demote posts
 * nobody ever laid eyes on. Conversely the CACHED and STALE-REVALIDATING serves
 * are the common case by a wide margin, and a hook that missed them would
 * undercount exactly the readers who come back most often. So: every delivery of
 * the personal ranked page, and only deliveries.
 *
 * ★ SYNCHRONOUS SIGNATURE, DETACHED WRITE. The items are captured from the array
 * that is about to be serialised, so the record cannot drift from the response;
 * the insert itself is detached because a reader must never wait on telemetry,
 * and a log outage must never cost a feed. Same posture as
 * `invalidateViewerFeed`, and it relies on the same property of this deployment
 * that the whole first-build design already relies on — a long-running Node
 * process where work continues after a response is returned.
 *
 * `lanes` is looked up BY KEY, never by index: the serve path filters banned
 * authors and re-slices to the requested limit, so the position a reader saw is
 * not the position the build gave it. A post with no lane is still recorded,
 * with `source: null` — an unknown lane must never cost an impression count.
 */
export function recordFeedServe(viewer: string, entries: Entry[], lanes: FeedLane[]): void {
  if (!viewer || entries.length === 0 || !storeEnabled()) return;

  const laneByKey = new Map(lanes.map((lane) => [lane.key, lane]));
  const items: ServedItem[] = entries.map((entry, index) => {
    const key = `${entry.author}/${entry.permlink}`;
    return { postKey: key, position: index, source: laneByKey.get(key)?.source ?? null };
  });

  void recordServedPage({ viewer, items, minIntervalMs: servedMinIntervalMs() })
    .then((result) => {
      if (result.recorded > 0) void maybeSweepServed();
    })
    .catch((error) => logger.warn('feed-cache: served-log write failed for %s: %o', viewer, error));
}

/**
 * Below this gap since the viewer's last recorded page, a serve is not recorded
 * again.
 *
 * ★ IT REJECTS MACHINE NOISE, NOT READING. A component remount, a React
 * StrictMode double-render or a window-focus refetch can fire several requests
 * inside a second and not one of them is a person looking at the page; a human
 * does not consume two DISTINCT feed pages inside a minute. It deliberately does
 * NOT dedupe by content: two identical pages ten minutes apart are two
 * impressions, because the reader was shown the post twice — that repetition is
 * the exact subject of the ruling and hiding it in the instrument would be
 * measuring our own excuse. Set to 0 to record literally every delivery.
 */
function servedMinIntervalMs(): number {
  const raw = Number(process.env.FEED_SERVED_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/**
 * Drop a viewer's feed because something that FEEDS the ranking changed
 * underneath it — today, their interests. The next read rebuilds, so a reader
 * can never be served a feed built from preferences they have already replaced.
 *
 * ★ STAYS SYNCHRONOUS ON PURPOSE. `/api/lite/interests` calls this without
 * awaiting; changing the signature to a Promise would silently turn every
 * existing call site into a floating one. The memory drop — the tier that would
 * otherwise answer the very next request in this process — happens immediately,
 * and the durable delete is detached with its own error handling. The interest
 * picker then re-requests with `?refresh=1`, which bypasses both tiers anyway,
 * so the ordering of the detached delete cannot resurrect the old feed.
 */
export function invalidateViewerFeed(viewer: string): void {
  if (!viewer) return;
  feedCache.delete(viewer);
  // Everything currently being built for this viewer is now built from stale
  // inputs. Bumping the generation both refuses their writes and stops the next
  // request from joining them.
  generation.set(viewer, viewerGeneration(viewer) + 1);
  // Bounded here, at the one place the map can grow. The viewer whose era was
  // just bumped is protected from its own sweep - see `pruneGenerations`.
  pruneGenerations(viewer);
  if (!storeEnabled()) return;
  // Tombstone first, so that from this instruction onward NOTHING can serve or
  // promote the row that is about to be deleted — the delete itself is
  // necessarily asynchronous, the guarantee must not be.
  pendingInvalidation.add(viewer);
  void enqueueDurable(viewer, () => deleteStoredFeed(viewer)).finally(() =>
    pendingInvalidation.delete(viewer)
  );
}

/* ------------------------------------------------------------------ */
/* Single-flight                                                       */
/* ------------------------------------------------------------------ */

interface Inflight {
  generation: number;
  promise: Promise<unknown>;
  /** When this build started, so a lock can EXPIRE. See `BUILD_LOCK_TIMEOUT_MS`. */
  startedAt: number;
}

/**
 * ★★★ A BUILD LOCK THAT CANNOT OUTLIVE ITS BUILD (2026-08-14).
 *
 * `inflight` is only ever cleared by the build's own `.finally`, so a build that
 * never settles holds the lock for the life of the process — and the route asks
 * `isRebuilding(viewer)` before starting a background refresh. One wedged
 * promise therefore means that viewer's feed is NEVER rebuilt again, silently,
 * while `cache: 'stale-revalidating'` keeps promising a revalidation that no
 * longer exists. That is a permanent stale flag from a single hang.
 *
 * It is not hypothetical for the shape of work done here. `fetchRankedFeed` has
 * an `AbortController` and is safe, but the rest of a build does not: the
 * viewer-state queries and the `getPost` hydration calls are awaited with no
 * deadline of their own, and a socket that is open but never answers is exactly
 * the case a timeout exists for.
 *
 * Generous on purpose — a cold build was measured at 7.2-16.3s and the ranker's
 * own timeout is 15s per attempt with up to three attempts, so anything under a
 * minute would evict builds that were going to succeed. This is a DEADLOCK
 * BREAKER, not a latency budget.
 *
 * Expiring the lock does not cancel the original build; nothing here can. It
 * releases the SLOT so a later request may start a fresh one. The loser is
 * harmless: `buildOnce`'s `.finally` only clears the slot if it is still its
 * own, and a late write is refused by the generation fence.
 */
const BUILD_LOCK_TIMEOUT_MS = 90_000;

const inflight = new Map<string, Inflight>();
const failedAt = new Map<string, number>();
const generation = new Map<string, number>();

/**
 * Which "era" of a viewer's ranking inputs we are in. Bumped by
 * `invalidateViewerFeed`; process-local, and it only ever needs to be, because
 * it exists to fence builds running IN THIS PROCESS.
 */
export function viewerGeneration(viewer: string): number {
  return generation.get(viewer) ?? 0;
}

/**
 * Keep `generation` from growing forever (2026-08-12).
 *
 * ★ THE ONLY UNBOUNDED STRUCTURE IN THIS FILE, and it sat right next to the one
 * that is carefully bounded. `feedCache` evicts at FEED_MAX_VIEWERS and
 * `inflight`/`failedAt` delete themselves when a build settles, but `generation`
 * was only ever `set` and `get`: one entry per viewer ever invalidated, kept for
 * the life of the process. Small (a username and an integer) and therefore easy
 * to miss, but it is real growth on a long-lived production process, and it
 * OUTLIVES the eviction of the very cache entry it describes.
 *
 * ★★ WHY THIS PRUNES ON A CONDITION RATHER THAN JUST DELETING. Dropping a
 * viewer's entry resets their era to 0, and `buildOnce` captures an era at start
 * and re-checks it at write time. A build that captured era 3 against a pruned
 * counter would normally just have its write REFUSED (3 !== 0), which is safe —
 * but if the counter then climbed back to 3 through three fresh invalidations
 * while that build was still running, a stale result could be accepted as
 * current. So a viewer is pruned only when nothing can be holding a captured
 * era for them: no in-flight build, no cached feed, no pending invalidation.
 * Under those conditions the entry is provably dead weight.
 *
 * Runs only when the map exceeds the same ceiling the feed cache uses, so the
 * common path costs nothing.
 */
function pruneGenerations(protectViewer?: string): void {
  if (generation.size <= FEED_MAX_VIEWERS) return;
  for (const viewer of generation.keys()) {
    // ★ `protectViewer` exists because the only caller is `invalidateViewerFeed`,
    // and by the time it runs, THAT viewer looks maximally prune-eligible: its
    // cache entry was just deleted, its tombstone is not added until two lines
    // later, and it usually has no in-flight build. So the sweep could drop the
    // era it had just bumped, resetting `viewerGeneration()` to 0 and throwing
    // away the invalidation. Worse on the `!storeEnabled()` path, which returns
    // before any tombstone is ever set.
    //
    // The damage was bounded — `readViewerFeed` re-checks both the era and the
    // tombstone after its await, so nothing stale could be SERVED — but it cost
    // a needless cold rebuild, the 7-16s this module exists to avoid.
    if (viewer === protectViewer) continue;
    if (inflight.has(viewer) || feedCache.has(viewer) || pendingInvalidation.has(viewer)) continue;
    generation.delete(viewer);
    failedAt.delete(viewer);
    if (generation.size <= FEED_MAX_VIEWERS) return;
  }
}

/**
 * How long to refuse to start another build for a viewer whose last one failed.
 *
 * Without this, a viewer with nothing stored and a wedged recsys starts a fresh
 * (retrying, therefore up-to-45s) build on EVERY page load. Single-flight
 * collapses concurrent ones, but back-to-back reloads would still queue an
 * unbounded chain of doomed work behind a reader who is only going to be shown
 * the trending fallback either way.
 */
const FAILED_BUILD_COOLDOWN_MS = 30_000;

/**
 * Is a rebuild for this viewer already running in this process?
 *
 * An entry older than `BUILD_LOCK_TIMEOUT_MS` is treated as NOT running and
 * dropped: see that constant for why a lock must be able to expire. Logged at
 * `warn` because a build that overran a 90s ceiling is a real operational fact
 * about the ranker, and this is the only place it becomes visible.
 */
export function isRebuilding(viewer: string): boolean {
  const entry = inflight.get(viewer);
  if (!entry) return false;
  const age = Date.now() - entry.startedAt;
  if (age < BUILD_LOCK_TIMEOUT_MS) return true;
  logger.warn(
    'feed-cache: build lock for %s expired after %dms (limit %dms) — releasing the slot so a rebuild can be started again; the original build is not cancelled and its write is still generation-fenced',
    viewer,
    age,
    BUILD_LOCK_TIMEOUT_MS
  );
  inflight.delete(viewer);
  return false;
}

/** Did this viewer's last build fail recently enough that we should not retry yet? */
export function inFailureCooldown(viewer: string): boolean {
  const at = failedAt.get(viewer);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_BUILD_COOLDOWN_MS) return true;
  failedAt.delete(viewer);
  return false;
}

/**
 * Run `build` for this viewer, or join the one already running.
 *
 * ★ THIS IS WHAT MAKES THE FIRST BUILD SURVIVE THE REQUEST. The returned promise
 * belongs to the viewer, not to the HTTP request that started it: a caller may
 * stop waiting (see the patience race in the route) and the build keeps going to
 * completion and stores its result. N tabs, one build — and a build that outlives
 * every tab that asked for it.
 *
 * The promise is pre-caught internally so that a detached build which fails does
 * not surface as an unhandled rejection; real awaiters still receive the
 * rejection from the promise this returns.
 */
export function buildOnce<T>(viewer: string, build: () => Promise<T>): Promise<T> {
  const era = viewerGeneration(viewer);
  // Through `isRebuilding` rather than `inflight.get` directly, so that joining
  // an EXPIRED lock is impossible: a caller must never be handed a promise from
  // a build that has already overrun its ceiling and been written off — it may
  // never settle, and this promise is what the request awaits.
  const existing = isRebuilding(viewer) ? inflight.get(viewer) : undefined;
  // Join only a build from the CURRENT era. One started before the reader
  // changed their interests is answering a question they no longer asked; it is
  // left to finish (its write is refused by the generation check) while this
  // request gets a build against the inputs that are true now.
  if (existing && existing.generation >= era) return existing.promise as Promise<T>;

  const entry: Inflight = {
    generation: era,
    promise: Promise.resolve() as Promise<unknown>,
    startedAt: Date.now()
  };
  const running = build().finally(() => {
    // Only clear the slot if it is still OURS — a superseded build finishing
    // late must not evict the current one and let a third build start.
    if (inflight.get(viewer) === entry) inflight.delete(viewer);
  });
  entry.promise = running;
  running.then(
    () => failedAt.delete(viewer),
    () => failedAt.set(viewer, Date.now())
  );
  // Separate handled branch: a build nobody is awaiting must not crash the process.
  void running.catch(() => undefined);

  inflight.set(viewer, entry);
  return running;
}

/** Record that a build completed but produced nothing usable (recsys refused). */
export function noteBuildFailure(viewer: string): void {
  if (viewer) failedAt.set(viewer, Date.now());
}

/* ------------------------------------------------------------------ */
/* Bounding the durable tier                                           */
/* ------------------------------------------------------------------ */

const SWEEP_INTERVAL_MS = 10 * 60_000;
let lastSweep = 0;

/**
 * Keep the durable tier bounded, at most once per SWEEP_INTERVAL_MS per process,
 * fired after a successful write and never awaited by a request.
 *
 * Defaults: 14 days and 5,000 rows. At the measured ~287KB per 20-entry row
 * (`pg_column_size` against this box) that ceiling is ~1.4GB, on a volume with
 * 784GB free. Both are env-tunable because the right number is an operator's
 * disk decision, not a hard-coded guess.
 */
async function maybeSweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  try {
    const result = await sweepStoredFeeds({
      ttlDays: Number(process.env.FEED_STORE_TTL_DAYS) || 14,
      maxRows: Number(process.env.FEED_STORE_MAX_ROWS) || FEED_MAX_VIEWERS,
      purgeOtherVersions:
        process.env.FEED_STORE_PURGE_OLD_VERSIONS === 'yes' ? feedVersion() : undefined
    });
    const total = result.expired + result.overCap + result.wrongVersion;
    if (total > 0) {
      logger.info(
        'feed-cache: swept %d stored feeds (expired=%d overCap=%d wrongVersion=%d)',
        total,
        result.expired,
        result.overCap,
        result.wrongVersion
      );
    }
  } catch (error) {
    logger.warn('feed-cache: sweep failed: %o', error);
  }
}

let lastServedSweep = 0;

/**
 * Keep the SERVED LOG bounded. Separate timestamp from `maybeSweep` on purpose:
 * that one fires after a feed BUILD and this one after a feed SERVE, and a
 * deployment where every reader is served from cache would otherwise never
 * sweep the log at all.
 *
 * Three bounds, because they fail three different ways — the argument for each,
 * and specifically why a per-viewer cap is required here when the feed store
 * needs only a global one, is in `sweepServedFeeds`.
 */
async function maybeSweepServed(): Promise<void> {
  const now = Date.now();
  if (now - lastServedSweep < SWEEP_INTERVAL_MS) return;
  lastServedSweep = now;
  try {
    const result = await sweepServedFeeds({
      ttlDays: Number(process.env.FEED_SERVED_TTL_DAYS) || 7,
      maxRowsPerViewer: Number(process.env.FEED_SERVED_MAX_ROWS_PER_VIEWER) || 2_000,
      maxRows: Number(process.env.FEED_SERVED_MAX_ROWS) || 2_000_000
    });
    const total = result.expired + result.perViewerOverCap + result.overCap;
    if (total > 0) {
      logger.info(
        'feed-cache: swept %d served rows (expired=%d perViewerOverCap=%d overCap=%d)',
        total,
        result.expired,
        result.perViewerOverCap,
        result.overCap
      );
    }
  } catch (error) {
    logger.warn('feed-cache: served-log sweep failed: %o', error);
  }
}
