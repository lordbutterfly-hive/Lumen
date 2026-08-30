import type { ITrendingTag } from '@hive/common-hiveio-packages/wax';
import { getTrendingTags } from '@transaction/lib/hive';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

/**
 * ★★★ THE RIGHT RAIL'S TOPIC LIST, ON THE SERVER, WHERE IT CAN BE PREFETCHED.
 *
 * `features/layouts/right-rail/topics.tsx` is a `'use client'` widget that fetched
 * `/api/trending-tags` from the browser after hydration. Nothing prefetched it, so
 * the card could not exist until the whole client bundle had downloaded, parsed and
 * hydrated. Measured on the production build in a real browser, twice, local, with
 * zero network latency between the browser and the server:
 *
 *   warm            cold browser cache
 *   1290 ms         1001 ms   skeleton pills painted (they ship in the SSR HTML)
 *   1425 ms         1162 ms   all 64 JS files down (983 KB)
 *   1746 ms         1429 ms   the fetch even STARTS  <- the hydration gap
 *     50 ms            1 ms   the fetch itself
 *   2009 ms         1674 ms   chips finally render
 *
 * So 719 ms / 673 ms of grey pills, of which the request was 7% and 0.1%. The data
 * was on this box the whole time: the route is prerendered at build and answers in
 * 5 ms off disk. Both dominant terms scale with the reader's bandwidth and CPU, so
 * on a real connection this is seconds, not milliseconds.
 *
 * This module is the shared server reader that lets `app/layout.tsx` put the answer
 * INTO the HTML.
 *
 * ★ CORRECTION TO AN EARLIER CLAIM IN THIS FILE (2026-08-30). It said "one cache
 * serves the route handler and the prefetch alike, so the page render and the API
 * can never disagree". That overstates it, and an adversarial sweep caught it.
 * `/api/trending-tags` has a `GET()` with no `Request` argument, so Next PRERENDERS
 * it at build time and serves it from the ISR cache — live headers show
 * `x-nextjs-cache: HIT` and a 2 ms response that never touches this module. So
 * there are TWO caches with independent clocks: Next's ISR at `revalidate = 3600`,
 * and the in-process TTL below at 1 h fresh plus 24 h stale. They CAN disagree.
 *
 * That is acceptable and deliberate rather than a bug: both are the same global tag
 * list, neither is personalised, and the owner's own ruling was that a day of
 * staleness would be fine. What this module genuinely guarantees is that the
 * PREFETCH and any non-prerendered read share one entry and one upstream call. It
 * does not make the route and the page render byte-identical, and nothing should be
 * written that depends on them being so.
 */
export const TRENDING_TAGS_LIMIT = 120;

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * ★ SERVE STALE, REFRESH BEHIND — the same reasoning `/api/trending-tags` already
 * carried in its own header, and the owner ruling behind it (2026-08-12): "that
 * should just rotate every 10-20 mins... even if it rotated once a day it would be
 * fine. its just a topic list, and those topics are generally always the same."
 *
 * ★ AN EMPTY LIST IS NOT AN ANSWER. `shouldCache` refuses `[]` for the reason this
 * codebase has been bitten by more than once: a 200-with-no-entries renders exactly
 * like "there are no topics", which is indistinguishable from a chain that answered
 * and had nothing to say. Refusing to store it means the next reader retries instead
 * of inheriting an hour of emptiness.
 */
export const getTrendingTagsCached = withTtlCache(
  (): Promise<ITrendingTag[]> => getTrendingTags(TRENDING_TAGS_LIMIT),
  () => 'trending-tags',
  {
    ttlMs: ONE_HOUR_MS,
    staleWhileRevalidateMs: ONE_DAY_MS,
    max: 1,
    shouldCache: (tags) => Array.isArray(tags) && tags.length > 0
  }
);

/** The react-query key the right-rail widget reads. Exported so the prefetch and the
 *  widget can never drift apart — a mismatched key hydrates nothing, silently. */
export const TRENDING_TAGS_QUERY_KEY = ['right-rail-trending-tags'] as const;

/**
 * ★★ THE PREFETCH MUST NEVER BE ABLE TO SLOW THE PAGE DOWN.
 *
 * `app/layout.tsx` is dynamic (it reads cookies), so this runs on every request, and
 * whatever it awaits is added to EVERY route's time to first byte. A cache hit is
 * free. A cache MISS is a chain call, and `getTrendingTags` goes through the shared
 * wax client whose own `apiTimeout` is 5s — so an unhealthy Hive node could otherwise
 * put five seconds in front of the whole site to decorate a sidebar.
 *
 * So the miss is raced against a short deadline and simply given up on. Losing the
 * race is not an error and is not logged as one: the widget's own client fetch still
 * runs exactly as it does today, which is to say the page degrades to the behaviour
 * it had before this file existed. Never worse, usually far better.
 *
 * The abandoned promise keeps running and fills the cache, so the reader who paid the
 * race is the only one who pays it at all — and `warmServerCaches()` normally gets
 * there first, at boot, before anybody asks.
 */
const PREFETCH_DEADLINE_MS = 600;

export async function trendingTagsForPrefetch(): Promise<ITrendingTag[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      getTrendingTagsCached(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PREFETCH_DEADLINE_MS);
      })
    ]);
    return raced && raced.length > 0 ? raced : null;
  } catch {
    // Deliberately swallowed. A failed prefetch leaves the widget to fetch for
    // itself, which is the pre-existing behaviour; the route handler logs the
    // real failure, so this would only ever be a duplicate line.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
