/**
 * `topic-warm-offset.ts` invariants - plain assertions, no test runner (this repo
 * has none; same style as topic-warm-select.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/__tests__/topic-warm-offset.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: the offsets are the whole fix, and every way they break is
 * SILENT. If they collapse to 0 the three cluster workers go back to warming in
 * the same instant (116 overlapping cycles in 24h, the state this replaces) and
 * nothing fails - the site simply hammers a public node three times over. So the
 * inputs that can collapse them are pinned here rather than the arithmetic
 * alone: the env reads (`workerCountFromEnv`, `workerIndexFromEnv`) against
 * missing/garbage/"0"/negative values, the cluster read (`currentWorkerId`)
 * against a cluster object that has no worker, the respawn wrap in
 * `clusterWorkerIndex`, and the two schedules `topic-warmer.ts` builds from them.
 *
 * WHAT IT DOES NOT COVER, and what does: nothing here executes a real
 * `cluster.fork()` or a real `process.env` - both are injected. The real cluster
 * path was proven separately with a throwaway fork probe (three workers, ids
 * 1/2/3, one killed and its index reused by the respawn), and by the
 * `topic-warmer: starting` line every worker logs on the box.
 */
import {
  clusterWorkerIndex,
  currentWorkerId,
  repeatPhaseDelayMs,
  resolveWorkerIndex,
  topicWarmOffsetMs,
  workerCountFromEnv,
  workerIndexFromEnv,
  workerStaggerMs
} from '../topic-warm-offset';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

/** Production's actual shape: LUMEN_WORKERS=3, FEED_TOPIC_WARM_INTERVAL_MS unset. */
const WORKERS = 3;
const INTERVAL = 10 * 60_000;
const FIRST_STAGGER = 30_000;
const BOOT_STAGGER = 1_500;

console.log('\nworkerCountFromEnv: the count can only ever be a sane worker count');
check('missing -> 1', workerCountFromEnv({}) === 1);
check('"3" -> 3', workerCountFromEnv({ LUMEN_WORKERS: '3' }) === 3);
check('"0" -> 1', workerCountFromEnv({ LUMEN_WORKERS: '0' }) === 1);
check('"-2" -> 1', workerCountFromEnv({ LUMEN_WORKERS: '-2' }) === 1);
check('"" -> 1', workerCountFromEnv({ LUMEN_WORKERS: '' }) === 1);
check('"three" -> 1', workerCountFromEnv({ LUMEN_WORKERS: 'three' }) === 1);
check('"3.9" -> 3 (floored)', workerCountFromEnv({ LUMEN_WORKERS: '3.9' }) === 3);

console.log('\nworkerIndexFromEnv: garbage is undefined, NEVER 0 (0 is a real slot)');
check('missing -> undefined', workerIndexFromEnv({}) === undefined);
check('"" -> undefined (Number("") is 0, which would be a real slot)', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '' }) === undefined);
check('"   " -> undefined', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '   ' }) === undefined);
check('"abc" -> undefined', workerIndexFromEnv({ LUMEN_WORKER_INDEX: 'abc' }) === undefined);
check('"-1" -> undefined', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '-1' }) === undefined);
check('"1.5" -> undefined', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '1.5' }) === undefined);
check('"0" -> 0', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '0' }) === 0);
check('"2" -> 2', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '2' }) === 2);
check('"3" -> 3', workerIndexFromEnv({ LUMEN_WORKER_INDEX: '3' }) === 3);

console.log('\ncurrentWorkerId: a cluster object without a worker is not a worker');
check('injected {} -> undefined', currentWorkerId({}) === undefined);
check('injected { worker: null } -> undefined', currentWorkerId({ worker: null }) === undefined);
check('injected { worker: {} } -> undefined', currentWorkerId({ worker: {} }) === undefined);
check('injected { worker: { id: 0 } } -> undefined (ids are 1-based)', currentWorkerId({ worker: { id: 0 } }) === undefined);
check('injected { worker: { id: 2 } } -> 2', currentWorkerId({ worker: { id: 2 } }) === 2);
check('no argument in this (unclustered) test process -> undefined', currentWorkerId() === undefined);

console.log('\nresolveWorkerIndex: the primary\'s explicit index WINS over the cluster id');
check(
  'env index 2 beats cluster id 1',
  resolveWorkerIndex(WORKERS, { LUMEN_WORKER_INDEX: '2' }, { worker: { id: 1 } }) === 2
);
check(
  '★ THE RESPAWN CASE: cluster id 4 would collide on slot 0; the env index keeps slot 1',
  resolveWorkerIndex(WORKERS, { LUMEN_WORKER_INDEX: '1' }, { worker: { id: 4 } }) === 1
);
check(
  'negative control: WITHOUT the env index, cluster id 4 does collide with slot 0',
  resolveWorkerIndex(WORKERS, {}, { worker: { id: 4 } }) === 0 &&
    resolveWorkerIndex(WORKERS, {}, { worker: { id: 1 } }) === 0
);
check(
  'garbage env index falls back to the cluster id rather than pinning slot 0',
  resolveWorkerIndex(WORKERS, { LUMEN_WORKER_INDEX: 'abc' }, { worker: { id: 3 } }) === 2
);
check(
  'an out-of-range env index lands on a real slot (9 % 3)',
  resolveWorkerIndex(WORKERS, { LUMEN_WORKER_INDEX: '9' }, {}) === 0
);
check('not clustered at all -> 0', resolveWorkerIndex(WORKERS, {}, {}) === 0);
check('workerCount 0 -> 0', resolveWorkerIndex(0, { LUMEN_WORKER_INDEX: '2' }, {}) === 0);
check('workerCount NaN -> 0', resolveWorkerIndex(Number.NaN, { LUMEN_WORKER_INDEX: '2' }, {}) === 0);

console.log('\nclusterWorkerIndex: the fallback path, including the respawn wrap');
check('id 1 of 3 -> 0', clusterWorkerIndex(1, WORKERS) === 0);
check('id 3 of 3 -> 2', clusterWorkerIndex(3, WORKERS) === 2);
check('id 4 of 3 -> 0 (wraps, does not run an interval late)', clusterWorkerIndex(4, WORKERS) === 0);
check('id 99 of 3 -> 2', clusterWorkerIndex(99, WORKERS) === 2);
check('undefined -> 0', clusterWorkerIndex(undefined, WORKERS) === 0);
check('id 0 -> 0', clusterWorkerIndex(0, WORKERS) === 0);
check('count 0 -> 0', clusterWorkerIndex(2, 0) === 0);

console.log('\ntopicWarmOffsetMs: the STEADY-STATE phase, one third of an interval apart');
check('index 0 -> 0ms', topicWarmOffsetMs(0, WORKERS, INTERVAL) === 0);
check('index 1 -> 200000ms', topicWarmOffsetMs(1, WORKERS, INTERVAL) === 200_000);
check('index 2 -> 400000ms', topicWarmOffsetMs(2, WORKERS, INTERVAL) === 400_000);
check('index 3 -> 0ms (out of range, wraps)', topicWarmOffsetMs(3, WORKERS, INTERVAL) === 0);
check('negative index -> 0ms', topicWarmOffsetMs(-1, WORKERS, INTERVAL) === 0);
check('count 1 -> 0ms (single process)', topicWarmOffsetMs(0, 1, INTERVAL) === 0);
check('count NaN -> 0ms', topicWarmOffsetMs(2, Number.NaN, INTERVAL) === 0);
check('interval 0 -> 0ms', topicWarmOffsetMs(2, WORKERS, 0) === 0);
check('interval NaN -> 0ms', topicWarmOffsetMs(2, WORKERS, Number.NaN) === 0);
check('interval negative -> 0ms', topicWarmOffsetMs(2, WORKERS, -600_000) === 0);
// An interval that does not divide evenly must still give whole ms inside one period.
check('index 1, 100000ms -> 33333ms', topicWarmOffsetMs(1, WORKERS, 100_000) === 33_333);
check('index 2, 100000ms -> 66666ms', topicWarmOffsetMs(2, WORKERS, 100_000) === 66_666);
for (const index of [0, 1, 2, 3, 4]) {
  const offset = topicWarmOffsetMs(index, WORKERS, 100_000);
  check(
    `index ${index}: offset ${offset} is a whole number inside [0, interval)`,
    Number.isInteger(offset) && offset >= 0 && offset < 100_000
  );
}

console.log('\nworkerStaggerMs: the fixed step (boot warm 1.5s, first topic cycle 30s)');
check('index 0, 1500 -> 0ms', workerStaggerMs(0, BOOT_STAGGER) === 0);
check('index 1, 1500 -> 1500ms', workerStaggerMs(1, BOOT_STAGGER) === 1_500);
check('index 2, 1500 -> 3000ms', workerStaggerMs(2, BOOT_STAGGER) === 3_000);
check('index 2, 30000 -> 60000ms', workerStaggerMs(2, FIRST_STAGGER) === 60_000);
check('negative index -> 0ms', workerStaggerMs(-1, BOOT_STAGGER) === 0);
check('step 0 -> 0ms', workerStaggerMs(2, 0) === 0);
check('step NaN -> 0ms', workerStaggerMs(2, Number.NaN) === 0);

console.log('\nrepeatPhaseDelayMs: first cycles land early, steady state stays evenly phased');
check('index 0 -> 0ms', repeatPhaseDelayMs(0, WORKERS, INTERVAL, FIRST_STAGGER) === 0);
check('index 1 -> 170000ms (200000 - 30000)', repeatPhaseDelayMs(1, WORKERS, INTERVAL, FIRST_STAGGER) === 170_000);
check('index 2 -> 340000ms (400000 - 60000)', repeatPhaseDelayMs(2, WORKERS, INTERVAL, FIRST_STAGGER) === 340_000);
// THE POINT OF THE SUBTRACTION: first-cycle time + phase delay is the same
// `index * interval/count` for every worker, so the repeats stay evenly spread.
for (const index of [0, 1, 2]) {
  const firstAt = workerStaggerMs(index, FIRST_STAGGER);
  const repeatAt = firstAt + repeatPhaseDelayMs(index, WORKERS, INTERVAL, FIRST_STAGGER);
  check(
    `index ${index}: repeats begin at ${repeatAt}ms = index * interval/count`,
    repeatAt === index * (INTERVAL / WORKERS)
  );
}
// And the first cycles themselves are inside a minute of the restart.
for (const index of [0, 1, 2]) {
  check(
    `index ${index}: first cycle within 60s of boot (was up to 400s)`,
    workerStaggerMs(index, FIRST_STAGGER) <= 60_000
  );
}
// Degenerate: a stagger wider than the share must clamp, never go negative.
check(
  'a 30s stagger on a 60s interval clamps to 0 rather than going negative',
  repeatPhaseDelayMs(2, WORKERS, 60_000, FIRST_STAGGER) === 0
);

if (failures === 0) {
  console.log('\ntopic-warm-offset: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\ntopic-warm-offset: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
