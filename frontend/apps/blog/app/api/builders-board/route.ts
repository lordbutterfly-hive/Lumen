import { NextResponse } from 'next/server';
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
 * ★★★ `force-dynamic`, BECAUSE NAMING THE REQUEST ARGUMENT WAS NOT ENOUGH
 * (measured 2026-09-15). The first version of this file declared
 * `GET(_req: NextRequest)` and claimed that "naming the argument keeps the
 * handler dynamic". It does not: Next 14 marks a GET handler dynamic only when
 * the request is actually READ (or a dynamic API is used). The build table
 * printed `○ /api/builders-board`, `prerender-manifest.json` listed it, and
 * the live response carried `x-nextjs-cache: HIT` — the board was PRERENDERED
 * during `next build`, the process TTL cache below was never consulted in
 * production, and one bad page returned during the build's 21-account burst
 * (the owner's row missing its two newest posts) was frozen into the artifact
 * until the next deploy. `no-store` on the response only stopped browsers
 * caching that frozen copy. `force-dynamic` is the explicit, un-guessable form:
 * the handler runs per request, and the ONE cache with a clock is the named
 * TTL cache in `lib/builders-board.ts`. Trending tags stays prerendered on
 * purpose (a day-stale global tag list is fine); a board of what was shipped
 * this week cannot be.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const builders = await getBuildersBoardCached();
    return NextResponse.json(
      { builders },
      // ★ `no-store`, NOT `s-maxage` (caught on the first local render, 2026-09-15).
      // This shipped with `public, s-maxage=600, stale-while-revalidate=86400`,
      // and the browser served the PREVIOUS build's eight-row board for the
      // whole first page view — the roster had changed, the process cache was
      // fresh, and the stale copy came from the HTTP cache in front of it. On
      // production that layer is Cloudflare, whose stale window would outlive
      // any roster change by a day. The in-process TTL cache (10 min fresh, a
      // day stale-while-revalidate, 25 ms warm) IS the cache for this route;
      // a second one in front of it can only disagree with it.
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    logger.error(error, 'builders-board: read failed');
    // The card renders NOTHING on a failure (see right-rail/builders.tsx), the
    // way the Meritum board does — never an empty box that reads as broken.
    return NextResponse.json({ builders: [], degraded: true }, { status: 200 });
  }
}
