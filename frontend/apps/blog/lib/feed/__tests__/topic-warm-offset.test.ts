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
 * `clusterWorkerIndex`, and the epoch-aligned slot grid `topic-warmer.ts` puts
 * its repeating cycles on.
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
  resolveWorkerIndex,
  slotStartMs,
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

console.log('\nslotStartMs: the repeats sit on a SHARED epoch grid, not on this process');
// Prod shape: 3 workers, 600000ms interval -> slots at +0s / +200s / +400s past
// every ten-minute epoch boundary.
const EPOCH_SLOT = 1_756_999_800_000; // a real instant that is a whole multiple of 600000
check('the fixture instant really is on a slot boundary', EPOCH_SLOT % INTERVAL === 0);
check('index 0, exactly on its slot -> now', slotStartMs(EPOCH_SLOT, 0, WORKERS, INTERVAL) === EPOCH_SLOT);
check('index 1, at the boundary -> +200000ms', slotStartMs(EPOCH_SLOT, 1, WORKERS, INTERVAL) === EPOCH_SLOT + 200_000);
check('index 2, at the boundary -> +400000ms', slotStartMs(EPOCH_SLOT, 2, WORKERS, INTERVAL) === EPOCH_SLOT + 400_000);

// JUST BEFORE / JUST AFTER a slot - the two cases an off-by-one would flip.
check(
  'index 1, 1ms before its slot -> that same slot',
  slotStartMs(EPOCH_SLOT + 199_999, 1, WORKERS, INTERVAL) === EPOCH_SLOT + 200_000
);
check(
  'index 1, exactly on its slot -> that slot (not a whole interval later)',
  slotStartMs(EPOCH_SLOT + 200_000, 1, WORKERS, INTERVAL) === EPOCH_SLOT + 200_000
);
check(
  'index 1, 1ms after its slot -> the NEXT one, one interval on',
  slotStartMs(EPOCH_SLOT + 200_001, 1, WORKERS, INTERVAL) === EPOCH_SLOT + 800_000
);
check(
  'index 0, 1ms after the boundary -> the next boundary',
  slotStartMs(EPOCH_SLOT + 1, 0, WORKERS, INTERVAL) === EPOCH_SLOT + INTERVAL
);

// ★ THE WHOLE POINT: three workers that booted at wildly different times (the
// observed 18:01:17 / 18:04:52 / 18:07:14) still land on the same grid, exactly
// interval/count apart, because the origin is the epoch and not their own start.
const bootTimes = [EPOCH_SLOT + 77_000, EPOCH_SLOT + 292_000, EPOCH_SLOT + 434_000];
const landed = bootTimes.map((t, index) => slotStartMs(t, index, WORKERS, INTERVAL));
check(
  `workers booting ${(bootTimes[2] - bootTimes[0]) / 1000}s apart still land on distinct slots: ${landed.join(', ')}`,
  new Set(landed.map((t) => t % INTERVAL)).size === WORKERS
);
for (const index of [0, 1, 2]) {
  check(
    `index ${index} lands on its own slot regardless of boot time`,
    landed[index] % INTERVAL === index * (INTERVAL / WORKERS)
  );
}
// NEGATIVE CONTROL: the schedule this replaces (boot time + a relative phase)
// would have put two of those three workers within a cycle length of each other.
const relative = bootTimes.map((t, index) => t + index * (INTERVAL / WORKERS));
const gaps = [relative[1] - relative[0], relative[2] - relative[1]];
check(
  `negative control: the old per-process phase gave gaps of ${gaps.map((g) => g / 1000).join('s, ')}s, not a clean ${INTERVAL / WORKERS / 1000}s`,
  gaps.some((g) => g !== INTERVAL / WORKERS)
);

console.log('\nslotStartMs: degenerate inputs never produce a broken schedule');
check('workerCount 1 -> plain interval boundaries', slotStartMs(EPOCH_SLOT + 1, 0, 1, INTERVAL) === EPOCH_SLOT + INTERVAL);
check('workerCount 1, index ignored', slotStartMs(EPOCH_SLOT + 1, 2, 1, INTERVAL) === EPOCH_SLOT + INTERVAL);
check('interval 0 -> now (fire as soon as you like)', slotStartMs(EPOCH_SLOT, 1, WORKERS, 0) === EPOCH_SLOT);
check('interval NaN -> now', slotStartMs(EPOCH_SLOT, 1, WORKERS, Number.NaN) === EPOCH_SLOT);
check('now NaN -> 0 rather than NaN', slotStartMs(Number.NaN, 1, WORKERS, INTERVAL) === 0);
check('an epoch before the offset still resolves forward', slotStartMs(0, 2, WORKERS, INTERVAL) === 400_000);

// An interval that does not divide evenly: slots must still be distinct, whole,
// inside one period, and always at or after `now`.
const ODD = 100_000;
for (const index of [0, 1, 2]) {
  for (const now of [EPOCH_SLOT, EPOCH_SLOT + 1, EPOCH_SLOT + 33_333, EPOCH_SLOT + 99_999]) {
    const t = slotStartMs(now, index, WORKERS, ODD);
    check(
      `odd interval, index ${index}, now +${now - EPOCH_SLOT}: t=${t - EPOCH_SLOT} is forward, whole and on the slot`,
      Number.isInteger(t) && t >= now && t - now < ODD && t % ODD === topicWarmOffsetMs(index, WORKERS, ODD)
    );
  }
}

// The BOOT cycle is unchanged: every worker still warms within a minute.
for (const index of [0, 1, 2]) {
  check(
    `index ${index}: boot cycle within 60s of start (was up to 400s)`,
    workerStaggerMs(index, FIRST_STAGGER) <= 60_000
  );
}

if (failures === 0) {
  console.log('\ntopic-warm-offset: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\ntopic-warm-offset: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
