import { NextResponse } from 'next/server';
import v8 from 'v8';
import path from 'path';
import { allCacheStats } from '@/blog/lib/cache-registry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (process.env.DENSER_DEBUG_MEM !== 'true') {
    return new NextResponse(null, { status: 404 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // Force GC if available (requires --expose-gc)
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    // Run GC twice — first pass collects weak refs, second pass collects
    // dependents. Wait a tick between to allow FinalizationRegistry callbacks.
    await new Promise(r => setTimeout(r, 50));
    globalThis.gc();
  }

  const mem = process.memoryUsage();

  if (action === 'snapshot') {
    const filename = v8.writeHeapSnapshot(
      path.join('/tmp', `heap-${Date.now()}.heapsnapshot`)
    );
    return NextResponse.json({ ...formatMem(mem), snapshot: filename, caches: allCacheStats() });
  }

  return NextResponse.json({ ...formatMem(mem), caches: allCacheStats() });
}

/**
 * ★★★ WHY THE CACHE COUNTERS HANG OFF THIS ROUTE (2026-09-05, box memory pass).
 *
 * This route already answers "how big is this worker?" and until now that was
 * the only question it could answer — leaving "WHICH map is holding it?" to a
 * heap snapshot, which is exactly the tool nobody reaches for at 20:00 on a box
 * with 1 GB free. `caches` closes that: per-cache `size` against the cap in
 * `lib/cached-api.ts`'s budget note, plus `sweeps`/`swept` (the expiry reclaim
 * working) and `evictions` (the cap, not expiry, doing the bounding — the tell
 * that a cap is too small for its traffic).
 *
 * ★ IT COSTS NOTHING AND IS GATED ANYWAY. Each `stats()` is a counter read plus
 * `Map.size`, never an iteration over entries, so adding it to the default
 * response cannot make this route the slow thing it is used to diagnose. The
 * `DENSER_DEBUG_MEM` gate above is unchanged and still 404s without it, so this
 * exposes nothing new in a normal production process.
 *
 * ★ IT REPORTS PER WORKER, WHICH IS THE POINT AND ALSO THE TRAP. The three
 * cluster workers share :3000, so repeated curls land on DIFFERENT workers and
 * the numbers will jump. That is real, not noise: each worker holds its own
 * Maps. Read a single worker by curling until `rss_mb` repeats, or read several
 * and treat the spread as the per-worker range.
 *
 * ★ AND `caches` MAY BE EMPTY on a worker that has served no profile or post
 * page yet, because a cache registers when its module is first loaded. That is a
 * true answer (it is holding nothing), not a broken instrument — see
 * `allCacheStats`'s own note.
 */
function formatMem(mem: NodeJS.MemoryUsage) {
  return {
    timestamp: Date.now(),
    rss_mb: +(mem.rss / 1024 / 1024).toFixed(2),
    heapTotal_mb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
    heapUsed_mb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
    external_mb: +(mem.external / 1024 / 1024).toFixed(2),
    arrayBuffers_mb: +(mem.arrayBuffers / 1024 / 1024).toFixed(2),
  };
}
