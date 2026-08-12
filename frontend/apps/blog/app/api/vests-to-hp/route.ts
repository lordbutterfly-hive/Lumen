import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { convertToHP } from '@ui/lib/utils';
import { getChain } from '@transaction/lib/chain';
import Big from 'big.js';

const logger = getLogger('app');

/**
 * ★ THE ONE ROUTE IN THIS PASS THAT ISN'T A `hive-api.ts`/`bridge-api.ts`
 * WRAPPER, AND WHY. `features/account-profile/redesign/profile-main.tsx`
 * called `getChain()` directly — not for a network read, but to reach
 * `chain.vestsSatoshis()`/`chain.vestsToHp()` (via the shared `convertToHP`
 * helper in `@ui/lib/utils`), which do the vests→HP conversion via wax's
 * actual protocol math (`cpp_vests_to_hp` inside the WASM). That still counts
 * as "instantiate the chain client", so it still downloaded
 * `wax.common.wasm` — on `/@username`, every profile view, signed in or out.
 * It was also its own dedicated `useQuery({queryFn: () => getChain()})` with
 * no `enabled` guard, so nothing gated it.
 *
 * Deliberately reuses the EXISTING `convertToHP` helper server-side rather
 * than reimplementing the ratio in plain JS: that helper's fixed-point wax
 * math has its own rounding, and a wrong HP number on a profile page is a
 * correctness bug, not a performance one. Same computation, same shared
 * function, just moved server-side — the same trade every other route in
 * this pass makes, applied to a calculation instead of a data fetch.
 *
 * `totalVestingFundHive`/`totalVestingShares` are forwarded to the client as
 * opaque JSON (whatever shape `getDynamicGlobalProperties()` returned them
 * in) and reflected straight back here, so this route never has to guess
 * whether they are NAI objects or legacy asset strings — `convertToHP` (via
 * wax's own `createAssetWithRequiredSymbol`) already normalizes either.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const vests = (req.nextUrl.searchParams.get('vests') ?? '').trim();
  const totalsParam = req.nextUrl.searchParams.get('totals');
  if (!vests || !totalsParam) {
    return NextResponse.json({ error: 'vests_and_totals_required' }, { status: 400 });
  }
  let totalVestingFundHive: Parameters<typeof convertToHP>[3];
  let totalVestingShares: Parameters<typeof convertToHP>[2];
  try {
    ({ totalVestingFundHive, totalVestingShares } = JSON.parse(totalsParam));
  } catch {
    return NextResponse.json({ error: 'invalid_totals' }, { status: 400 });
  }
  try {
    // `convertToHP`'s second positional param is the chain instance itself —
    // fine to construct here, server-side, where the WASM cost this whole
    // route exists to avoid never touches a browser bundle.
    const chain = await getChain();
    const hp = convertToHP(Big(vests), chain, totalVestingShares, totalVestingFundHive);
    return NextResponse.json(hp.toString(), { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'vests-to-hp conversion failed for vests=%s', vests);
    return NextResponse.json({ error: 'vests_to_hp_unavailable' }, { status: 502 });
  }
}
