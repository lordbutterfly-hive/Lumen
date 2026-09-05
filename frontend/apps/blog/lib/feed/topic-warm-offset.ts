/**
 * PURE per-worker WARM OFFSETS - no `server-only`, no chain imports, and every
 * environment read is an injectable argument, so the whole rule is unit testable
 * in isolation (topic-warm-offset.test.ts). Same split, for the same reason, as
 * `topic-warm-select.ts`.
 *
 * ★★★ THE GATE WAS WRITTEN FOR ONE PROCESS; PRODUCTION IS NOW THREE (2026-09-05).
 *
 * `hive-warm-gate.ts` is a `Symbol.for` gate, i.e. ONE SLOT PER PROCESS - which
 * was the correct scope when this app was one process, and its header says so.
 * Production now runs a three-worker Node cluster (`/opt/lumen/cluster.js`,
 * `cluster.fork()` x `LUMEN_WORKERS=3`, a box-only file that is not in this
 * repo), so each worker holds its OWN gate, starts its OWN topic-warm cycle, and
 * all three fire on the same ten-minute boundary. Measured in
 * `/var/log/lumen.log` over 24h: 116 overlapping topic-warm cycles from
 * different pids (`topic-warmer: warmed 35/35 tags in NNNNNms` lines finishing
 * seconds apart), plus 19 topic/viewer overlaps. Three times the burst at a
 * public node we do not own, which is the one thing both warmers say they must
 * never do.
 *
 * ★ WHY NOT ELECT ONE WORKER TO WARM, which is the obvious other answer: what
 * gets warmed is an IN-PROCESS memo. Each worker has its own topic cache, so a
 * single elected warmer would leave the other two workers' caches cold and every
 * reader the cluster routed to them would pay the full upstream cost the warmer
 * exists to remove. Every worker must still warm itself. What must stop is the
 * three of them doing it IN THE SAME INSTANT - so this staggers them
 * deterministically by worker index instead.
 */

/** Just enough of `process.env` to read, so a test can inject one. */
type EnvLike = { readonly [key: string]: string | undefined };

/** Just enough of the cluster module to read, so a test can inject one. */
interface ClusterLike {
  readonly worker?: { readonly id?: number } | null;
}

/* ------------------------------------------------------------------ */
/* Where the index comes from                                          */
/* ------------------------------------------------------------------ */

/**
 * How many workers the cluster was told to fork. `/opt/lumen/cluster.js` reads
 * the same variable, so the two cannot disagree without someone editing one of
 * them. Unset, empty, zero, negative or unparseable all mean ONE - i.e. not
 * clustered, which is also the correct answer for a dev server and a test.
 */
export function workerCountFromEnv(env: EnvLike = process.env): number {
  const raw = Number(env.LUMEN_WORKERS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/**
 * ★★ THE INDEX IS HANDED DOWN BY THE PRIMARY, NOT DERIVED FROM A WORKER ID
 * (2026-09-05, second pass). Deriving it from `cluster.worker.id` is correct
 * exactly once: ids keep INCREMENTING across respawns, so after a single crash
 * the replacement worker is id 4, `(4 - 1) % 3` is 0, and it takes the slot the
 * still-living id 1 already holds. Two workers then warm together on the same
 * phase and one slot sits empty - the collision this module exists to remove,
 * quietly restored, until the next full restart. So `/opt/lumen/cluster.js` owns
 * the mapping and passes `LUMEN_WORKER_INDEX` in the child's env, reusing the
 * DEAD worker's index on a respawn.
 *
 * Returns the parsed 0-based index, or `undefined` when the variable is absent
 * or not a non-negative integer - callers then fall back to the cluster id.
 * Garbage is `undefined` rather than 0 precisely so a typo cannot silently pin
 * every worker to slot 0, which looks exactly like the bug.
 */
export function workerIndexFromEnv(env: EnvLike = process.env): number | undefined {
  const raw = env.LUMEN_WORKER_INDEX;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * This process's cluster worker id, or `undefined` when it is not a cluster
 * worker - a plain `node server.js`, a `next build` worker, or a test.
 *
 * ★ REQUIRED LAZILY, INSIDE A TRY/CATCH, and only ever reached after the
 * callers' existing `NEXT_RUNTIME === 'nodejs'` guard: the cluster module is
 * only ever named in a `require` inside this function, so nothing about it is
 * pulled into a bundle that has no business with it, and a runtime without it
 * degrades to "index 0, no offset" instead of throwing on module load. That
 * degradation is not silent: `topic-warmer: starting` logs the worker and the
 * delays it resolved, so three workers all reporting `worker 1/3` is visible in
 * the first seconds of a deploy.
 */
export function currentWorkerId(source?: ClusterLike): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy on purpose, see above
    const cluster: ClusterLike = source ?? (require('node:cluster') as ClusterLike);
    const id = cluster.worker?.id;
    return typeof id === 'number' && Number.isFinite(id) && id >= 1 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The 0-based index of this worker among `workerCount`, from a `cluster` worker
 * id. THE FALLBACK PATH ONLY - see `workerIndexFromEnv` for why an explicit
 * index beats this one. The modulo keeps a respawned worker's ever-increasing id
 * inside the interval; it cannot keep it in the RIGHT slot, which is the whole
 * reason the primary now says.
 *
 * Not clustered (`undefined`), or a count that is not a positive number, means
 * index 0 - i.e. exactly the single-process behaviour this file replaces.
 */
export function clusterWorkerIndex(workerId: number | undefined, workerCount: number): number {
  if (!Number.isFinite(workerCount) || workerCount < 1) return 0;
  if (workerId === undefined || !Number.isFinite(workerId) || workerId < 1) return 0;
  return (Math.floor(workerId) - 1) % Math.floor(workerCount);
}

/**
 * The index this process should schedule on: the primary's explicit
 * `LUMEN_WORKER_INDEX` when it is there, the cluster id modulo otherwise (an
 * older `cluster.js`, or a box that was not redeployed). Taken modulo the count
 * either way, so even a hand-set `LUMEN_WORKER_INDEX=9` on a 3-worker box lands
 * on a real slot rather than an offset a whole interval out.
 */
export function resolveWorkerIndex(
  workerCount: number,
  env: EnvLike = process.env,
  source?: ClusterLike
): number {
  const count = Number.isFinite(workerCount) && workerCount >= 1 ? Math.floor(workerCount) : 1;
  const explicit = workerIndexFromEnv(env);
  if (explicit !== undefined) return explicit % count;
  return clusterWorkerIndex(currentWorkerId(source), count);
}

/* ------------------------------------------------------------------ */
/* What the index buys                                                 */
/* ------------------------------------------------------------------ */

/** A count/index that cannot produce an offset outside one interval. */
function normalizedCount(workerCount: number): number {
  return Number.isFinite(workerCount) && workerCount >= 1 ? Math.floor(workerCount) : 1;
}
function normalizedIndex(workerIndex: number, count: number): number {
  if (!Number.isFinite(workerIndex) || workerIndex < 0) return 0;
  return Math.floor(workerIndex) % count;
}

/**
 * THE STEADY-STATE PHASE: an even share of one interval, so three workers on the
 * default 600,000ms interval repeat 200s apart and each still runs its own cycle
 * once per interval. Whole milliseconds; a nonsense interval means no offset,
 * which is today's behaviour rather than a broken schedule.
 */
export function topicWarmOffsetMs(workerIndex: number, workerCount: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
  const count = normalizedCount(workerCount);
  const index = normalizedIndex(workerIndex, count);
  if (index === 0) return 0;
  return Math.floor(index * (intervalMs / count));
}

/**
 * A FIXED STEP PER WORKER - `index * stepMs`. Used for the two staggers that are
 * not a share of an interval: the one-shot boot warm in
 * `lib/warm-server-caches.ts`, and the FIRST topic cycle after a restart.
 */
export function workerStaggerMs(workerIndex: number, stepMs: number): number {
  if (!Number.isFinite(stepMs) || stepMs <= 0) return 0;
  if (!Number.isFinite(workerIndex) || workerIndex < 0) return 0;
  return Math.floor(Math.floor(workerIndex) * stepMs);
}

/**
 * ★★★ THE REPEATING SCHEDULE IS PINNED TO THE WALL CLOCK, NOT TO THIS PROCESS
 * (2026-09-05, third pass - a live observation on prod killed the second one).
 *
 * The previous version delayed each worker's repeat by its share of an interval
 * and then started a `setInterval`. That is only a stagger if all three workers
 * start counting at the same moment, AND THEY DO NOT: `startTopicWarmer` runs
 * when the `/api/feed/for-you` route module is first loaded in a worker, which
 * is whenever a request happens to land there. Measured on build
 * y-7rJmYNwX7P2lgOCVl0d: 18:01:17, 18:04:52 and 18:07:14 - the three base times
 * were almost SIX MINUTES apart, so "+170000ms" and "+340000ms" were offsets
 * from three different origins. No overlap was observed, but nothing was
 * preventing one; the separation was luck.
 *
 * A shared origin is the fix, and the only clock all three workers already agree
 * on is the epoch. This returns the next instant at or after `now` that sits on
 * this worker's slot - `t mod intervalMs === index * intervalMs / workerCount` -
 * so the three workers land on 0s / 200s / 400s past every ten-minute epoch
 * boundary no matter when each of them booted, and a worker that restarts at
 * 3pm rejoins the same grid the other two are already on.
 *
 * `now` is expected to be a finite epoch ms (`Date.now()`); a nonsense interval
 * gives back `now`, i.e. "as soon as you like", which is the pre-stagger
 * behaviour rather than a broken schedule.
 */
export function slotStartMs(
  now: number,
  workerIndex: number,
  workerCount: number,
  intervalMs: number
): number {
  if (!Number.isFinite(now)) return 0;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return now;
  const interval = Math.floor(intervalMs);
  const offset = topicWarmOffsetMs(workerIndex, workerCount, interval);
  // Two `%` and a `+ interval` because JS `%` keeps the sign of the dividend,
  // and `now - offset` is negative for any epoch before the offset.
  const sinceSlot = (((now - offset) % interval) + interval) % interval;
  return sinceSlot === 0 ? now : now + (interval - sinceSlot);
}
