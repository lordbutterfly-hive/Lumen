import { getPostsRanked } from '@transaction/lib/bridge-api';
import { getLogger } from '@ui/lib/logging';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { filterBannedEntries } from '@/blog/lib/moderation/banned-authors';
import { filterBlockedForViewer, viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { readViewerFeed, feedBands, feedVersion } from '@/blog/lib/feed/feed-cache';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import type { InitialFeedSeed, InitialFeedPage } from '@/blog/components/observer-provider';

const logger = getLogger('app');

const PREFETCH_LIMIT = 20;
/**
 * ★★★ 3,000 ms -> 700 ms (2026-08-31). MEASURED: this ceiling was letting a
 * single upstream call hold the whole Home render.
 *
 * Home awaits `prefetchHomeFeed` before it will send anything, so this number is
 * the worst case a reader waits for a page that could otherwise stream. Measured
 * from the production box, no network in the way:
 *
 *     /            RSC payload   890-1,000 ms
 *     /witnesses   RSC payload      12-30 ms      <- 30-50x faster
 *     api.hive.blog bridge.get_ranked_posts, from the box   830-1,090 ms
 *
 * The whole gap was this one call. 3 seconds is not a protection at that scale,
 * it is a promise to wait.
 *
 * ★★★ 700 ms IS DELIBERATELY *BELOW* THE UPSTREAM'S OWN MEASURED LATENCY, and an
 * earlier version of this comment claimed the opposite ("above the healthy
 * case's own latency") three lines under a measurement of 830-1,090 ms that
 * refutes it — caught by clauderfly-57, 2026-08-31. The corrected reasoning, and
 * it is a better design than the false one:
 *
 * On a COLD cache the first reader loses this race every time, by construction.
 * That costs them nothing they were not already going to pay — they get the
 * client-side fetch, which is exactly the miss path that ships today — and it
 * buys everyone behind them the whole 900 ms, because the abandoned call keeps
 * running and fills the cache. Racing a deadline the upstream can actually beat
 * would only mean the first reader waits ~1.2 s to save the same 900 ms once.
 * Nobody waits, and the page still gets faster.
 *
 * (The thing being raced is strictly slower than the 830-1,090 ms measured:
 * `getPostsRanked` THEN `mergeLumenEngagement` THEN `trimForSSR`.)
 *
 * The sibling prefetch in `app/layout.tsx` (trending TAGS) already learned this
 * and races a 600 ms deadline. This one is the expensive half and had neither a
 * deadline worth the name nor a cache.
 */
const PREFETCH_TIMEOUT_MS = 700;
const FEED_BODY_CHARS = 800;
const BODY_IMAGE_PATTERNS = [
  /!\[[^\]]*\]\([^)\s]+\)/,
  /<img\s+[^>]*src="[^"]+"[^>]*>/i,
  /https?:\/\/\S+\.(?:png|jpe?g|webp|gif)/i
];

function trimBody(body: string): string {
  if (body.length <= FEED_BODY_CHARS) return body;
  const head = body.slice(0, FEED_BODY_CHARS);
  const rescued: string[] = [];
  for (const pattern of BODY_IMAGE_PATTERNS) {
    if (pattern.test(head)) continue;
    const found = body.match(pattern);
    if (found) rescued.push(found[0]);
  }
  return rescued.length > 0 ? `${head}\n\n${rescued.join('\n')}` : head;
}

function cursorOf(entries: Entry[]): { author: string; permlink: string } | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  return { author: last._lite?.chainAuthor || last.author, permlink: last.permlink };
}

function trimForSSR(entries: Entry[]): Entry[] {
  return entries.map((entry) => ({
    ...entry,
    active_votes: [],
    body: trimBody(entry.body ?? '')
  }));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void promise.catch(() => undefined);
  }
}

/**
 * ★★★ CACHED, 2026-08-31. This was the single slowest thing on the site and it
 * ran again, in full, for every anonymous visitor who touched Home.
 *
 * WHY IT IS SAFE TO SHARE ONE ANSWER. This path takes NO viewer: it is
 * `bridge.get_ranked_posts('trending')` with the default observer, so every
 * signed-out reader was being served a byte-identical result computed from
 * scratch. One fetch per window now serves all of them. The SIGNED-IN path is
 * deliberately NOT cached here — `prefetchStoredFeed(viewer)` is per-person
 * ranking out of Postgres and answers in ~7 ms, so it has neither the cost nor
 * the shareability that makes a shared cache correct.
 *
 * WHY 45 SECONDS. Long enough that a burst of arrivals costs one upstream call,
 * short enough that Home is never visibly behind the chain. Trending moves on
 * the order of minutes, not seconds.
 *
 * WHY `shouldCache` REFUSES AN EMPTY LIST. `null` here means "we could not tell",
 * and storing that would serve an empty Home for the whole window off one bad
 * moment at the node. Same rule `trending-tags.ts` states for the same reason:
 * an absence must not be cached as an answer. The `max: 1` is honest about there
 * being exactly one key.
 *
 * ★ THE STALE WINDOW IS DELIBERATE. `staleWhileRevalidate` means the first
 * request after expiry is served the previous answer immediately and the refresh
 * happens behind it — so the ~900 ms is paid by NOBODY after the first ever
 * call, rather than by one unlucky reader every window.
 */
const FORTY_FIVE_SECONDS_MS = 45 * 1000;
/**
 * ★★ THE STALE WINDOW IS SIZED FOR PRE-LAUNCH TRAFFIC, NOT FOR THE TRAFFIC WE
 * WISH WE HAD (clauderfly-57, 2026-08-31). At 45 s + 5 min the entry is gone
 * 5 min 45 s after the last fill, and Lumen currently gets a view every few
 * minutes — so most readers would still have found it empty and the cache would
 * have been decoration. An hour of stale-while-revalidate costs nothing: nobody
 * ever waits on a stale entry (it is served immediately and refreshed behind the
 * reader), and a trending list an hour old is a trending list.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * ★★★ LOAD-BEARING, AND INVISIBLE IF YOU ONLY READ THIS FILE: THE CACHE IS FILLED
 * BY CALLS NOBODY IS STILL WAITING FOR (clauderfly-57, 2026-08-31).
 *
 * `withTimeout` RACES the promise and deliberately does not cancel it
 * (`void promise.catch()`), and `server-ttl-cache.ts:130-134` stores the result
 * inside `loader(...).then(...)` — not in the caller's await. So when the first
 * reader gives up at 700 ms, the call keeps running, completes, and fills the
 * entry behind them. `inFlight` gives real single-flight, so a burst of readers
 * during that window shares the one call rather than starting more.
 *
 * That is the ENTIRE mechanism by which a deadline shorter than the upstream
 * still makes the page fast. Replacing `withTimeout` with an AbortController, or
 * moving the store to the caller's side, would silently disable this feature
 * while every test kept passing — the cache would simply never fill on the path
 * that actually populates it.
 */
const trendingForPrefetch = withTtlCache(
  async (): Promise<Entry[] | null> => {
    const posts = await getPostsRanked('trending', '', '', '', DEFAULT_OBSERVER, PREFETCH_LIMIT);
    if (!posts || posts.length === 0) return null;
    const merged = await mergeLumenEngagement(posts);
    return trimForSSR(filterBannedEntries(merged));
  },
  () => 'home-trending-prefetch',
  {
    ttlMs: FORTY_FIVE_SECONDS_MS,
    staleWhileRevalidateMs: ONE_HOUR_MS,
    max: 1,
    shouldCache: (entries) => Array.isArray(entries) && entries.length > 0
  }
);

async function prefetchTrending(): Promise<Entry[] | null> {
  return trendingForPrefetch();
}

/**
 * Fill the Home feed cache at boot, so the first reader after a deploy does not
 * race a deadline they are built to lose.
 *
 * Exactly the argument `warm-server-caches.ts` already makes for the sibling
 * trending-TAGS prefetch: "a cold entry is no longer just a slow sidebar, it is
 * 600ms of prefetch deadline that the first readers after a restart would each
 * race and lose." This is the expensive half of the same page. A restart is
 * precisely when somebody is watching.
 *
 * Returns the promise so the warmer can time and log it; it swallows nothing —
 * `warmServerCaches` owns the failure handling, and a failed warm just means the
 * first reader pays the read, which is today's behaviour.
 */
export async function warmHomeFeedCache(): Promise<void> {
  await trendingForPrefetch();
}

async function prefetchStoredFeed(viewer: string): Promise<InitialFeedSeed | null> {
  const stored = await readViewerFeed(viewer);
  if (!stored || stored.entries.length === 0) return null;
  // The API route refuses to serve a stored feed past the abandon ceiling
  // (it falls back to trending + starts a rebuild). The SSR seed must do the
  // same, or a stale feed would be served as initialData with staleTime:
  // Infinity and the client would never discover the staleness.
  const age = Date.now() - stored.at;
  if (age >= feedBands().abandonMs) return null;
  // A version mismatch means the ranking WEIGHTS changed; the content is stale
  // even though the timestamp looks recent.
  if (stored.version !== feedVersion()) return null;
  let entries = filterBannedEntries(stored.entries);
  // Apply the viewer's block list server-side so blocked authors never appear
  // in the SSR HTML. Degrades open on failure, same as the API route.
  try {
    const session = await getLiteSession();
    const blockedKeys = await viewerBlockedKeySet(session.user).catch(() => new Set<string>());
    if (blockedKeys.size > 0) {
      entries = await filterBlockedForViewer(entries, blockedKeys);
    }
  } catch {
    // Block list unavailable: serve unfiltered, same as the API route's own catch.
  }
  if (entries.length === 0) return null;
  const page: InitialFeedPage = {
    entries: trimForSSR(entries),
    source: 'recsys',
    personalised: true,
    nextCursor: cursorOf(entries)
  };
  return { page, at: stored.at };
}

/**
 * Prefetch the home feed for SSR. Returns null on any failure -- the client
 * falls back to its own fetch, identical to today's behavior.
 *
 * Anonymous: trending posts from the Hive node, same as the API route's fallback.
 * Signed-in: the viewer's stored ranking from Postgres/memory, if one exists.
 */
export async function prefetchHomeFeed(viewer: string): Promise<InitialFeedSeed | null> {
  try {
    if (viewer) {
      const stored = await withTimeout(prefetchStoredFeed(viewer), PREFETCH_TIMEOUT_MS);
      if (stored) return stored;
      // ★★★ STORED FEED STALE OR MISSING -> DO NOT LEAVE HOME UNSEEDED (2026-09-03).
      // A signed-in reader whose stored feed is not fresh (e.g. the ranker is
      // slow, so the warmer cannot rebuild it) used to seed nothing here and the
      // client then paid the full ranked cold-build (~5-12s) with a blank home.
      // Fall through to the trending fallback, block-filtered for this viewer,
      // so home paints instantly; `personalised: false` tells feed-tabs to
      // refetch on mount and swap in the ranked feed when it is ready. Same
      // resilience as the signed-in topic seed.
    }
    const entries = await withTimeout(prefetchTrending(), PREFETCH_TIMEOUT_MS);
    if (!entries || entries.length === 0) return null;
    let seedEntries = entries;
    if (viewer) {
      // ★ Block-filter the fallback seed the SAME way the stored path does
      // (prefetchStoredFeed above): an unbounded await on the block list, which
      // lives in local Postgres and is fast. An earlier version raced this
      // against a 500ms timer to guarantee an instant paint, but losing that
      // race served the seed UNFILTERED, so a blocked/muted author could paint
      // in home SSR and stay visible until the on-mount ranked refetch resolved
      // (up to ~12s). A blocked author leaking is never an acceptable trade for
      // a few hundred ms; the stored path already awaits this unraced.
      try {
        const session = await getLiteSession();
        const blockedKeys = await viewerBlockedKeySet(session.user).catch(() => new Set<string>());
        if (blockedKeys.size > 0) seedEntries = await filterBlockedForViewer(seedEntries, blockedKeys);
      } catch {
        // Block list unavailable: serve unfiltered, same as the stored path and
        // the API route's own catch.
      }
    }
    const page: InitialFeedPage = {
      entries: seedEntries,
      source: 'trending-fallback',
      // No `degraded` for a signed-in reader (they are not anonymous, and a
      // populated seed is not a degraded state); the anonymous seed keeps its
      // existing flag for its own empty-state copy. `awaitingRank` tells
      // feed-tabs to fetch the ranked feed and swap it in — ONLY for a
      // signed-in reader; the anonymous trending seed is final and must NOT
      // trigger a refetch behind every (edge-cached) home view.
      ...(viewer ? { awaitingRank: true as const } : { degraded: 'anonymous' as const }),
      personalised: false,
      nextCursor:
        seedEntries.length > 0
          ? { author: seedEntries[seedEntries.length - 1].author, permlink: seedEntries[seedEntries.length - 1].permlink }
          : null
    };
    return { page, at: Date.now() };
  } catch (error) {
    logger.warn('feed-prefetch: SSR prefetch failed, client will fetch: %o', error);
    return null;
  }
}
