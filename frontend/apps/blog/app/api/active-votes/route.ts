import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getActiveVotes } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `components/hooks/use-active-votes.ts`
 * called `getActiveVotes` directly — it reaches `getChain()` and downloads
 * `wax.common.wasm`. Used to render a post's vote list/count in the browser.
 *
 * NOT CACHED: a post's votes change continuously during its payout window,
 * which is exactly when this is looked at most.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '').toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(author)) {
    return NextResponse.json({ error: 'author_required' }, { status: 400 });
  }
  if (!/^[a-z0-9-]{1,255}$/.test(permlink)) {
    return NextResponse.json({ error: 'permlink_required' }, { status: 400 });
  }
  try {
    const votes = await getActiveVotes(author, permlink);
    return NextResponse.json(votes, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'active votes lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'active_votes_unavailable' }, { status: 502 });
  }
}
