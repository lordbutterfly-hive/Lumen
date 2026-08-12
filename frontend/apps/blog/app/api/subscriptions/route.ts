import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getSubscriptions } from '@transaction/lib/bridge-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `communities-select.tsx`, `communities-
 * sidebar.tsx` and `community-layout.tsx` all called `getSubscriptions`
 * directly (for the signed-in viewer's own "My communities" list). That
 * reaches `getChain()` and downloads `wax.common.wasm`. This is the reader's
 * own subscription list, so `private, no-store` is the correct call, not a
 * pass-time convenience.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const account = (req.nextUrl.searchParams.get('account') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(account)) {
    return NextResponse.json({ error: 'account_required' }, { status: 400 });
  }
  try {
    const subscriptions = await getSubscriptions(account);
    return NextResponse.json(subscriptions, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'subscriptions lookup failed for %s', account);
    return NextResponse.json({ error: 'subscriptions_unavailable' }, { status: 502 });
  }
}
