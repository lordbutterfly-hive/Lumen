import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getByText } from '@transaction/lib/hive-api';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/search/search-results.tsx` called
 * `getByText` directly on every non-empty search — `/search` is public, so
 * every visitor who used search downloaded `wax.common.wasm`.
 *
 * ★ MERGES LUMEN ENGAGEMENT (2026-08-13, O2-votes.md item 1's server half --
 * `searchByText` was one of the surfaces named there where a Lumen vote/reblog
 * reverted to the chain-only count on reload because nothing on the server side
 * of this route had ever called `getEngagementTotals`). See
 * `mergeLumenEngagement`'s own doc for the full mechanism and why it copies
 * rather than mutates.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const pattern = (req.nextUrl.searchParams.get('pattern') ?? '').trim();
  const sort = (req.nextUrl.searchParams.get('sort') ?? 'relevance').trim();
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim();
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim();
  const startAuthor = (req.nextUrl.searchParams.get('start_author') ?? '').trim();
  const startPermlink = (req.nextUrl.searchParams.get('start_permlink') ?? '').trim();
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 50) : 20;
  if (!pattern) {
    return NextResponse.json({ error: 'pattern_required' }, { status: 400 });
  }
  try {
    const results = await getByText({
      pattern,
      sort,
      author,
      limit,
      observer,
      start_author: startAuthor,
      start_permlink: startPermlink
    });
    const merged = await mergeLumenEngagement(results);
    return NextResponse.json(merged, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'search lookup failed for "%s"', pattern);
    /**
     * ★★★ SAY WHICH KIND OF FAILURE IT IS (2026-08-18).
     *
     * Everything used to collapse to `search_unavailable`, so the client could
     * not tell a transient blip from the one failure this search reliably has:
     * sorting by Newest on a broad term makes Hivemind's own Postgres abort with
     * `57014`, a statement timeout, every single time (measured 3 of 3 at
     * 5.1-5.4s, and on every node in the fallback list that runs the search
     * plugin at all — it is a backend limit, not a node choice).
     *
     * Retrying that cannot succeed, and the retry is expensive: measured end to
     * end in the browser, one attempt plus one retry took **12.4s** before the
     * reader was told anything. Naming the cause here lets the client skip the
     * retry for exactly this case and keep it for everything else, instead of
     * having to give up retrying altogether.
     */
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const isStatementTimeout = /57014|statement timeout|canceling statement/i.test(detail);
    return NextResponse.json(
      { error: isStatementTimeout ? 'search_timeout' : 'search_unavailable' },
      { status: 502 }
    );
  }
}
