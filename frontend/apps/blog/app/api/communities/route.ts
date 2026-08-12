import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getCommunities } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/layouts/communities-select.tsx`
 * (the community picker mounted on every main/community feed page) and
 * `features/layouts/community/communities-sidebar.tsx` (the right-rail
 * fallback on the same pages) both called `getCommunities` directly,
 * unconditionally, for every visitor — signed in or not. That reaches
 * `getChain()` and downloads `wax.common.wasm`.
 *
 * `observer` personalises `context.subscribed` per community for whoever is
 * asking, so this is NOT the same shape as `/api/trending-tags` (which is
 * identical for everyone) — kept `private, no-store` rather than `public`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sort = (req.nextUrl.searchParams.get('sort') ?? 'rank').trim();
  const query = req.nextUrl.searchParams.get('query');
  const observer = (req.nextUrl.searchParams.get('observer') ?? 'hive.blog').trim();
  try {
    const communities = await getCommunities(sort, query, observer);
    return NextResponse.json(communities, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'communities lookup failed for sort=%s observer=%s', sort, observer);
    return NextResponse.json({ error: 'communities_unavailable' }, { status: 502 });
  }
}
