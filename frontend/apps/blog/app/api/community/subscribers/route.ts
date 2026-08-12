import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getSubscribers } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/layouts/community/community-
 * layout.tsx` called `getSubscribers` directly for every visitor to a
 * community page. That reaches `getChain()` and downloads `wax.common.wasm`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const community = (req.nextUrl.searchParams.get('community') ?? '').trim();
  if (!community) {
    return NextResponse.json({ error: 'community_required' }, { status: 400 });
  }
  try {
    const subscribers = await getSubscribers(community);
    return NextResponse.json(subscribers, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'subscribers lookup failed for %s', community);
    return NextResponse.json({ error: 'subscribers_unavailable' }, { status: 502 });
  }
}
