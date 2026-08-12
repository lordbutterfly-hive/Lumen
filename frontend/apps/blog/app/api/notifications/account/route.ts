import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountNotifications } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/notifications/unread`, for the full notification LIST
 * rather than just the unread count. Three separate browser call sites called
 * `getAccountNotifications` directly: the header bell's popover
 * (`notifications-menu.tsx`, opened by any signed-in reader), the home-feed
 * retention nudge (`retention-nudge.tsx`, which also duplicated
 * `getUnreadNotifications` instead of reusing the header's fixed fetch — see
 * that component), and `community-layout.tsx` (a community's own activity,
 * for every visitor to that community — not gated on being signed in). Each
 * reaches `getChain()` and downloads `wax.common.wasm`.
 *
 * NOT CACHED, NOT `public`: this is one account's notification stream, and
 * the community-activity use is per-community but still not something a
 * shared cache should hold across the header's per-reader use of the same
 * route.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  const lastIdParam = req.nextUrl.searchParams.get('lastId');
  const limitParam = req.nextUrl.searchParams.get('limit');
  if (!/^[a-z0-9][a-z0-9.-]{1,31}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }
  const lastId = lastIdParam ? Number(lastIdParam) : null;
  // A garbage `limit` must not turn into an unbounded upstream request.
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 100) : 50;
  try {
    const notifications = await getAccountNotifications(account, Number.isFinite(lastId) ? lastId : null, limit);
    return NextResponse.json(notifications, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account notifications lookup failed for %s', account);
    return NextResponse.json({ error: 'account_notifications_unavailable' }, { status: 502 });
  }
}
