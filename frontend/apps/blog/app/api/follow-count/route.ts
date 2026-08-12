import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getFollowCount } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `components/hooks/use-follows.ts` called
 * `getFollowCount` directly — it reaches `getChain()` and downloads
 * `wax.common.wasm`. This hook backs the follower/following numbers on every
 * author hover-card (`popover-card-data.tsx`), which is one of the highest-
 * traffic reads in the app: it fires on hover over any author name in any
 * post list, for any visitor, signed in or not.
 *
 * NOT CACHED: follow counts change on every follow/unfollow, and this is
 * cheap enough (one `bridge.get_profile` call) that staleness buys little.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const followStats = await getFollowCount(username);
    return NextResponse.json(followStats, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'follow count lookup failed for %s', username);
    return NextResponse.json({ error: 'follow_count_unavailable' }, { status: 502 });
  }
}
