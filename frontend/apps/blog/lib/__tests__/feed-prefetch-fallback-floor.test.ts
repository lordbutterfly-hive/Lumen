/**
 * `prefetchHomeFeed` (lib/feed/feed-prefetch.ts) -- plain assertions, no test
 * runner, same style as `lib/__tests__/server-ttl-cache.test.ts` and
 * `lib/__tests__/module-copies-shared-slots.test.ts`.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/feed-prefetch-fallback-floor.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHAT THIS PROVES (2026-09-06, review of commit a467dba fixing two live
 * defects in `prefetchHomeFeed`):
 *
 *   1. THE EMPTY-HOME DOOR IS NARROWED, NOT CLOSED (worded precisely
 *      2026-09-06 -- "closed" overstated what this actually proves). A
 *      stored-feed attempt whose UNRACED `finishStoredFeed` overruns the
 *      shared 700ms clock (live lines showed `finish=899ms`/`finish=510ms`)
 *      still reaches the trending fallback and gets a seed --
 *      `TRENDING_MIN_BUDGET_MS` floors the budget instead of letting it go
 *      negative and returning null outright. That only helps because
 *      section 0 below warms the trending cache first, same as production
 *      does at boot: `TRENDING_MIN_BUDGET_MS` (250ms) is enough for a WARM
 *      cache's ~0ms cost, not for a COLD `prefetchTrending()` build, which
 *      this file does not exercise and which can still return null within
 *      the floor -- the door narrows from "guaranteed blank" to "blank only
 *      when the trending cache is also cold," it does not remove that case.
 *   2. THE FALLBACK'S OWN BLOCK FILTER IS BOUNDED. When the trending
 *      fallback's block-set lookup exceeds `BLOCK_LOOKUP_TIMEOUT_MS`, the
 *      whole seed is DROPPED (`prefetchHomeFeed` returns null) -- never
 *      served unfiltered.
 *   3. THE FAST PATH IS UNCHANGED. A stored-feed HIT with no delays anywhere
 *      still returns the ranked seed exactly as before, and a fast
 *      (non-timeout) fallback block lookup still filters the seed exactly as
 *      before, rather than being short-circuited by either fix.
 *
 * ★ WHY MODULES ARE MOCKED BY PRE-POPULATING `require.cache` RATHER THAN A
 * MOCKING LIBRARY (this repo has none -- `test:unit` runs each file straight
 * through `ts-node`, no jest). This is the same mechanism
 * `module-copies-shared-slots.test.ts` uses to force a fresh module copy
 * (`delete require.cache[path]; require(path)`); here it runs the OTHER
 * direction -- a fake `{ id, filename, loaded: true, exports }` record is
 * written into `require.cache` at the dependency's OWN resolved path BEFORE
 * `feed-prefetch.ts` is required, so when its compiled `require(...)` calls
 * resolve that same path, Node's module loader returns the fake `exports`
 * without ever touching the real file (Postgres, a live Hive node, or
 * `next/headers` cookies -- none of which exist in this process). Every
 * TypeScript file this module imports for its RUNTIME behaviour (not
 * `import type`) is accounted for below; anything left real
 * (`server-ttl-cache.ts`, `banned-authors.ts`, `render-timing.ts`,
 * `utils.ts`'s `DEFAULT_OBSERVER`) is pure/in-memory and safe to run as-is.
 *
 * ★ TIME IS REAL HERE, NOT MOCKED, same reason `server-ttl-cache.test.ts`
 * gives: the module reads `Date.now()` directly. The mocked dependencies
 * below use real `setTimeout` delays to simulate a slow unseal or a slow
 * block-list read -- this is what makes the floor and the bound observable
 * as actual elapsed wall-clock time, the same way production would hit them.
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';

let checks = 0;
let failures = 0;
const lines: string[] = [];

function out(s: string): void {
  lines.push(s);
}

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    out(`  ok    ${name}`);
  } else {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function fakeEntry(author: string, permlink: string): Entry {
  return { author, permlink, body: `body of ${author}/${permlink}` } as unknown as Entry;
}

// ── mock state, mutated per scenario ─────────────────────────────────────
interface MockState {
  sessionDelays: number[];
  sessionUser: unknown;
  storedRow: { entries: Entry[]; at: number; version: string } | null;
  readDelayMs: number;
  abandonMs: number;
  feedVersionValue: string;
  // ★ PAIRED, SAME QUEUE INDEX (2026-09-06, review fix to this test itself).
  // `blockDelays[i]` and `blockedKeySets[i]` describe the SAME call. Both
  // are shifted SYNCHRONOUSLY the instant `viewerBlockedKeySet` is invoked
  // (before its own `await delay(...)`), never after -- a call that loses
  // its `Promise.race` inside `boundedBlockedKeySet` keeps running in the
  // background (same abandoned-promise shape production's own `withTimeout`
  // has), and shifting AFTER the delay would let that abandoned call steal a
  // LATER scenario's queue entry once it finally resolves. Shifting at call
  // time means a scenario's queue is fully consumed the moment its own calls
  // happen, regardless of when they settle.
  blockDelays: number[];
  blockedKeySets: Array<Set<string>>;
  trendingPosts: Entry[];
  trendingDelayMs: number;
}

const state: MockState = {
  sessionDelays: [],
  sessionUser: { userId: 'viewer-1' },
  storedRow: null,
  readDelayMs: 0,
  abandonMs: 999_999_999,
  feedVersionValue: 'v1',
  blockDelays: [],
  blockedKeySets: [],
  trendingPosts: [],
  trendingDelayMs: 0
};

function resetState(): void {
  state.sessionDelays = [];
  state.sessionUser = { userId: 'viewer-1' };
  state.storedRow = null;
  state.readDelayMs = 0;
  state.abandonMs = 999_999_999;
  state.feedVersionValue = 'v1';
  state.blockDelays = [];
  state.blockedKeySets = [];
  state.trendingPosts = [];
  state.trendingDelayMs = 0;
}

function nextDelay(queue: number[]): number {
  return queue.length > 0 ? (queue.shift() as number) : 0;
}

function nextBlockedKeySet(): Set<string> {
  return state.blockedKeySets.length > 0 ? (state.blockedKeySets.shift() as Set<string>) : new Set<string>();
}

// ── fake modules ──────────────────────────────────────────────────────────
const bridgeApiMock = {
  getPostsRanked: async (..._args: unknown[]): Promise<Entry[] | null> => {
    await delay(state.trendingDelayMs);
    return state.trendingPosts;
  }
};

const engagementRepositoryMock = {
  mergeLumenEngagement: async (posts: Entry[]): Promise<Entry[]> => posts
};

const blockFilterMock = {
  viewerBlockedKeySet: async (_sessionUser: unknown): Promise<Set<string>> => {
    // Both shifted BEFORE the await -- see `MockState.blockDelays`'s own doc.
    const delayMs = nextDelay(state.blockDelays);
    const keys = nextBlockedKeySet();
    await delay(delayMs);
    return keys;
  },
  // Real-ish default: filters by `author` membership, so a scenario that sets
  // a genuine blocked key actually proves filtering ran, not just that the
  // mock was called.
  filterBlockedForViewer: async <T extends Entry>(entries: T[], blockedKeys: Set<string>): Promise<T[]> =>
    entries.filter((entry) => !blockedKeys.has(entry.author))
};

const sessionMock = {
  getLiteSession: async (): Promise<{ user: unknown }> => {
    // Shifted before the await, same reasoning as `viewerBlockedKeySet` above.
    const delayMs = nextDelay(state.sessionDelays);
    await delay(delayMs);
    return { user: state.sessionUser };
  }
};

const feedCacheMock = {
  readViewerFeed: async (
    _viewer: string
  ): Promise<{ entries: Entry[]; at: number; version: string } | null> => {
    await delay(state.readDelayMs);
    return state.storedRow;
  },
  feedBands: (): { abandonMs: number } => ({ abandonMs: state.abandonMs }),
  feedVersion: (): string => state.feedVersionValue
};

// ★ MOCKED TOO, EVEN THOUGH `DEFAULT_OBSERVER` ITSELF IS A PLAIN STRING
// CONSTANT: `lib/utils.ts` also imports `@hive/ui` at module scope for
// unrelated helpers (`proxifyImageSrc`, `Symbol`, `accountReputation`), and
// that barrel transitively pulls in `packages/ui/components/index.tsx`,
// which imports a `.css` file -- something `ts-node` cannot parse as a
// module at all. Only the ONE constant `feed-prefetch.ts` actually uses is
// reproduced here.
const utilsMock = {
  DEFAULT_OBSERVER: 'hive.blog'
};

function injectMock(specifier: string, exportsObj: Record<string, unknown>): void {
  const resolved = require.resolve(specifier);
  const fakeModule = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: []
  };
  (require.cache as Record<string, unknown>)[resolved] = fakeModule;
}

injectMock('@transaction/lib/bridge-api', bridgeApiMock);
injectMock('@/blog/lib/lite/repositories/engagement-repository', engagementRepositoryMock);
injectMock('@/blog/lib/lite/social/block-filter', blockFilterMock);
injectMock('@/blog/lib/lite/http/session', sessionMock);
injectMock('@/blog/lib/feed/feed-cache', feedCacheMock);
injectMock('@/blog/lib/utils', utilsMock);

// Required AFTER every dependency it pulls in at runtime has a fake already
// sitting in `require.cache` at that dependency's resolved path.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const feedPrefetch = require('../feed/feed-prefetch') as typeof import('../feed/feed-prefetch');

// The trending seed all scenarios below observe. `trendingForPrefetch`
// (feed-prefetch.ts) is a module-level singleton `withTtlCache` (45s TTL);
// once warmed below it stays warm for this whole run (every scenario here
// finishes in well under a second of artificial delay, nowhere near 45s), so
// `getPostsRanked` is called exactly ONCE for the entire file and every
// `prefetchTrending()` after that is a cache HIT returning THESE two entries
// -- reassigning `state.trendingPosts` inside a later scenario would have NO
// effect and would be misleading, so nothing below does that.
const TREND_A = fakeEntry('trendauthor', 'p1');
const TREND_B = fakeEntry('trendauthor2', 'p2');

async function main(): Promise<void> {
  // ── 0. warm the trending cache once, like production does at boot ───────
  section('0. warm the trending cache (shared singleton, same as boot)');
  {
    state.trendingPosts = [TREND_A, TREND_B];
    state.trendingDelayMs = 0;
    await feedPrefetch.warmHomeFeedCache();
    check('warm call completes without throwing', true);
  }

  // ── 1. DEFECT 1 FIXED: overrun finish still gets a trending seed ───────
  section('1. stored-feed miss whose UNRACED finish overruns 700ms still seeds trending (the floor)');
  {
    resetState();
    // Fast read: the stored row itself answers instantly and passes the
    // freshness/version checks, so the RACED read never times out.
    state.storedRow = { entries: [fakeEntry('blocked1', 'p1')], at: Date.now(), version: 'v1' };
    state.feedVersionValue = 'v1';
    state.abandonMs = 999_999_999;
    // The slow part is entirely inside the UNRACED `finishStoredFeed`: the
    // `getLiteSession()` unseal that precedes the bounded block lookup is
    // itself unbounded (this is exactly FALSE CLAIM 2's point) -- 750ms here,
    // well past the whole 700ms shared clock, with the read itself instant.
    state.sessionDelays = [750];
    // Block every entry the stored row returned, so the outcome is 'empty'
    // (a real non-seed outcome, not a short-circuit on the read itself).
    state.blockedKeySets = [new Set(['blocked1'])];

    const start = Date.now();
    const result = await feedPrefetch.prefetchHomeFeed('viewer1');
    const elapsed = Date.now() - start;

    check(
      'a stored miss/empty whose finish overran 700ms still returns a seed, not null',
      result !== null,
      `result=${JSON.stringify(result)}`
    );
    check(
      'the seed came from the trending fallback, not the stored path',
      result?.page.source === 'trending-fallback' && result?.page.personalised === false,
      JSON.stringify(result?.page)
    );
    check(
      '★ the OLD bug is provably gone: this run took well over 700ms before the ' +
        'fallback even started, which pre-fix made trendingBudgetMs <= 0 and returned null',
      elapsed > 700,
      `elapsed=${elapsed}ms`
    );
  }

  // ── 2. DEFECT 2 FIXED: fallback's own block lookup, bounded ────────────
  section("2. trending fallback's block-set lookup exceeding its bound drops the seed, never serves unfiltered");
  {
    resetState();
    // Stored path misses immediately (no row at all) -- fast, so the
    // trending fallback gets close to the FULL 700ms budget, not the floor.
    // This isolates the fallback's OWN block-bound from defect 1's floor.
    state.storedRow = null;
    state.readDelayMs = 0;
    // The fallback's block-set lookup itself stalls past BLOCK_LOOKUP_TIMEOUT_MS
    // (500ms) -- e.g. a sick/rate-limiting Hive node per the fix's own comment.
    // Which key is "blocked" is irrelevant here: the call times out before
    // this value is ever consulted, which is exactly the point.
    state.blockDelays = [700];
    state.blockedKeySets = [new Set([TREND_A.author])];

    const trace = feedPrefetch.newHomeFeedTrace();
    const result = await feedPrefetch.prefetchHomeFeed('viewer2', undefined, trace);

    check('a fallback block lookup that exceeds its bound returns NO seed (dropped, not unfiltered)', result === null, JSON.stringify(result));
    check("the trace records the block step as 'timeout', not a fabricated duration", trace.blockMs === 'timeout', String(trace.blockMs));
  }

  // ── 3. EXISTING BEHAVIOUR UNCHANGED: fast stored-feed hit ──────────────
  section('3. fast path unchanged — a clean stored-feed hit still returns the ranked seed');
  {
    resetState();
    state.storedRow = { entries: [fakeEntry('alice', 'p1'), fakeEntry('bob', 'p2')], at: Date.now(), version: 'v1' };
    state.feedVersionValue = 'v1';
    state.abandonMs = 999_999_999;
    state.sessionDelays = [0];
    state.blockedKeySets = [new Set()]; // no blocks

    const trace = feedPrefetch.newHomeFeedTrace();
    const result = await feedPrefetch.prefetchHomeFeed('viewer3', undefined, trace);

    check('a fast, unblocked stored hit returns a seed', result !== null, JSON.stringify(result));
    check(
      'it is the RANKED (recsys) seed, not the trending fallback',
      result?.page.source === 'recsys' && result?.page.personalised === true,
      JSON.stringify(result?.page)
    );
    check('both stored entries are present, unfiltered (nothing was blocked)', result?.page.entries.length === 2, JSON.stringify(result?.page.entries));
    check("the trace agrees: stored='hit', source='recsys'", trace.stored === 'hit' && trace.source === 'recsys', JSON.stringify(trace));
  }

  // ── 4. EXISTING BEHAVIOUR UNCHANGED: fast fallback still filters ───────
  section('4. fast path unchanged — a fallback block lookup WELL under its bound still filters normally');
  {
    resetState();
    state.storedRow = null; // stored miss, fast — reach the fallback quickly
    state.blockDelays = [10]; // well under BLOCK_LOOKUP_TIMEOUT_MS (500ms)
    // Block TREND_B specifically -- the trending seed (warmed in section 0)
    // is [TREND_A, TREND_B], so a real filter leaves exactly TREND_A.
    state.blockedKeySets = [new Set([TREND_B.author])];

    const result = await feedPrefetch.prefetchHomeFeed('viewer4');

    check('the fallback returns a seed (lookup was fast, no timeout)', result !== null, JSON.stringify(result));
    check(
      '★ and it is actually FILTERED — the bounded rewrite still calls filterBlockedForViewer ' +
        'on a non-timeout result, exactly like before',
      result?.page.entries.length === 1 && result?.page.entries[0]?.author === TREND_A.author,
      JSON.stringify(result?.page.entries)
    );
  }

  // ── 5. EXISTING BEHAVIOUR UNCHANGED: anonymous path never touches block filter ──
  section('5. fast path unchanged — the anonymous trending path is untouched by either fix');
  {
    resetState();

    const result = await feedPrefetch.prefetchHomeFeed('');

    check('an anonymous reader still gets the trending seed', result !== null, JSON.stringify(result));
    check(
      "it is marked degraded:'anonymous', never awaitingRank (viewer path only)",
      (result?.page as { degraded?: string }).degraded === 'anonymous' && !('awaitingRank' in (result?.page ?? {})),
      JSON.stringify(result?.page)
    );
  }
}

main()
  .then(() => {
    out('');
    out(
      failures === 0
        ? `PASS — ${checks} checks: empty-home floor and bounded fallback block filter both proven, fast paths unchanged`
        : `FAIL — ${failures} of ${checks} checks failed`
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.log(`${lines.join('\n')}\n\nFAIL — the suite itself threw: ${String(err)}`);
    process.exit(1);
  });
