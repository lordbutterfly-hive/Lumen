import { getLogger } from '@ui/lib/logging';
import { inFailureCooldown, isRebuilding } from '@/blog/lib/feed/feed-cache';

const logger = getLogger('app');

/**
 * The registered feed builder lives in a process-global slot owned by
 * `viewer-warmer.ts` (the for-you route registers it at load). Read by key here, not
 * imported, so this module stays free of module-scope state: it is reachable from
 * `instrumentation.ts` through `feed-prefetch.ts`, where a second copy of the
 * warmer's state would silently diverge (see instrumentation-singleton-scan.test.ts).
 */
const WARMER_STATE = Symbol.for('lumen.feed.viewerWarmer.state');

type Builder = (candidate: { viewer: string; isLite: boolean; userId: string }, limit: number) => Promise<boolean>;

/**
 * ★ THE HOME PAGE'S "REBUILT BEHIND THEM" (2026-09-24). The freshness bands say a
 * stored feed younger than 18h is "served as their ranking, rebuilt behind them",
 * and `/api/feed/for-you` does that on every non-fresh request. The server-rendered
 * home page (09-03) serves the same stored row and never started a rebuild, and the
 * client's first poll waits 5 minutes (`FEED_POLL_MS`), so a reader who opened home
 * and clicked away got the same page until the 6-hourly warmer. Measured for the
 * owner over 36 home loads (09-23 01:10 to 09-24 13:40): the stored page was a median
 * 47 min old when served, p75 196 min, worst 698 min, 16 of 36 older than an hour.
 *
 * Starts the SAME builder the warmer and the route use, under the same two guards the
 * route applies (`isRebuilding`, `inFailureCooldown`); `buildOnce` inside the builder
 * merges it with any build already running for this viewer. Detached: the reader
 * never waits, the next load gets the new ranking. `limit` is the replaced row's own
 * built size, so the rebuilt row has the same shape. A process that has not loaded
 * the feed route yet has no builder and starts nothing, which is the old behaviour.
 */
export function refreshViewerFeedBehind(
  candidate: { viewer: string; isLite: boolean; userId: string },
  limit: number,
  ageMs: number
): boolean {
  const slot = (globalThis as typeof globalThis & { [WARMER_STATE]?: { builder: Builder | null } })[WARMER_STATE];
  const builder = slot?.builder;
  if (!builder || !candidate.viewer || !(limit > 0)) return false;
  if (isRebuilding(candidate.viewer) || inFailureCooldown(candidate.viewer)) return false;
  const startedAt = Date.now();
  logger.info('home: background refresh started for %s (stored feed is %dms old)', candidate.viewer, ageMs);
  void builder(candidate, limit)
    .then((built) =>
      logger.info(
        'home: background refresh for %s %s in %dms',
        candidate.viewer,
        built ? 'SUCCEEDED' : 'PRODUCED NOTHING',
        Date.now() - startedAt
      )
    )
    .catch((error) => logger.warn('home: background refresh for %s failed: %o', candidate.viewer, error));
  return true;
}
