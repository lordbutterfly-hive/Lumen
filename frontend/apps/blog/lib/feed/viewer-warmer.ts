import 'server-only';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '@/blog/lib/lite/config';
import { withAdvisoryLock } from '@/blog/lib/lite/db/pool';
import { getRecsysConfig } from '@/blog/lib/recsys/feed-client';
import { listViewersToWarm, sweepViewerSeen, type WarmCandidate } from './viewer-seen';
import { acquireHiveWarm, hiveWarmHolder, releaseHiveWarm } from './hive-warm-gate';

const logger = getLogger('app');

/**
 * ★★★ REBUILD A RETURNING READER'S RANKING BEFORE THEY COME BACK (2026-08-15).
 *
 * BUILD MAP: O:/LUMEN-DOCS/BUILDMAP-NEVER-WAIT-2026-08-15.md §4.
 *
 * The two-band ceiling in `feed-cache.ts` decides what a stale row may be called.
 * This decides that rows are not stale. Measured on this box on 2026-08-15: of
 * 52 stored rows, ONE was younger than 18h and 50 were past 72h — so without
 * this, the presentation band is a formality and almost every returning reader
 * still lands in trending.
 *
 * ★★★ IT MUST NEVER RECORD A SERVE, AND NOTHING HERE IMPORTS ANYTHING THAT
 * COULD. This module does not import `recordFeedServe`, `recordServedPage` or
 * `feed-served-repository`, and the builder it is handed (see `ViewerFeedBuilder`)
 * is the request path's BUILD function, which has never recorded a serve —
 * recording happens on the two branches that return a response, not on the build.
 * That separation is currently a nicety, because every background build today is
 * started by some reader's own request. After this module ships, the MAJORITY of
 * builds have no reader attached, and the nicety becomes the thing standing
 * between a reader and a feed that suppresses itself: at `FEED_WARM_LIMIT=30`,
 * counting a warm build as an impression would mark 30 posts seen per cycle for
 * somebody who saw none, and two cycles (12 hours) would suppress a reader's
 * entire feed before they ever opened the app.
 *
 * ★★★ IT MUST NEVER RUN ON THE REQUEST PATH. Nothing in this file is called from
 * a feed response. It is driven by an authenticated endpoint (`/api/feed/warm`)
 * and/or an in-process ticker, both of which run a cycle to completion
 * independently of any reader's request, and both of which take the same
 * cluster-wide advisory lock so overlapping cycles skip rather than double.
 *
 * ★ CONCURRENCY IS 1, AND THAT IS THE BINDING CONSTRAINT, NOT A PREFERENCE.
 * `hydrate` fires one `getPost` per ranked post inside a single `Promise.all`,
 * so ONE warm build is already a ~30-way burst against a public Hive node this
 * app does not own. The topic warmer's header states the rule for anything that
 * touches that node — "IT MUST NOT STAMPEDE THE NODE… a burst is how you get
 * rate-limited into the empty feeds this route's history is full of" — and the
 * route's own history records the failure: "2 of 16 fresh loads rendered 3 of 30
 * cards". Serial is also the CHEAPEST shape, because the hydration cache is
 * process-global with a 60s TTL and ranked feeds overlap heavily between
 * viewers: back-to-back builds share post fetches, parallel builds multiply
 * misses.
 *
 * ★ AND THE RANKER'S BUDGET IS SHARED WITH REAL READERS. recsys rate-limits at
 * 120 req/min keyed by client address, and the Next server is ONE client
 * address. At ~2 builds/min × up to 3 attempts that is ≤6 calls/min from here,
 * leaving ≥114 for readers. If the warmer ever trips that window, real readers
 * get 429 → `reason:'unavailable'` → `rankerDownUntil` is set for 60 seconds and
 * every topic page falls back for a minute — a self-inflicted outage. That is
 * why `FEED_WARM_BATCH` is a RECSYS-BUDGET knob and not a throughput knob.
 *
 * ⚠ THIS IS A LAUNCH-SCALE MECHANISM. Serial throughput is roughly
 * 3600/(20s build + 2s gap) ≈ 163 viewers/hour ≈ 3,900/day, which at a 6h
 * cadence supports ≈980 active viewers. Today the active population measured on
 * this box is 2-3. At ~1,000 active readers the serial budget is exhausted and
 * the successor is real fanout — a per-post push into per-follower candidate
 * lists — not a bigger batch. Said here so nobody discovers it at 1,000 readers.
 */

/**
 * Build and store one viewer's ranked feed, exactly the way a reader's own
 * request would.
 *
 * ★ INJECTED RATHER THAN IMPORTED, and that is structural, not stylistic. The
 * build is assembled from `collectViewerState` + `assembleFeed` + `buildOnce` +
 * `writeViewerFeed`, and the first two live inside the route module — a Next
 * route file may export only route handlers, so they cannot be imported. The
 * alternative (reimplementing the build here) is the failure `loadFallbackPage`
 * already names for the topic warmer: "a warmer that assembled its own entry
 * would be one edit away from writing a subtly different shape… and a warmed
 * entry that a reader's branch does not accept warms nothing while looking like
 * it works". Same function, same shape, same single-flight, or it is not warming
 * anything.
 *
 * Resolves true when a usable feed was built AND stored, false otherwise. A
 * false must leave the viewer exactly as they were — never a delete, never a
 * downgrade, never a write.
 */
export type ViewerFeedBuilder = (candidate: WarmCandidate, limit: number) => Promise<boolean>;

/** Arbitrary but fixed: every warm cycle in every process contends on this one. */
const WARM_LOCK = 971_020_315;

/** How long the ranker health probe may take before the cycle gives up on it. */
const HEALTH_TIMEOUT_MS = 5_000;

const DEFAULTS = {
  /**
   * 48h rather than 24h because a reader who skips a day is EXACTLY the reader
   * this feature is for, and the cost of warming one extra viewer is one build.
   */
  activeMs: 48 * 60 * 60_000,
  /** Per-viewer cadence: a row younger than this is left alone. */
  intervalMs: 6 * 60 * 60_000,
  /** Viewers per cycle. A recsys-budget knob — see the header. */
  batch: 3,
  /** Between two builds inside one cycle, so a cycle trickles. */
  gapMs: 2_000,
  /**
   * ★ MUST BE >= THE CLIENT'S `FOR_YOU_LIMIT` (30, feed-tabs.tsx). The route
   * treats `stored.builtLimit < limit` as NOT FRESH, so a row warmed at 20 would
   * trigger an immediate rebuild on the very first read — the warmer would burn
   * its entire budget producing rows that are stale on arrival, silently. The
   * coupling is noted on both sides on purpose.
   */
  limit: 30,
  /** In-process ticker. 0 disables it and leaves the endpoint as the only driver. */
  tickerMs: 60_000,
  /** Rows in `lumen_feed_viewer_seen` older than this are swept. */
  seenTtlDays: 30
} as const;

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface WarmConfig {
  enabled: boolean;
  activeMs: number;
  intervalMs: number;
  batch: number;
  gapMs: number;
  limit: number;
  tickerMs: number;
  seenTtlDays: number;
}

export function warmConfig(): WarmConfig {
  return {
    // ★ DEFAULT OFF, and it stays off until an operator has measured one build
    // and one cycle taken DURING a trust batch. This is the only piece of the
    // "never wait" work that adds outbound load, to a public Hive node and to a
    // rate-limited ranker sharing one client-address budget with real readers.
    enabled: (process.env.FEED_WARM_ENABLED || '').toLowerCase() === 'yes',
    activeMs: numberFromEnv('FEED_WARM_ACTIVE_MS', DEFAULTS.activeMs),
    intervalMs: numberFromEnv('FEED_WARM_INTERVAL_MS', DEFAULTS.intervalMs),
    batch: numberFromEnv('FEED_WARM_BATCH', DEFAULTS.batch),
    gapMs: numberFromEnv('FEED_WARM_GAP_MS', DEFAULTS.gapMs),
    limit: numberFromEnv('FEED_WARM_LIMIT', DEFAULTS.limit),
    tickerMs: numberFromEnv('FEED_WARM_TICKER_MS', DEFAULTS.tickerMs),
    seenTtlDays: numberFromEnv('FEED_SEEN_TTL_DAYS', DEFAULTS.seenTtlDays)
  };
}

export type WarmCycleStatus = 'ok' | 'skipped' | 'disabled' | 'unavailable';

export interface WarmCycleResult {
  status: WarmCycleStatus;
  /** Present whenever the cycle did not run, so an operator never has to guess. */
  reason?: string;
  selected: number;
  warmed: number;
  failed: number;
  backedOff: number;
  ms: number;
}

function idle(status: WarmCycleStatus, reason: string): WarmCycleResult {
  return { status, reason, selected: 0, warmed: 0, failed: 0, backedOff: 0, ms: 0 };
}

/* ------------------------------------------------------------------ */
/* Per-viewer backoff                                                  */
/* ------------------------------------------------------------------ */

/**
 * ★ THE 30-SECOND FAILURE COOLDOWN IS NOT ENOUGH FOR A TIMER. `inFailureCooldown`
 * is right for a reader hammering reload and far too short for something that
 * comes back every cycle: without this, ONE permanently-unrankable viewer
 * consumes a slot in every cycle forever, and with `FEED_WARM_BATCH = 3` it
 * takes a third of the warmer with it.
 *
 * Exponential in cycles — skip 1, then 2, then 4, capped at 8 (48h at a 6h
 * cadence) — measured in TIME rather than counted in cycles so it behaves the
 * same whichever driver is running and whatever the ticker interval is.
 *
 * Process-local, like `inflight`/`failedAt` in feed-cache.ts and for the same
 * reason: it fences work running IN THIS PROCESS. The advisory lock is what
 * makes the cluster case safe; a lost backoff after a restart costs one wasted
 * build, which is the cheapest possible way to be wrong here.
 */
const MAX_BACKOFF_CYCLES = 8;
const BACKOFF_MAX_ENTRIES = 5_000;
const backoff = new Map<string, { strikes: number; until: number }>();

function inBackoff(viewer: string): boolean {
  const entry = backoff.get(viewer);
  if (!entry) return false;
  if (Date.now() < entry.until) return true;
  // Eligible again — but the strike count is KEPT, so a viewer who fails on
  // every retry backs off further each time instead of resetting to one cycle.
  return false;
}

function noteWarmFailure(viewer: string, intervalMs: number): void {
  const previous = backoff.get(viewer);
  const strikes = Math.min((previous?.strikes ?? 0) + 1, MAX_BACKOFF_CYCLES);
  const cycles = Math.min(2 ** (strikes - 1), MAX_BACKOFF_CYCLES);
  if (!previous && backoff.size >= BACKOFF_MAX_ENTRIES) {
    // Bounded here, at the one place it can grow. Map preserves insertion order.
    const oldest = backoff.keys().next().value;
    if (oldest !== undefined) backoff.delete(oldest);
  }
  backoff.set(viewer, { strikes, until: Date.now() + cycles * intervalMs });
}

function noteWarmSuccess(viewer: string): void {
  backoff.delete(viewer);
}

/* ------------------------------------------------------------------ */
/* The ranker health gate                                              */
/* ------------------------------------------------------------------ */

/**
 * ★★★ THE SINGLE MOST VALUABLE LINE IN THE WARMER: it is what stops fifty-two
 * doomed builds against a FAIL_CLOSED ranker — which is exactly the failure that
 * produced the three-day-old artifact this whole wave exists to prevent.
 *
 * recsys refuses (503) whenever its weekly trust snapshot is stale, BEFORE any
 * profile work, and that is correct behaviour that will happen (a missed batch,
 * a cold deploy). `/health` is unauthenticated, unthrottled, always HTTP 200 and
 * reports `serving` — so one cheap call answers "is there any point running this
 * cycle at all" without spending a single rate-limited `/feed` request to find
 * out. Verified live against the running container on 2026-08-15:
 * `{"status":"ok","serving":true,"not_serving_reason":null,…}`.
 *
 * Anything other than an explicit `serving: true` skips the cycle. A health
 * probe we could not read is not evidence of health.
 */
async function rankerIsServing(): Promise<{ ok: boolean; detail: string }> {
  const config = getRecsysConfig();
  if (!config) return { ok: false, detail: 'RECSYS_FEED_URL is not set' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store'
    });
    if (!res.ok) return { ok: false, detail: `health HTTP ${res.status}` };
    const body = (await res.json()) as { serving?: unknown; not_serving_reason?: unknown };
    if (body?.serving === true) return { ok: true, detail: 'serving' };
    const why = typeof body?.not_serving_reason === 'string' ? body.not_serving_reason : 'unknown';
    return { ok: false, detail: `not serving (${why})` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, detail: `health unreachable: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* The cycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * ★★★ THE BUILDER LIVES ON `globalThis`, NOT IN A MODULE VARIABLE (2026-08-15).
 *
 * It was `let builder: ViewerFeedBuilder | null = null` — module scope — and
 * that made `POST /api/feed/warm` fail 23 times out of 31 with
 * `503 no feed builder registered in this process`, MEASURED, on a server where
 * `/api/feed/for-you` had just served real content in the same OS process.
 *
 * WHY: Next bundles each route separately, and both compiled routes carry their
 * OWN inlined copy of this module — verified by finding the `WARM_LOCK`
 * constant and this file's own error string in BOTH
 * `.next/server/app/api/feed/warm/route.js` and `.../for-you/route.js`.
 * `startViewerWarmer()` is only ever called from `for-you`'s module scope, so
 * the copy the WARM ENDPOINT executes had a builder that was permanently
 * `null`, while the copy that owned a builder was never asked. It flapped with
 * recompiles, which is worse than a hard failure: it looked intermittent.
 *
 * `Symbol.for` is keyed in the per-process registry, so every inlined copy in
 * this process resolves the SAME slot — which is exactly the property module
 * scope failed to provide. This is the standard Next workaround for a
 * cross-route singleton, and it matters here because `FEED_WARM_TICKER_MS=0`
 * (endpoint-driven) is a supported and documented deployment mode: without
 * this, that mode cannot work at all, and its failure is the one status the
 * route says should page an operator.
 *
 * `running` moves with it for the same reason — two copies each holding their
 * own `false` would both enter the cycle. The Postgres advisory lock
 * (`WARM_LOCK`) still fences ACROSS processes and remains the authority; this
 * is the cheap in-process short-circuit its own comment describes.
 */
const WARMER_STATE = Symbol.for('lumen.feed.viewerWarmer.state');

interface WarmerState {
  builder: ViewerFeedBuilder | null;
  running: boolean;
}

function warmerState(): WarmerState {
  const carrier = globalThis as typeof globalThis & { [WARMER_STATE]?: WarmerState };
  carrier[WARMER_STATE] ??= { builder: null, running: false };
  return carrier[WARMER_STATE];
}
let started = false;
let lastSeenSweep = 0;
const SEEN_SWEEP_INTERVAL_MS = 60 * 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending gap can never be the reason this process stays alive.
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

/**
 * Run ONE warm cycle: at most `FEED_WARM_BATCH` viewers, serially, with a gap.
 *
 * ★ EVERY WAY THIS DECLINES TO RUN IS NAMED IN THE RETURN VALUE. A warmer that
 * fails silently is indistinguishable from a warmer that is working, which is
 * precisely how a dead ranker went unnoticed for three days — the responses said
 * `stale-revalidating` the whole time. Each cycle is also logged on both edges.
 */
export async function runWarmCycle(): Promise<WarmCycleResult> {
  const config = warmConfig();

  // ★ ERASURE MUST NOT DEPEND ON THE FEATURE BEING ON (2026-08-15).
  //
  // The TTL sweep used to live further down this function, AFTER the `enabled`
  // return below — so switching `FEED_WARM_ENABLED` off stopped the writes
  // (correct) and silently stopped the deletes too. Rows written while the flag
  // was on then sat forever with no live erasure path, on a table migration 0035
  // explicitly says must have one from the day it is created: "a log of when a
  // named person was here must have a delete path from the day it is created".
  //
  // Retention is not a feature toggle. The sweep now runs first, whenever there
  // is a database to sweep, and is still throttled because it is a whole-table
  // predicate. It deliberately does NOT take the advisory lock: a TTL DELETE is
  // idempotent, so two processes both running it costs a duplicate query and
  // nothing else, whereas making erasure wait on the warm lock would re-couple
  // it to the warmer that may never run.
  if (liteConfig.databaseUrl && Date.now() - lastSeenSweep > SEEN_SWEEP_INTERVAL_MS) {
    lastSeenSweep = Date.now();
    void sweepViewerSeen(config.seenTtlDays)
      .then((dropped) => {
        if (dropped > 0) logger.info('viewer-warmer: swept %d idle viewer-seen rows', dropped);
      })
      .catch((error) => logger.warn('viewer-warmer: viewer-seen sweep failed: %o', error));
  }

  // ★ COLD FIRST CYCLE AFTER A FLIP-ON, BY DESIGN. Before the write-gate fix,
  // `noteViewerSeen` wrote on every request regardless of this flag, so the
  // activity log was always warm and a deployment enabling the warmer found it
  // pre-populated. Now the log only fills while the warmer is on, so the FIRST
  // cycle after enabling it selects nothing and a returning reader is warmed on
  // their second visit rather than their first. That is the correct trade for
  // not writing a per-request row nobody reads — but it means "enable the
  // warmer" is a two-cadence change, not an instant one.
  if (!config.enabled) return idle('disabled', 'FEED_WARM_ENABLED is not "yes"');
  if (!liteConfig.databaseUrl) return idle('disabled', 'LITE_DATABASE_URL is not set');
  // Captured once, so the loop below cannot be tripped by a re-registration
  // mid-cycle and needs no non-null assertion to read it.
  const build = warmerState().builder;
  if (!build) {
    // Loud rather than quiet: this means the cycle ran in a process where the
    // feed route module has never been loaded, so nothing can be built here.
    logger.error(
      'viewer-warmer: no feed builder is registered in this process — the /api/feed/for-you module has not been loaded, so no ranking can be built. Drive the warmer from a process that serves feeds, or use the in-process ticker.'
    );
    return idle('unavailable', 'no feed builder registered in this process');
  }
  if (config.batch <= 0) return idle('disabled', 'FEED_WARM_BATCH is 0');
  if (warmerState().running) return idle('skipped', 'a warm cycle is already running in this process');
  // ★ THE OTHER WARMER SHARES THIS NODE (2026-08-15). `topic-warmer` bursts 16
  // tags at `api.hive.blog`, and a viewer build is a ~30-way `getPost` burst at
  // the same node. Measured with both running: the topic cycle took 61.9s and
  // lost a tag to an 8s WaxError timeout, while this cycle reported
  // "warmed 0/1 viewers in 17264ms (1 failed)" — a build that failed on the
  // node's saturation, not on its own merits. Each warmer already refuses to
  // overlap ITSELF; this extends the same rule across the two of them. Skipping
  // costs one cadence period, and this warmer's whole purpose is to run when
  // nobody is waiting.
  if (!acquireHiveWarm('viewer-warmer')) {
    return idle('skipped', `${hiveWarmHolder()} holds the outbound warm budget`);
  }

  warmerState().running = true;
  const startedAt = Date.now();
  try {
    // ★ ONE CYCLE AT A TIME, CLUSTER-WIDE. Skipping is correct: the viewers are
    // still there next tick, and two overlapping cycles would double the load on
    // the one public node and the one rate-limited ranker.
    const result = await withAdvisoryLock(WARM_LOCK, async (): Promise<WarmCycleResult> => {
      const health = await rankerIsServing();
      if (!health.ok) {
        logger.warn('viewer-warmer: skipping cycle — ranker %s', health.detail);
        return idle('skipped', `ranker ${health.detail}`);
      }

      // ★ OVER-SELECTED, THEN FILTERED — otherwise a backed-off viewer STARVES
      // THE BATCH. The selection is ordered by recency and `LIMIT`ed in SQL, so
      // with `FEED_WARM_BATCH = 3` three permanently-unrankable viewers sitting
      // at the top of that order would fill every cycle forever while being
      // skipped, and nobody behind them would ever be warmed. Asking for a few
      // more rows and skipping past the backed-off ones costs one slightly wider
      // index scan and bounds the BUILDS — which are the expensive thing — at
      // exactly `batch` either way.
      const pool = await listViewersToWarm({
        activeMs: config.activeMs,
        warmAfterMs: config.intervalMs,
        batch: Math.min(config.batch * 4, 50)
      });
      let backedOff = 0;
      const candidates: WarmCandidate[] = [];
      for (const candidate of pool) {
        if (candidates.length >= config.batch) break;
        if (inBackoff(candidate.viewer)) {
          backedOff += 1;
          continue;
        }
        candidates.push(candidate);
      }
      if (candidates.length === 0) {
        return { status: 'ok', selected: 0, warmed: 0, failed: 0, backedOff, ms: 0 };
      }

      let warmed = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const buildStartedAt = Date.now();
        try {
          const ok = await build(candidate, config.limit);
          if (ok) {
            warmed += 1;
            noteWarmSuccess(candidate.viewer);
            logger.info(
              'viewer-warmer: warmed %s in %dms (limit %d)',
              candidate.viewer,
              Date.now() - buildStartedAt,
              config.limit
            );
          } else {
            failed += 1;
            noteWarmFailure(candidate.viewer, config.intervalMs);
            logger.warn(
              'viewer-warmer: build for %s produced nothing after %dms — their stored row is unchanged',
              candidate.viewer,
              Date.now() - buildStartedAt
            );
          }
        } catch (error) {
          // One bad viewer must never end the cycle; the others are still worth
          // warming, and a viewer who fails now is simply as cold as they were
          // before this module existed.
          failed += 1;
          noteWarmFailure(candidate.viewer, config.intervalMs);
          logger.warn('viewer-warmer: build for %s threw: %o', candidate.viewer, error);
        }
        if (config.gapMs > 0) await sleep(config.gapMs);
      }

      return {
        status: 'ok',
        selected: candidates.length,
        warmed,
        failed,
        backedOff,
        ms: 0
      };
    });

    if (result === null) return idle('skipped', 'another process holds the warm lock');

    // The viewer-seen TTL sweep used to run HERE. It moved to the top of this
    // function (see the note there): behind the `enabled` gate it stopped
    // running whenever the warmer was switched off, which froze erasure on a
    // table that must always have a delete path. Running it here as well would
    // just double the query on the one path that reaches both.

    const ms = Date.now() - startedAt;
    if (result.selected > 0) {
      logger.info(
        'viewer-warmer: cycle warmed %d/%d viewers in %dms (%d failed, %d in backoff)',
        result.warmed,
        result.selected,
        ms,
        result.failed,
        result.backedOff
      );
    }
    return { ...result, ms };
  } catch (error) {
    logger.error(error, 'viewer-warmer: cycle failed');
    return { ...idle('unavailable', 'cycle threw'), ms: Date.now() - startedAt };
  } finally {
    warmerState().running = false;
    releaseHiveWarm('viewer-warmer');
  }
}

/**
 * Register the builder and, unless `FEED_WARM_TICKER_MS=0`, start the in-process
 * ticker.
 *
 * ★ CALLED FROM THE FEED ROUTE'S MODULE SCOPE, exactly like `startTopicWarmer`,
 * and for the same reason: the builder is a closure over functions that live in
 * that module and cannot be exported from it. Registration therefore happens the
 * moment the feed route is loaded, which on this app is the first feed request
 * the process serves.
 *
 * ★ TWO DRIVERS, ONE CYCLE. The build map prefers the `lumen-publisher` shape —
 * an authenticated endpoint plus an external ticker — over a module-load timer,
 * on the grounds that a timer multiplies load per process and cannot be paused
 * without a deploy. Both drivers are provided and both go through `runWarmCycle`,
 * so they cannot diverge: the endpoint is there for an external ticker (and for
 * an operator who wants a cycle's worth of counters in an HTTP response), and
 * the in-process ticker is there so the feature works without a compose change.
 * The multiply-per-process objection is answered by the advisory lock — a second
 * process's cycle skips rather than doubles.
 *
 * Idempotent: a second call is ignored, so importing this from more than one
 * place cannot double the load.
 */
export function startViewerWarmer(feedBuilder: ViewerFeedBuilder): void {
  // Registration is NOT gated on `started`: the endpoint needs a builder even in
  // a process where the ticker is disabled, and re-registering the same closure
  // on a hot reload is harmless.
  warmerState().builder = feedBuilder;

  if (started) return;
  // Edge/browser bundles have no business running a timer loop against a Hive
  // node, and neither does `next build` — its static-generation pass evaluates
  // route modules in several parallel workers, each with NEXT_RUNTIME=nodejs.
  // Both guards copied from `topic-warmer.ts`, where the build-phase case was
  // found by watching a build fire warm cycles it then threw away.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const config = warmConfig();
  if (!config.enabled) return;
  if (config.tickerMs <= 0) {
    logger.info('viewer-warmer: enabled, in-process ticker off (FEED_WARM_TICKER_MS=0)');
    return;
  }
  started = true;
  logger.info(
    'viewer-warmer: starting — up to %d viewer(s) per tick every %dms, per-viewer cadence %dms, limit %d',
    config.batch,
    config.tickerMs,
    config.intervalMs,
    config.limit
  );
  const repeat = setInterval(() => void runWarmCycle(), config.tickerMs);
  if (typeof repeat.unref === 'function') repeat.unref();
}

/**
 * Is a builder registered in this process? The endpoint reports it honestly.
 *
 * ★ Reads the process-global slot, not a module variable — this function is the
 * one that reported `builderRegistered:false` on 23 of 31 measured calls while a
 * builder was in fact registered by another copy of this module in the same
 * process. See `warmerState()` above for why the copies do not share scope.
 */
export function hasViewerFeedBuilder(): boolean {
  return warmerState().builder !== null;
}
