import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountFull, getDynamicGlobalProperties, getFindAccounts } from '@transaction/lib/hive-api';
import { getChain } from '@transaction/lib/chain';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { deriveWalletFigures } from '@/blog/features/wallet/lib/wallet-derived';
import { toWalletFiguresWire, WalletFiguresWire } from '@/blog/features/wallet/lib/wallet-figures-wire';

const logger = getLogger('app');

/**
 * Everything `/wallet`'s balance half needs, in ONE same-origin request.
 *
 * ★★★ WHY (2026-08-13, browser audit §1.5): the wallet page made **19 direct
 * requests to api.hive.blog from the browser**, plus a 2.34 MB `wax.common.wasm`
 * download. The full enumeration and the reason each one existed is in
 * `features/wallet/lib/wallet-figures-wire.ts`; fifteen of the nineteen are the
 * three reads collapsed here (`getAccountFull` alone is find_accounts +
 * bridge.get_profile + twelve `get_relationship_between_accounts` for the banned
 * -follower correction).
 *
 * Bundling rather than adding three routes: this is the same call the
 * `/api/witnesses-page` route already makes for the same reason — the four
 * values are consumed together by one render, two of them (`account`,
 * `dynamicGlobal`) are inputs to the third (`figures`), and splitting them would
 * put the vests->HP arithmetic back in the browser, which is the thing that was
 * pulling wax in.
 *
 * ★ `figures` IS DERIVED HERE, ON PURPOSE. `convertToHP` needs a live wax `Chain`
 * instance, and instantiating one is what downloads the WASM. The server already
 * has it. Sending the DERIVED numbers (as decimal strings — see the wire module)
 * is what lets the wallet page render real HP figures with no chain client at all.
 *
 * ★ `private, no-store`, same posture as `/api/account`: these are one account's
 * balances and must never enter a shared cache. The 3s server memo below is a
 * different thing entirely — it is our own upstream call, keyed by username, and
 * exists only to collapse the duplicate reads a single render produces. It is
 * deliberately SHORT: the wallet's own post-transaction revalidation refetches at
 * +8s (`scheduleValidatedRefetch`), and a memo long enough to still be serving the
 * pre-transaction balance at that point would make a completed transfer look lost.
 */

const SUMMARY_MEMO_MS = 3_000;

export interface WalletSummaryResponse {
  account: Awaited<ReturnType<typeof getAccountFull>>;
  dynamicGlobal: Awaited<ReturnType<typeof getDynamicGlobalProperties>>;
  figures: WalletFiguresWire;
  pendingClaimedAccounts: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  // Shape check only: handed to a JSON-RPC parameter, nothing here to inject into.
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const payload = await cachedRead(`wallet:summary:${username}`, SUMMARY_MEMO_MS, async () => {
      const [account, dynamicGlobal, raw, chain] = await Promise.all([
        getAccountFull(username),
        getDynamicGlobalProperties(),
        // `FullAccount` (the app's trimmed shape) does not carry
        // `pending_claimed_accounts`, which the "Claim account tokens" dialog's
        // copy needs — the same second read `useWalletAccount` used to make.
        getFindAccounts(username),
        getChain()
      ]);
      const response: WalletSummaryResponse = {
        account,
        dynamicGlobal,
        figures: toWalletFiguresWire(deriveWalletFigures(account, dynamicGlobal, chain)),
        pendingClaimedAccounts: Number(raw?.accounts?.[0]?.pending_claimed_accounts ?? 0)
      };
      return response;
    });
    return NextResponse.json(payload, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'wallet summary failed for %s', username);
    return NextResponse.json({ error: 'wallet_summary_unavailable' }, { status: 502 });
  }
}
