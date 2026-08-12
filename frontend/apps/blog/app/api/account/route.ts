import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountFull } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ SAME RULE AS `/api/notifications/unread`: `getAccountFull` reaches
 * `getChain()`, which INSTANTIATES `@hiveio/wax` and fetches `wax.common.wasm`
 * (2.34 MB) the moment it is called — regardless of what the caller does with
 * the result.
 *
 * This is the single most widely-shared chain read in the app: the global
 * `LoggedUserProvider` (features/votes/hooks/use-logged-user.tsx) called it
 * for every signed-in reader on every page to build the header's manabar
 * rings, and `components/hooks/use-account.ts` called it a second time from
 * every author hover-card, profile page and settings form. Both now fetch
 * this route instead.
 *
 * ★ NOT CACHED. `getAccountFull` folds in balances and `voting_manabar` /
 * `downvote_manabar`, which change with every vote and every block — a
 * shared cache serving one reader's fresher balance to another (or serving a
 * stale one) is a worse trade than one extra request per lookup. See
 * `/api/notifications/unread` for why `private, no-store` rather than
 * `public` is the safe default for a per-account read like this.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  // Shape check only: handed to a JSON-RPC parameter, nothing here to inject into.
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const account = await getAccountFull(username);
    return NextResponse.json(account, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account lookup failed for %s', username);
    return NextResponse.json({ error: 'account_unavailable' }, { status: 502 });
  }
}
