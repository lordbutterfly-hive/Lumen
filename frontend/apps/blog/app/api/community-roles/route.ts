import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListCommunityRoles } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `getListCommunityRoles` was called directly
 * in the browser from `app/[param]/[p2]/[permlink]/content.tsx` (the post-
 * permalink page — the single highest-traffic route in the app, both
 * `enabled` unconditionally for any post inside a community, no SSR
 * `initialData`) and again from `app/(main-and-community)/roles/[tag]/
 * content.tsx` under a DIFFERENT query key than its own page.tsx's SSR
 * prefetch (`rolesList` vs `community`), so that SSR fetch was always
 * discarded and the client always re-fetched from scratch. Both reach
 * `getChain()` and download `wax.common.wasm`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const community = (req.nextUrl.searchParams.get('community') ?? '').trim();
  if (!community) {
    return NextResponse.json({ error: 'community_required' }, { status: 400 });
  }
  try {
    const roles = await getListCommunityRoles(community);
    return NextResponse.json(roles, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'community roles lookup failed for %s', community);
    return NextResponse.json({ error: 'community_roles_unavailable' }, { status: 502 });
  }
}
