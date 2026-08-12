import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getFollowers } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/account-lists/hooks/use-
 * followers-infinitequery.tsx` (backing `/[param]/followers` and the author
 * hover-card's follower count) called `getFollowers` directly.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  const start = req.nextUrl.searchParams.get('start') ?? '';
  const type = (req.nextUrl.searchParams.get('type') ?? 'blog').trim();
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 1000) : 50;
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }
  try {
    const followers = await getFollowers({ account, start, type, limit });
    return NextResponse.json(followers, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'followers lookup failed for %s', account);
    return NextResponse.json({ error: 'followers_unavailable' }, { status: 502 });
  }
}
