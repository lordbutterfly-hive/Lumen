import { getPostsRanked } from '@transaction/lib/bridge-api';
import { getLogger } from '@ui/lib/logging';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { filterBannedEntries } from '@/blog/lib/moderation/banned-authors';
import { filterBlockedForViewer, viewerBlockedKeySet } from '@/blog/lib/lite/social/block-filter';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { readViewerFeed, feedBands, feedVersion } from '@/blog/lib/feed/feed-cache';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import type { InitialFeedSeed, InitialFeedPage } from '@/blog/components/observer-provider';
import { renderStopwatch, type RenderStopwatch, type RenderTimer } from '@ui/lib/render-timing';

const logger = getLogger('app');

/**
 * ★ WHAT THE HOME RENDER'S ONE TIMING LINE NEEDS FROM THIS PREFETCH (2026-09-05).
 *
 * `app/page.tsx` emits a single `render-timing: home ...` line and this is how the
 * facts that only exist in here reach it: whether the viewer's stored (recsys)
 * feed was a hit, a miss, stale or simply never answered inside the deadline, and
 * what the three sub-stages cost. Filled in by `prefetchHomeFeed`; the caller
 * allocates it with `newHomeFeedTrace()` and reads it after the await.
 *
 * ★ OPTIONAL AND WRITE-ONLY, AND ITS ABSENCE IS THE OFF SWITCH. Nothing in this
 * module ever READS a trace field to decide anything -- a trace is an observer,
 * never a participant. `app/page.tsx` allocates one only when
 * `LUMEN_RENDER_TIMING=yes`, so with the flag off this module allocates no trace,
 * no stopwatch, and reads no clock at all: see `stopwatchIf` below. That is why
 * the gate is `trace` itself rather than a second `renderTimingEnabled()` read.
 *
 * ★ `-1` MEANS NOT MEASURED, never "took no time". Same convention
 * `renderStopwatch()` documents, and it is the honest answer for a stage the path
 * taken never ran (a stored-feed miss never reaches the trim; a fallback seed is
 * trimmed inside the cached trending loader, so no trim happens per render at all).
 */
export interface HomeFeedTrace {
  /** `skip` = anonymous, so no stored feed was ever looked for. */
  stored: 'skip' | 'hit' | 'miss' | 'stale' | 'empty' | 'timeout';
  source: 'none' | 'recsys' | 'trending-fallback';
  /** True only for the personalised stored feed -- i.e. `page.personalised`. */
  ranked: boolean;
  count: number;
  /** ms in `readViewerFeed` (memory, then `findStoredFeed`'s Postgres row). */
  readMs: number;
  /** ms in the viewer's block-list filter, on whichever path applied it. */
  blockMs: number;
  /** ms in `trimForSSR`, stored path only. */
  trimMs: number;
}

/**
 * ★ THE INSTRUMENT MUST COST NOTHING WHEN IT IS OFF (2026-09-05, review). An
 * ungated `renderStopwatch()` is an object plus a `performance.now()`, and one
 * signed-in home render reaches four of them -- eight clock reads charged to
 * every production render to measure nothing. `renderStopwatch` is deliberately
 * flag-INDEPENDENT (its own doc: the CALLER decides to start one), which makes
 * this gate the caller's job, not the helper's.
 *
 * `null`, and the -1 it reads back as, mean NOT MEASURED -- exactly what the
 * flag-off case is. The same -1 already covers a stage the path taken never ran,
 * and neither is ever confusable with "took no time".
 */
function stopwatchIf(on: boolean): RenderStopwatch | null {
  return on ? renderStopwatch() : null;
}

function elapsedOf(watch: RenderStopwatch | null): number {
  return watch ? watch.elapsedMs() : -1;
}

export function newHomeFeedTrace(): HomeFeedTrace {
  return {
    stored: 'skip',
    source: 'none',
    ranked: false,
    count: 0,
    readMs: -1,
    blockMs: -1,
    trimMs: -1
  };
}

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

/**
 * ★ THE OUTCOME TRAVELS WITH THE SEED, RATHER THAN THROUGH A SHARED OBJECT
 * (2026-09-05, home instrument). Every `return null` below means something
 * DIFFERENT -- nothing stored, too old, wrong ranking version, filtered to empty
 * -- and the home timing line has to tell them apart, because "the stored feed
 * was stale" and "the store had nothing" call for opposite fixes.
 *
 * It is returned rather than written into the caller's trace on purpose. This
 * function is RACED by `withTimeout`, which deliberately does not cancel the
 * loser (see that function and the cache comment above), so a version that wrote
 * into shared state could still be running -- and could overwrite `stored=` with
 * a late `hit` -- while the fallback path it lost to was being timed. A value the
 * caller only reads when it actually consumed it cannot do that.
 *
 * NOTHING ABOUT THE CONTROL FLOW MOVES: the same four early exits happen at the
 * same points, and `seed` is exactly the `InitialFeedSeed | null` this used to
 * return.
 */
interface StoredFeedRead {
  seed: InitialFeedSeed | null;
  outcome: 'hit' | 'miss' | 'stale' | 'empty';
  readMs: number;
  blockMs: number;
  trimMs: number;
}

async function prefetchStoredFeed(viewer: string, timing: boolean): Promise<StoredFeedRead> {
  const readWatch = stopwatchIf(timing);
  const stored = await readViewerFeed(viewer);
  const readMs = elapsedOf(readWatch);
  const nothing = (outcome: StoredFeedRead['outcome'], blockMs = -1, trimMs = -1): StoredFeedRead => ({
    seed: null,
    outcome,
    readMs,
    blockMs,
    trimMs
  });
  if (!stored || stored.entries.length === 0) return nothing('miss');
  // The API route refuses to serve a stored feed past the abandon ceiling
  // (it falls back to trending + starts a rebuild). The SSR seed must do the
  // same, or a stale feed would be served as initialData with staleTime:
  // Infinity and the client would never discover the staleness.
  const age = Date.now() - stored.at;
  if (age >= feedBands().abandonMs) return nothing('stale');
  // A version mismatch means the ranking WEIGHTS changed; the content is stale
  // even though the timestamp looks recent.
  if (stored.version !== feedVersion()) return nothing('stale');
  let entries = filterBannedEntries(stored.entries);
  // Apply the viewer's block list server-side so blocked authors never appear
  // in the SSR HTML. Degrades open on failure, same as the API route.
  const blockWatch = stopwatchIf(timing);
  try {
    const session = await getLiteSession();
    const blockedKeys = await viewerBlockedKeySet(session.user).catch(() => new Set<string>());
    if (blockedKeys.size > 0) {
      entries = await filterBlockedForViewer(entries, blockedKeys);
    }
  } catch {
    // Block list unavailable: serve unfiltered, same as the API route's own catch.
  }
  const blockMs = elapsedOf(blockWatch);
  if (entries.length === 0) return nothing('empty', blockMs);
  const trimWatch = stopwatchIf(timing);
  const page: InitialFeedPage = {
    entries: trimForSSR(entries),
    source: 'recsys',
    personalised: true,
    nextCursor: cursorOf(entries)
  };
  const trimMs = elapsedOf(trimWatch);
  return { seed: { page, at: stored.at }, outcome: 'hit', readMs, blockMs, trimMs };
}

/**
 * Prefetch the home feed for SSR. Returns null on any failure -- the client
 * falls back to its own fetch, identical to today's behavior.
 *
 * Anonymous: trending posts from the Hive node, same as the API route's fallback.
 * Signed-in: the viewer's stored ranking from Postgres/memory, if one exists.
 *
 * ★ `timer` AND `trace` ARE INSTRUMENTS, BOTH OPTIONAL (2026-09-05). The signed-in
 * home render is the owner's cold complaint and every deadline that can cost it a
 * second lives in this function, so `app/page.tsx` passes its own `RenderTimer`
 * down rather than emitting a second line here -- one line per render. Neither is
 * ever read to decide anything; omit them and the behaviour is identical (an
 * absent `timer` marks nothing, a disabled one is the shared no-op).
 */
export async function prefetchHomeFeed(
  viewer: string,
  timer?: RenderTimer,
  trace?: HomeFeedTrace
): Promise<InitialFeedSeed | null> {
  try {
    // ★ THE ONE GATE for every stopwatch below and inside `prefetchStoredFeed`:
    // with no trace to write into, nothing is measured, nothing is allocated and
    // no clock is read. `app/page.tsx` only allocates a trace when the flag is on.
    const timing = Boolean(trace);
    // ★★ ONE 700ms BUDGET FOR THE WHOLE SIGNED-IN FALLBACK, NOT TWO (2026-09-05,
    // perf batch C-A). This used to race `prefetchStoredFeed` against its own
    // 700ms deadline and then, on a miss, fall into the trending call below and
    // race THAT against a FRESH 700ms deadline -- up to 1.4s of worst case for a
    // signed-in reader whose stored feed was not ready. The stored read and the
    // trending fallback are one fallback chain, not two independent budgets, so
    // they now share a single clock: whatever time the stored read did not use
    // is what the trending call gets below, and if the clock is already spent,
    // the trending call is skipped rather than started against a budget of
    // zero -- the client's own fetch is still there to catch it, exactly like
    // any other miss. The anonymous path is unaffected: it never enters this
    // block, so `trendingBudgetMs` stays the full `PREFETCH_TIMEOUT_MS` for it.
    let trendingBudgetMs = PREFETCH_TIMEOUT_MS;
    if (viewer) {
      const storedStartedAt = Date.now();
      const stored = await withTimeout(prefetchStoredFeed(viewer, timing), PREFETCH_TIMEOUT_MS);
      // `race` is the whole stored-feed attempt INCLUDING the deadline, so it is
      // capped at PREFETCH_TIMEOUT_MS by construction; `read`/`block`/`trim` on
      // the same line break down what the winner spent it on.
      timer?.mark('race');
      if (trace) {
        // `null` here is the DEADLINE, not an empty store -- `withTimeout`
        // resolves null on expiry and the read itself always resolves an object.
        trace.stored = stored ? stored.outcome : 'timeout';
        trace.readMs = stored?.readMs ?? -1;
        trace.blockMs = stored?.blockMs ?? -1;
        trace.trimMs = stored?.trimMs ?? -1;
      }
      if (stored?.seed) {
        if (trace) {
          trace.source = 'recsys';
          trace.ranked = true;
          trace.count = stored.seed.page.entries.length;
        }
        return stored.seed;
      }
      // ★★★ STORED FEED STALE OR MISSING -> DO NOT LEAVE HOME UNSEEDED (2026-09-03).
      // A signed-in reader whose stored feed is not fresh (e.g. the ranker is
      // slow, so the warmer cannot rebuild it) used to seed nothing here and the
      // client then paid the full ranked cold-build (~5-12s) with a blank home.
      // Fall through to the trending fallback, block-filtered for this viewer,
      // so home paints instantly; `personalised: false` tells feed-tabs to
      // refetch on mount and swap in the ranked feed when it is ready. Same
      // resilience as the signed-in topic seed.
      trendingBudgetMs = PREFETCH_TIMEOUT_MS - (Date.now() - storedStartedAt);
      if (trendingBudgetMs <= 0) return null;
    }
    const entries = await withTimeout(prefetchTrending(), trendingBudgetMs);
    // The trending race. On a TTL-cache hit this is ~0ms and the whole cost of a
    // cold one (`getPostsRanked` + merge + trim) is inside it, which is why there
    // is no separate `trim` figure on this path.
    timer?.mark('trend');
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
      const blockWatch = stopwatchIf(timing);
      try {
        const session = await getLiteSession();
        const blockedKeys = await viewerBlockedKeySet(session.user).catch(() => new Set<string>());
        if (blockedKeys.size > 0) seedEntries = await filterBlockedForViewer(seedEntries, blockedKeys);
      } catch {
        // Block list unavailable: serve unfiltered, same as the stored path and
        // the API route's own catch.
      }
      // Overwrites the stored path's `blockMs`, correctly: we are here only
      // because that path produced no seed, so this is the filter that ran on
      // the entries the reader actually gets.
      if (trace) trace.blockMs = elapsedOf(blockWatch);
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
    // Everything after the trending race: the block filter above (broken out as
    // `block=` on the line) plus building this object.
    timer?.mark('assemble');
    if (trace) {
      trace.source = 'trending-fallback';
      trace.ranked = false;
      trace.count = seedEntries.length;
    }
    return { page, at: Date.now() };
  } catch (error) {
    logger.warn('feed-prefetch: SSR prefetch failed, client will fetch: %o', error);
    return null;
  }
}
