import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getDynamicGlobalProperties } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `components/hooks/use-dynamic-global-data.ts`
 * called `getDynamicGlobalProperties` directly — it reaches `getChain()` and
 * downloads `wax.common.wasm`. This backs the HP-conversion math used across
 * hover cards, the wallet and withdraw/delegate dialogs.
 *
 * Unlike the other routes in this pass, the answer here carries no per-viewer
 * data at all — it is one global network snapshot, identical for every
 * reader, the same shape as `/api/trending-tags`. It would be a legitimate
 * `public` cache candidate; left `private, no-store` for now to match every
 * other route in this pass rather than adding a second `middleware.ts`
 * exclusion under time pressure (`/api/trending-tags`'s exclusion was itself
 * a same-day catch — see that route's comment). Revisit if this read shows up
 * as a real cost.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const props = await getDynamicGlobalProperties();
    return NextResponse.json(props, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'dynamic global properties lookup failed');
    return NextResponse.json({ error: 'dynamic_global_properties_unavailable' }, { status: 502 });
  }
}
