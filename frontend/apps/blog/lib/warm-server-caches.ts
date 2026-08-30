import { getLogger } from '@ui/lib/logging';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import { getCommunitiesCached, getDynamicGlobalPropertiesCached } from '@/blog/lib/cached-api';
import { getTrendingTagsCached } from '@/blog/lib/trending-tags';

const logger = getLogger('app');

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
 *  · `getDynamicGlobalProperties` — keyed on nothing at all, so ONE entry serves
 *    every reader on every route.
 *
 * Per-account reads (profiles, reputation) are deliberately NOT warmed. There is
 * no way to know which accounts will be asked for, warming a guessed list would
 * spend real upstream calls on strangers, and getting it wrong is indistinguish-
 * able from getting it right until traffic arrives.
 *
 * ★ IT MUST NOT BE ABLE TO STOP THE SERVER, in three separate ways, because a
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
 */
export function warmServerCaches(): void {
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

  void Promise.all([
    warm('communities', () => getCommunitiesCached('rank', null, DEFAULT_OBSERVER)),
    warm('dynamic-global-properties', () => getDynamicGlobalPropertiesCached()),
    /*
     * ★ THE RIGHT RAIL'S TOPIC LIST (2026-08-30). Global, identical for every
     * reader, and now PREFETCHED INTO THE HTML by app/layout.tsx — which means a
     * cold entry is no longer just a slow sidebar, it is 600ms of prefetch
     * deadline that the first readers after a restart would each race and lose.
     * Warming it here means they never race it at all. Same argument as the
     * community list above, and the same swallowed failure.
     */
    warm('trending-tags', () => getTrendingTagsCached())
  ]);
}
