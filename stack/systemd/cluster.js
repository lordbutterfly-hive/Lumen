// Lumen prod cluster wrapper (2026-09-05, perf O2). Forks N Next-standalone
// workers that SHARE :3000, so SSR uses all cores instead of 1-of-4. Lives
// OUTSIDE /opt/lumen/app so deploy-lumen.sh rsync --delete never removes it.
const cluster = require("cluster");
const SERVER = "/opt/lumen/app/apps/blog/server.js";
const WORKERS = Math.max(1, parseInt(process.env.LUMEN_WORKERS, 10) || 3);
const isPrimary = cluster.isPrimary === undefined ? cluster.isMaster : cluster.isPrimary;
if (isPrimary) {
  // ★ EACH WORKER GETS A STABLE 0-BASED SLOT (2026-09-05). The app staggers its
  // background Hive warmers by worker index so the three workers never warm at
  // the same instant (apps/blog/lib/feed/topic-warm-offset.ts), and it cannot
  // derive that index from cluster.worker.id: ids keep INCREMENTING across
  // respawns, so after one crash the replacement is id 4, (4-1) % 3 is 0, and it
  // takes the slot the still-living id 1 already holds — two workers back on the
  // same phase and one slot empty, until the next full restart. The primary owns
  // the mapping instead and hands it down in the child's env; a respawn reuses
  // the DEAD worker's slot, so the schedule heals rather than collides.
  const slotOf = new Map(); // cluster worker id -> its 0-based slot
  const spawn = (index) => {
    const worker = cluster.fork({
      LUMEN_WORKER_INDEX: String(index),
      LUMEN_WORKERS: String(WORKERS)
    });
    slotOf.set(worker.id, index);
    return worker;
  };
  console.log("[cluster] primary " + process.pid + " forking " + WORKERS + " workers");
  for (let i = 0; i < WORKERS; i++) spawn(i);
  cluster.on("exit", (w, code, signal) => {
    // Default to slot 0 only if the map somehow lost the worker — never leave a
    // respawned worker without an index, or it falls back to the id modulo.
    const index = slotOf.has(w.id) ? slotOf.get(w.id) : 0;
    slotOf.delete(w.id);
    console.log("[cluster] worker " + w.process.pid + " (slot " + index + ") exited (" + (signal || code) + "); respawning");
    spawn(index);
  });
} else {
  require(SERVER);
}
