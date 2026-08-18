import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';
import {
  WALLET_HISTORY_OPERATION_NAMES,
  describeHistoryOperation,
  DescribedHistoryEntry
} from '@/blog/features/wallet/lib/account-history';

const logger = getLogger('app');

/**
 * The wallet's "Recent activity" list, already described.
 *
 * ★★★ WHY (2026-08-13, browser audit §1.5). `use-account-history.ts` called
 * `chain.restApi['hafah-api']['operation-types']()` and
 * `chain.restApi['hivemind-api'].accountsOperations(...)` FROM THE BROWSER —
 * two of the nineteen direct api.hive.blog requests the wallet page made, and
 * two of the reasons it downloaded `wax.common.wasm`.
 *
 * ★ THE DESCRIBING HAPPENS HERE TOO, and that is the load-bearing half. Half of
 * `describeHistoryOperation`'s output needs a wax `Chain`: `formatHp` converts a
 * vests amount to HP through `convertToHP`, and `symbolFor` reads `getNaiSymbols()`,
 * which only ever gets populated by `initializeAssetConstants(chain.ASSETS)` when a
 * chain instance is built. Returning raw operations and describing them in the
 * browser would therefore have kept wax in the bundle and, worse, degraded
 * silently if it were removed — `symbolFor` catches its own throw and returns
 * `''`, so every amount would quietly lose its "HIVE"/"HBD" suffix instead of
 * failing loudly.
 *
 * `describeHistoryOperation` was already written to emit i18n KEYS plus params
 * rather than sentences ("no JSX, no i18n calls — the caller decides the
 * language"), so moving it server-side changes nothing about translation. The one
 * genuinely locale-dependent step inside it is `Intl.ListFormat` joining a
 * multi-asset reward ("12 HIVE, 3 HBD and 450 HP"), which is why `lang` crosses
 * the wire; Node has full ICU, so it produces the same string the browser did.
 *
 * `private, no-store`: one account's transaction history.
 */

/** One page is enough for a "Recent activity" card — same value the hook used. */
const HISTORY_PAGE_SIZE = 25;
const HISTORY_MEMO_MS = 5_000;

/** BCP-47-ish shape check. Only ever reaches `Intl.ListFormat`, which falls back on its own. */
const LANG = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

export interface WalletHistoryResponse {
  entries: DescribedHistoryEntry[];
  totalOperations: number;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  const langParam = (req.nextUrl.searchParams.get('lang') ?? 'en').trim();
  const lang = LANG.test(langParam) ? langParam : 'en';

  try {
    const payload = await cachedRead(`wallet:history:${username}:${lang}`, HISTORY_MEMO_MS, async () => {
      const chain = await getChain();
      // ★ RETRY + FAILOVER on both REST reads (2026-08-18). Neither had any, and
      // this route was measured returning a flat HTTP 502 after a 7.72s stall —
      // no retry, no failover, the timeout surfaced straight to the reader as a
      // broken history panel. Same wrapper the account read already uses.
      const opTypes = await withHiveRetry(
        () => chain.restApi['hafah-api']['operation-types'](),
        'hafah operation-types'
      );
      const operationTypeIds = WALLET_HISTORY_OPERATION_NAMES.map(
        (name) => opTypes.find((opType) => opType.operation_name === name)?.op_type_id
      )
        .filter((id): id is number => id !== undefined)
        .join(',');

      const [response, dynamicGlobal] = await Promise.all([
        withHiveRetry(
          () =>
            chain.restApi['hivemind-api'].accountsOperations({
              'account-name': username,
              'page-size': HISTORY_PAGE_SIZE,
              'operation-types': operationTypeIds,
              'observer-name': username
            }),
          'hivemind accountsOperations'
        ),
        getDynamicGlobalProperties()
      ]);

      const entries = (response.operations_result ?? [])
        .map((op) => describeHistoryOperation(op, { username, chain, dynamicGlobal }, lang))
        .filter((entry): entry is DescribedHistoryEntry => entry !== null);

      const body: WalletHistoryResponse = { entries, totalOperations: response.total_operations };
      return body;
    });
    return NextResponse.json(payload, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'wallet history failed for %s', username);
    return NextResponse.json({ error: 'wallet_history_unavailable' }, { status: 502 });
  }
}
