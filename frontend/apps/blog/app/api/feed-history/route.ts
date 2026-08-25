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
/**
 * ★★★ FROZEN AT BUILD TIME until 2026-08-25 — same defect, same fix, as
 * `/api/dynamic-global-properties`; read that route's note for the mechanism.
 *
 * This one is the money-visible instance: it is the HIVE/HBD median price
 * behind the `$` payout estimate `payout-hover-content.tsx` shows on every
 * post card. The frozen build served `base=44` (0.044 HBD/HIVE) against a live
 * 0.043 — every payout figure on the site was 2.3% high, and the error grew
 * every day the build stayed up.
 *
 * 300s because Hive's median price feed is a witness median that moves on the
 * scale of an hour; five minutes bounds the displayed error to noise.
 */
export const revalidate = 300;

export async function GET(): Promise<NextResponse> {
  try {
    const history = await getFeedHistory();
    return NextResponse.json(history, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'feed history lookup failed');
    return NextResponse.json({ error: 'feed_history_unavailable' }, { status: 502 });
  }
}
