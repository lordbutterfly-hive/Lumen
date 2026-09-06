import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountFull, getManabar } from '@transaction/lib/hive-api';
import { cachedRead } from '@/blog/lib/server-read-cache';

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
 *
 * ★ NO LONGER FETCHES THE ACCOUNT ITSELF (2026-09-07, dupe-call fix). This
 * route and `/api/account` each independently called `find_accounts` for the
 * same user, milliseconds apart. `getManabar` now reuses `/api/account`'s own
 * `cachedRead('account:...', ...)` entry -- same key, same TTL, same
 * `getAccountFull` call -- so whichever route's request lands first is the
 * one that pays for it; the in-flight map coalesces the other even in the
 * same millisecond (see lib/server-read-cache.ts). Trade-off: the manabar
 * fields sourced from the account are now only as fresh as that 15s cache,
 * not always-fresh; `dgpo`/`rc_accounts` are still fetched fresh every call.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    // ★ 3s SERVER-SIDE MEMO (2026-08-13) — wire contract unchanged, see
    // lib/server-read-cache.ts. Measured at a steady 130-444ms on every page.
    // Shorter than `/api/account`'s 5s precisely because of the comment above:
    // this bar regenerates continuously, so one Hive block is the honest ceiling.
    // That is still enough to collapse the duplicate reads a single render makes.
    const manabar = await cachedRead(`manabar:${username}`, 3_000, () =>
      getManabar(username, cachedRead(`account:${username}`, 15_000, () => getAccountFull(username)))
    );
    return NextResponse.json(manabar, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'manabar lookup failed for %s', username);
    return NextResponse.json({ error: 'manabar_unavailable' }, { status: 502 });
  }
}
