import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getByText } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/search/search-results.tsx` called
 * `getByText` directly on every non-empty search — `/search` is public, so
 * every visitor who used search downloaded `wax.common.wasm`.
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
    return NextResponse.json(results, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'search lookup failed for "%s"', pattern);
    return NextResponse.json({ error: 'search_unavailable' }, { status: 502 });
  }
}
