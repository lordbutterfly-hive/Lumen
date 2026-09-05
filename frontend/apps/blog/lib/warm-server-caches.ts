import { getLogger } from '@ui/lib/logging';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import { getCommunitiesCached } from '@/blog/lib/cached-api';
import { getTrendingTagsCached } from '@/blog/lib/trending-tags';
import { warmHomeFeedCache } from '@/blog/lib/feed/feed-prefetch';
import { resolveWorkerIndex, workerCountFromEnv, workerStaggerMs } from '@/blog/lib/feed/topic-warm-offset';

const logger = getLogger('app');

/**
 * Between two workers' boot warms. Matches `topic-warmer`'s `GAP_MS` on purpose:
 * that is the trickle rate both warmers already agreed is polite to the public
 * node, and a stagger is the same idea applied across processes.
 */
const BOOT_STAGGER_MS = 1_500;

/**
 * ★★★ THE ONE READER SERVE-STALE CANNOT HELP (2026-08-17).
 *
 * `server-ttl-cache.ts` removed the wait at every EXPIRY: past the TTL a reader
 * gets the value we already hold while the refresh runs behind them. That fixes
 * every reader except the first one, and it cannot ever fix the first one,
 * because at boot there is nothing stale to serve. So the very first visitor
 * after every deploy and every restart still paid the full upstream cost —
 * measured on this box the same day, `bridge.list_communities` took **6.6s
 * cold** against api.hive.blog, on a page that renders warm in 61ms.
 *
 * That reader is not a rare edge case. They are, in order: the deploy smoke
 * test, the uptime monitor, and whoever happens to load the site in the first
 * seconds after a release — and a restart is exactly when someone is watching.
 *
 * This fills those entries before anyone asks for them. Nothing else changes:
 * the same cached functions, the same TTLs, the same keys.
 *
 * ★ WHAT IS WARMED, AND WHY ONLY THIS.
 *
 *  · The community list for `DEFAULT_OBSERVER` — the single most expensive
 *    shared read in the app, on the layout that wraps the sorted-feed routes.
 *    Every signed-out reader shares this exact key, which is what makes warming
 *    it worth anything: one call serves all of them.
 *
 * ★ `getDynamicGlobalProperties` WAS WARMED HERE AND IS NOT ANY MORE
 * (2026-09-05). Commit 1c68664 dropped the profile layout's `dynamicGlobalData`
 * prefetch, which left `getDynamicGlobalPropertiesCached` with ZERO readers
 * anywhere in the app (grep-verified across apps/ and packages/) — so this entry
 * was spending a real upstream call on every restart to fill a cache nothing
 * ever read. The cached wrapper went with it. Everything that still wants the
 * value calls `getDynamicGlobalProperties` DIRECTLY and always did: the wallet
 * routes for money math, and `/api/dynamic-global-properties` for the client's
 * post-hydration `['dynamicGlobalData']` query.
 *
 * Per-account reads (profiles, reputation) are deliberately NOT warmed. There is
 * no way to know which accounts will be asked for, warming a guessed list would
 * spend real upstream calls on strangers, and getting it wrong is indistinguish-
 * able from getting it right until traffic arrives.
 *
 * ★★ ONE BURST PER WORKER, NOT THREE IN THE SAME INSTANT (2026-09-05). All of
 * the above was written for one process; production runs a three-worker cluster
 * (`lib/feed/topic-warm-offset.ts` carries the measurement and the reasoning),
 * and `register()` runs once per worker, so every restart fired every one of
 * these warms three times over in the same millisecond — twelve upstream calls
 * before the dead entry above went, nine after. Each
 * worker still needs its own warm — the caches being filled are per-process — so
 * the workers are spaced `BOOT_STAGGER_MS` apart instead of elected down to one.
 * The delay is a plain `setTimeout`, `unref`ed so a pending warm can never be the
 * reason this process stays alive.
 *
 * ★ IT MUST NOT BE ABLE TO STOP THE SERVER, in four separate ways, because a
 * cache warm failing is never a reason to be down:
 *
 *  1. NOT AWAITED by `register()` — the server starts accepting connections
 *     immediately, warm or not. A reader arriving mid-warm joins the in-flight
 *     call through the cache's own single-flight rather than starting a second.
 *  2. Every read is caught individually, so a failure of one does not skip the
 *     other, and a rejected promise never reaches the runtime as an unhandled
 *     rejection (which Node 20 turns into a process exit).
 *  3. Failures are logged and dropped. `server-ttl-cache.ts` never stores a
 *     rejection, so a failed warm leaves an empty entry and the first real
 *     reader simply pays what they would have paid anyway. Degraded to today's
 *     behaviour, never worse.
 *  4. A SYNCHRONOUS throw is caught too, which the stagger made necessary: on
 *     the delayed path the reads start inside a timer, where a throw before a
 *     promise exists is an uncaught exception and Node exits — not the rejected
 *     `register()` it used to be. See the `try` in `runWarms`.
 */
export function warmServerCaches(): void {
  const offsetMs = workerStaggerMs(resolveWorkerIndex(workerCountFromEnv()), BOOT_STAGGER_MS);
  if (offsetMs === 0) {
    runWarms();
    return;
  }
  const timer = setTimeout(runWarms, offsetMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function runWarms(): void {
  /*
   * ★ `performance.now()`, NOT `Date.now()`, and this is not pedantry — it was a
   * wrong number on screen. The first version timed the warm with `Date.now()`
   * and logged `cache warm: communities ready in -140ms`. A wall clock is not
   * monotonic: this box is WSL2, whose clock resyncs against the host and can
   * step BACKWARDS, so a duration measured across two reads of it can come out
   * negative. A duration must come from a monotonic source; a wall clock only
   * answers "what time is it", never "how long did that take".
   */
  const started = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - started);

  const warm = (name: string, run: () => Promise<unknown>): Promise<void> =>
    run().then(
      () => {
        logger.info('cache warm: %s ready in %dms', name, elapsedMs());
      },
      (err) => {
        // Deliberately swallowed — see reason 3 above.
        logger.warn('cache warm: %s failed after %dms (%s); the first reader will pay this read', name, elapsedMs(), String(err));
      }
    );

  // Reason 4 in the header: a synchronous throw here would be an uncaught
  // exception on the delayed (timer) path, and Node exits on those.
  try {
    void Promise.all([
      warm('communities', () => getCommunitiesCached('rank', null, DEFAULT_OBSERVER)),
      /*
       * ★ THE RIGHT RAIL'S TOPIC LIST (2026-08-30). Global, identical for every
       * reader, and now PREFETCHED INTO THE HTML by app/layout.tsx — which means a
       * cold entry is no longer just a slow sidebar, it is 600ms of prefetch
       * deadline that the first readers after a restart would each race and lose.
       * Warming it here means they never race it at all. Same argument as the
       * community list above, and the same swallowed failure.
       */
      warm('trending-tags', () => getTrendingTagsCached()),
      /*
       * ★ THE HOME FEED ITSELF (2026-08-31). The same argument as trending-tags
       * directly above, on the expensive half: `prefetchHomeFeed` races a 700 ms
       * deadline that the upstream (830-1,090 ms measured) cannot beat cold, so
       * without this every reader after a restart loses that race until one of
       * them happens to fill the cache. Warming it means the first one does not.
       * Signed-out readers only — the signed-in feed is per-viewer and there is no
       * way to know whose to warm, the same reasoning that excludes profiles.
       */
      warm('home-feed', () => warmHomeFeedCache())
    ]);
  } catch (err) {
    logger.warn('cache warm: could not start (%s); the first readers will pay these reads', String(err));
  }
}
