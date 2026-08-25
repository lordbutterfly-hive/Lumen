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
/**
 * ★★★ THIS ROUTE WAS FROZEN AT BUILD TIME (found live 2026-08-25).
 *
 * `GET()` took no `Request`, read no `cookies()`/`headers()`, and declared
 * neither `dynamic` nor `revalidate` — so Next STATICALLY PRERENDERED it and
 * served the build-time bytes forever. `prerender-manifest.json` had
 * `initialRevalidateSeconds: false`, and the live response was byte-identical
 * to `.next-qa/server/app/api/dynamic-global-properties.body`. Measured on the
 * 2026-08-23 22:50 build: head block 109,285,076 while the chain was at
 * 109,334,116 — ~41 hours and 49,040 blocks behind, and it would NEVER have
 * caught up, because a restart re-reads the same frozen artifact. Only a
 * rebuild moved it.
 *
 * The `cache-control: private, no-store` below did NOT prevent this and made
 * it harder to see: that header is captured INTO the frozen body, so every
 * downstream cache check reported "not cached" about a response that was
 * nothing but cache.
 *
 * 30 seconds, not `force-dynamic`, on purpose. `use-dynamic-global-data.ts`
 * sets no `staleTime`, so React Query refetches on every mount and window
 * focus — and this backs the VESTS->HP math on hover cards, which mount
 * constantly. `force-dynamic` would put one Hive RPC behind each of those.
 * The values that actually matter here (`total_vesting_fund_hive` /
 * `total_vesting_shares`, `vesting_reward_percent`) drift over hours, so 30s
 * is far fresher than any consumer needs while capping upstream at 2 req/min.
 * The `no-store` header stays correct and is not in tension with this:
 * `revalidate` governs OUR server's cache, the header governs the CLIENT's.
 */
export const revalidate = 30;

export async function GET(): Promise<NextResponse> {
  try {
    const props = await getDynamicGlobalProperties();
    return NextResponse.json(props, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'dynamic global properties lookup failed');
    return NextResponse.json({ error: 'dynamic_global_properties_unavailable' }, { status: 502 });
  }
}
