/**
 * `readViewerFeed`: a worker's in-memory copy must not outlive a newer stored build.
 * Plain assertions, no test runner (same style as feed-prefetch-fallback-floor.test.ts):
 * the repositories are replaced by pre-populating `require.cache` at their resolved
 * paths before `feed-cache` is required, so no database is touched.
 *
 * WHY (2026-09-24): production runs three workers and the memory tier is per worker
 * with no expiry. A rebuild updated one worker; the other two kept serving their old
 * copy until they restarted (the owner was served a page with 10 of 10 already-seen
 * posts one minute after the store held a new one). Exits 0 when every check passes.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/feed-cache-memory-vs-store.test.ts
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

const entry = (author: string): Entry => ({ author, permlink: 'p' }) as unknown as Entry;

const state = {
  storedBuiltAt: null as Date | null,
  stampThrows: false,
  storedEntries: [entry('stored')] as Entry[],
  fullReads: 0
};

function injectMock(specifier: string, exportsObj: Record<string, unknown>): void {
  const resolved = require.resolve(specifier);
  (require.cache as Record<string, unknown>)[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: []
  };
}

injectMock('@/blog/lib/lite/config', { liteConfig: { databaseUrl: 'postgres://mock' } });
injectMock('@/blog/lib/lite/repositories/feed-store-repository', {
  findStoredFeed: async () => {
    state.fullReads++;
    return state.storedBuiltAt
      ? {
          entries: state.storedEntries,
          ranked: 1,
          builtAt: state.storedBuiltAt,
          builtLimit: 45,
          feedVersion: 'v',
          lanes: []
        }
      : null;
  },
  findStoredFeedBuiltAt: async () => {
    if (state.stampThrows) throw new Error('db down');
    return state.storedBuiltAt;
  },
  putStoredFeed: async () => undefined,
  deleteStoredFeed: async () => undefined,
  sweepStoredFeeds: async () => ({ expired: 0, overCap: 0 })
});
injectMock('@/blog/lib/lite/repositories/feed-served-repository', {
  recordServedPage: async () => ({ recorded: 0 }),
  sweepServedFeeds: async () => ({ expired: 0, perViewerOverCap: 0, overCap: 0 })
});
injectMock('@/blog/lib/lite/repositories/feed-seen-repository', {
  hardRatioBound: () => 8,
  markViewerTainted: async () => 0,
  isOverHardBound: () => false,
  hardRecentDeliveriesBound: () => 30,
  recordFeedSeen: async () => ({ written: 0 }),
  seenImpressionRatios: async () => [],
  sweepFeedSeen: async () => ({ expired: 0, untainted: 0 }),
  warnRatioBound: () => 4
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const feedCache = require('../feed/feed-cache') as typeof import('../feed/feed-cache');

async function main(): Promise<void> {
  // Put a copy in THIS worker's memory the way a build does (memory stamped now).
  await feedCache.writeViewerFeed({
    viewer: 'v1',
    entries: [entry('memory')],
    ranked: 1,
    builtLimit: 45,
    lanes: [],
    startedAtGeneration: feedCache.viewerGeneration('v1')
  } as Parameters<typeof feedCache.writeViewerFeed>[0]);

  // 1. The store's row is the same build (stamped a few ms later): memory answers, no full read.
  state.storedBuiltAt = new Date(Date.now() + 50);
  state.fullReads = 0;
  let got = await feedCache.readViewerFeed('v1');
  check('same build in the store: the memory copy is served', got?.entries[0]?.author === 'memory', JSON.stringify(got?.entries));
  check('...without pulling the full stored row', state.fullReads === 0, `fullReads=${state.fullReads}`);

  // 2. Another worker (or the warmer) built a newer one: the store wins and replaces memory.
  state.storedBuiltAt = new Date(Date.now() + 60_000);
  state.storedEntries = [entry('newer')];
  state.fullReads = 0;
  got = await feedCache.readViewerFeed('v1');
  check('a newer stored build is served instead of the old memory copy', got?.entries[0]?.author === 'newer', JSON.stringify(got?.entries));
  check('...by one full read', state.fullReads === 1, `fullReads=${state.fullReads}`);
  state.fullReads = 0;
  got = await feedCache.readViewerFeed('v1');
  check('...and memory now holds it, so the next read needs no full read', got?.entries[0]?.author === 'newer' && state.fullReads === 0, `fullReads=${state.fullReads}`);

  // 3. The stamp read fails: the memory copy is served, as before this change.
  state.stampThrows = true;
  state.storedBuiltAt = new Date(Date.now() + 120_000);
  state.storedEntries = [entry('even-newer')];
  state.fullReads = 0;
  got = await feedCache.readViewerFeed('v1');
  check('a failed stamp read serves the memory copy', got?.entries[0]?.author === 'newer', JSON.stringify(got?.entries));
  check('...and does not attempt the full read', state.fullReads === 0, `fullReads=${state.fullReads}`);
}

main()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.log(`FAIL — the suite itself threw: ${String(err)}`);
    process.exit(1);
  });
