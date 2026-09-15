import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getBuildersBoardCached } from '@/blog/lib/builders-board';

const logger = getLogger('app');

/**
 * The builders board, as plain JSON for the right-rail card. Everything about
 * WHY it is a route rather than a client-side chain call is in
 * `lib/builders-board.ts` and, before it, `app/api/trending-tags/route.ts`:
 * keep `@hiveio/wax` out of the browser, and keep the chain call off every
 * reader's critical path.
 *
 * ★ TAKES `NextRequest`, ON PURPOSE, AND USES NOTHING FROM IT. A `GET()` with
 * no request argument is PRERENDERED at build and served from Next's ISR cache
 * (trending-tags documents seeing `x-nextjs-cache: HIT` and a 2 ms answer that
 * never reached its module). Trending tags can afford that; a board of what
 * people posted this week cannot be frozen on the day of the build. Naming the
 * argument keeps the handler dynamic, and the freshness policy then lives in
 * exactly one place — the named TTL cache — rather than in two caches with
 * independent clocks.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const builders = await getBuildersBoardCached();
    return NextResponse.json(
      { builders },
      // Public and global; the CDN may hold it for ten minutes and serve stale
      // for a day while it refreshes, mirroring the in-process cache behind it.
      { headers: { 'cache-control': 'public, s-maxage=600, stale-while-revalidate=86400' } }
    );
  } catch (error) {
    logger.error(error, 'builders-board: read failed');
    // The card renders NOTHING on a failure (see right-rail/builders.tsx), the
    // way the Meritum board does — never an empty box that reads as broken.
    return NextResponse.json({ builders: [], degraded: true }, { status: 200 });
  }
}
