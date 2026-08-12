import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getFeedHistory } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/list-of-posts/payout-hover-
 * content.tsx` called `getFeedHistory` directly on every mount — and it
 * mounts on hover over any post's payout amount, in any list, for any
 * visitor. That reaches `getChain()` and downloads `wax.common.wasm`.
 *
 * Global data (the HIVE/HBD price-feed history), not per-viewer — same shape
 * as `/api/dynamic-global-properties`. Kept `private, no-store` for the same
 * reason documented there: consistent, low-risk default for this pass.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const history = await getFeedHistory();
    return NextResponse.json(history, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'feed history lookup failed');
    return NextResponse.json({ error: 'feed_history_unavailable' }, { status: 502 });
  }
}
