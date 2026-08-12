import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getCommunity } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/layouts/community/community-
 * layout.tsx` (wraps every community page) called `getCommunity` directly for
 * every visitor. That reaches `getChain()` and downloads `wax.common.wasm`.
 * `observer` personalises `context.subscribed`, so kept `private, no-store`
 * rather than `public` — same reasoning as `/api/communities`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const name = (req.nextUrl.searchParams.get('name') ?? '').trim();
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim();
  if (!name) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 });
  }
  try {
    const community = await getCommunity(name, observer);
    return NextResponse.json(community, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'community lookup failed for %s', name);
    return NextResponse.json({ error: 'community_unavailable' }, { status: 502 });
  }
}
