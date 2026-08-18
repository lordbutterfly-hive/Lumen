import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { withRetry } from '@transaction/lib/retry';
import { convertStringToBig } from '@ui/lib/helpers';
import { convertToHP } from '@ui/lib/utils';
import { cachedRead } from '@/blog/lib/server-read-cache';
import type { DelegateeRow } from '@/blog/features/wallet/hooks/use-delegations';

const logger = getLogger('app');

/**
 * Outgoing vesting delegations for one account, already converted to HP.
 *
 * ★ WHY (2026-08-13, browser audit §1.5): `use-delegations.ts` called
 * `database_api.list_vesting_delegations` from the browser — one of the nineteen
 * direct api.hive.blog requests on `/wallet` — and then ran `convertToHP` on each
 * row, which needs a wax `Chain` instance and so was one of the reasons the page
 * had to hold one. Both halves move here; the browser gets `{ name, hp }` strings.
 *
 * `order: 'by_delegation'` is indexed by delegator, so a start of `[username, '']`
 * returns this account's rows first — the API does not stop at an exact delegator
 * boundary, which is why the defensive filter below is kept exactly as it was.
 *
 * `private, no-store`: whose stake is delegated where is not something to hand a
 * shared cache, and the memo (10s, server-side, keyed by account) exists only to
 * collapse the burst a single render produces.
 */

const LIST_LIMIT = 100;
const DELEGATIONS_MEMO_MS = 10_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const rows = await cachedRead<DelegateeRow[]>(
      `wallet:delegations:${username}`,
      DELEGATIONS_MEMO_MS,
      async () => {
        const [chain, dynamicGlobal] = await Promise.all([getChain(), getDynamicGlobalProperties()]);
        // ★ A6 retry rollout (2026-08-18): idempotent read, previously with no retry
        // of any kind — a single blip on this call was an unconditional 502. Runs
        // AFTER the Promise.all above (already up to ~12s worst case from
        // `getDynamicGlobalProperties`'s own `withHiveRetry`), so this adds up to
        // its own ~2.5s budget on top rather than multiplying that ceiling.
        const { delegations } = await withRetry(
          () =>
            chain.api.database_api.list_vesting_delegations({
              start: [username, ''],
              limit: LIST_LIMIT,
              order: 'by_delegation'
            }),
          { label: `list_vesting_delegations(${username})` }
        );
        return delegations
          .filter((d) => d.delegator === username)
          .map((d) => ({
            name: d.delegatee,
            hp: convertToHP(
              convertStringToBig(d.vesting_shares),
              chain,
              dynamicGlobal.total_vesting_shares,
              dynamicGlobal.total_vesting_fund_hive
            ).toFixed(3)
          }));
      }
    );
    return NextResponse.json(rows, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'wallet delegations failed for %s', username);
    return NextResponse.json({ error: 'wallet_delegations_unavailable' }, { status: 502 });
  }
}
