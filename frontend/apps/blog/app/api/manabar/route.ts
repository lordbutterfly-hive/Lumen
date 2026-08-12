import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getManabar } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. The header's RC/voting-power rings
 * (`app-header.tsx` -> `useLoggedUserContext` -> `features/votes/hooks/
 * use-logged-user.tsx`) called `getManabar` directly, which reaches
 * `getChain()` and downloads `wax.common.wasm` for every signed-in reader on
 * every page — the same provider that already needed the fix in `/api/account`
 * for the account half of its two queries.
 *
 * NOT CACHED: manabar regenerates continuously (it is literally a "how full is
 * this bar right now" read), so a shared cache would show a stale percentage.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const manabar = await getManabar(username);
    return NextResponse.json(manabar, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'manabar lookup failed for %s', username);
    return NextResponse.json({ error: 'manabar_unavailable' }, { status: 502 });
  }
}
