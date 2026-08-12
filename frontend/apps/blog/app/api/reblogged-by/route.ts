import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getRebloggedBy } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/list-of-posts/hooks/use-
 * reblogged-by-query.ts` called `getRebloggedBy` directly.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '').toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(author) || !/^[a-z0-9-]{1,255}$/.test(permlink)) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }
  try {
    const rebloggers = await getRebloggedBy(author, permlink);
    return NextResponse.json(rebloggers, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'reblogged-by lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'reblogged_by_unavailable' }, { status: 502 });
  }
}
