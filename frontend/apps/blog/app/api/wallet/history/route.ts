import { NextRequest, NextResponse } from 'next/server';
import { HiveAccountNotFoundError, accountNotFoundBody, assertHiveAccountExists } from '@/blog/lib/wallet/hive-account-exists';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { getLogger } from '@ui/lib/logging';
import { getChain } from '@transaction/lib/chain';
import { getDynamicGlobalProperties } from '@transaction/lib/hive-api';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { withHiveRetry } from '@smart-signer/lib/hive-network-error';
import {
  describeHistoryOperation,
  DescribedHistoryEntry
} from '@/blog/features/wallet/lib/account-history';
import {
  nextCursorFrom,
  operationFilterMask,
  operationNamesForGroup,
  pageBoundsFromCursor,
  parseHistoryGroup,
  type HistoryGroup
} from '@/blog/features/wallet/lib/history-groups';

const logger = getLogger('app');

/**
 * The wallet's activity list, already described, one page at a time.
 *
 * ★★★ WHY IT IS DESCRIBED HERE (2026-08-13, browser audit §1.5).
 * `use-account-history.ts` called the chain FROM THE BROWSER — two of the
 * nineteen direct api.hive.blog requests the wallet page made, and two of the
 * reasons it downloaded `wax.common.wasm`. Half of
 * `describeHistoryOperation`'s output needs a wax `Chain`: `formatHp` converts
 * vests to HP through `convertToHP`, and `symbolFor` reads `getNaiSymbols()`,
 * which only gets populated by `initializeAssetConstants(chain.ASSETS)` when a
 * chain instance is built. Returning raw operations and describing them in the
 * browser would therefore have kept wax in the bundle and, worse, degraded
 * silently if it were removed — `symbolFor` catches its own throw and returns
 * `''`, so every amount would quietly lose its "HIVE"/"HBD" suffix instead of
 * failing loudly.
 *
 * `describeHistoryOperation` emits i18n KEYS plus params rather than sentences,
 * so describing server-side changes nothing about translation. The one
 * genuinely locale-dependent step inside it is `Intl.ListFormat` joining a
 * multi-asset reward ("12 HIVE, 3 HBD and 450 HP"), which is why `lang` crosses
 * the wire; Node has full ICU, so it produces the same string the browser did.
 *
 * ★★★ REWRITTEN ONTO `account_history_api.get_account_history` (2026-09-18,
 * owner: "on the hive tab you cant scroll further in the past").
 *
 * It used to call `hivemind-api/accounts/{name}/operations` with `page-size=25`
 * and no page, which has TWO defects this page cannot live with:
 *
 *  1. NO WAY BACK. Its pages are numbered from the OLDEST operation, so the
 *     newest page is `total_pages` — a number that moves every time the account
 *     transacts. Paging back means `total_pages - 1`, computed against a total
 *     that shifts under the reader, duplicating or skipping rows.
 *  2. THE FIRST PAGE WAS THE REMAINDER. Measured on api.hive.blog 2026-09-18:
 *     with `page-size=7` an account with 59,322 matching operations answered
 *     with FOUR. The wallet was not showing "the 25 most recent" — it was
 *     showing `total mod 25` of them, between 1 and 25, and calling it Recent
 *     activity.
 *
 * `get_account_history` takes a per-account operation SEQUENCE NUMBER as its
 * cursor (`start`, -1 = newest) and walks back `limit` MATCHING operations from
 * there — verified live: a filter for one rare op type returned a match from
 * 2022 out of 658k operations, so the scan is the whole history, not a window.
 * Sequence numbers never move, so "older" is stable however much arrives while
 * somebody reads.
 *
 * ★ THE OPERATION FILTER IS A uint64 BITSET SENT AS A STRING. See
 * `history-groups.ts` for the measurement; passing it as a JS number rounds it
 * and silently changes which operations come back.
 *
 * `private, no-store`: one account's transaction history.
 */

/** Rows per page. Also the "Load older" step. */
const HISTORY_PAGE_SIZE = 25;
const HISTORY_MEMO_MS = 5_000;
/** hived's own ceiling on `get_account_history`. */
const MAX_HISTORY_LIMIT = 1000;
/**
 * Operation type ids are chain constants: 93 of them today, appended only by a
 * hardfork. Ten minutes is a compromise between "never ask twice per page" and
 * "a hardfork does not need a redeploy".
 */
const OP_TYPES_MEMO_MS = 600_000;

/** BCP-47-ish shape check. Only ever reaches `Intl.ListFormat`, which falls back on its own. */
const LANG = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})*$/;

export interface WalletHistoryResponse {
  entries: DescribedHistoryEntry[];
  /** Pass back as `?cursor=` to get the next page of OLDER operations. */
  nextCursor: number | null;
  hasMore: boolean;
}

const EMPTY_PAGE: WalletHistoryResponse = { entries: [], nextCursor: null, hasMore: false };

/**
 * op type name -> id, memoised. Shared by every group and every account, so one
 * reader paging through their history pays for it once.
 */
async function operationTypeIds(names: readonly string[]): Promise<number[]> {
  const byName = await cachedRead('wallet:history:op-types', OP_TYPES_MEMO_MS, async () => {
    const chain = await getChain();
    // ★ RETRY + FAILOVER (2026-08-18). This read had none, and the route was
    // measured returning a flat HTTP 502 after a 7.72s stall.
    const opTypes = await withHiveRetry(
      () => chain.restApi['hafah-api']['operation-types'](),
      'hafah operation-types'
    );
    const map: Record<string, number> = {};
    for (const opType of opTypes) map[opType.operation_name] = opType.op_type_id;
    return map;
  });
  return names.map((name) => byName[name]).filter((id): id is number => typeof id === 'number');
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  const langParam = (req.nextUrl.searchParams.get('lang') ?? 'en').trim();
  const lang = LANG.test(langParam) ? langParam : 'en';
  const group: HistoryGroup = parseHistoryGroup(req.nextUrl.searchParams.get('group')) ?? 'all';

  /**
   * The cursor is a sequence number this route itself handed out. An absent
   * cursor means "the newest page"; a malformed one is rejected rather than
   * silently treated as newest, which would make "Load older" quietly restart
   * the list from the top.
   */
  const cursorParam = req.nextUrl.searchParams.get('cursor');
  let cursor: number | null = null;
  if (cursorParam !== null) {
    const parsed = Number(cursorParam);
    if (!Number.isInteger(parsed) || parsed < -1 || parsed > Number.MAX_SAFE_INTEGER) {
      return NextResponse.json({ error: 'cursor_invalid' }, { status: 400 });
    }
    // -1 is what the chain calls "newest"; below zero there is nothing older.
    if (parsed < 0) return NextResponse.json(EMPTY_PAGE, { headers: { 'cache-control': 'private, no-store' } });
    cursor = parsed;
  }

  /**
   * ★★★ A KEYLESS LUMEN ACCOUNT HAS NO HIVE WALLET, AND THE ONE UNDER ITS NAME IS
   * SOMEBODY ELSE'S (2026-09-11).
   *
   * These three routes validated the SHAPE of `username` and handed it straight to the
   * chain. For a squatted name that returns the squatter's real account -- keys,
   * balances, transaction history -- under the victim's name, on a public
   * unauthenticated endpoint backing `/@name/wallet`. Measured on production
   * 2026-09-11: `/api/wallet/summary?username=chadmasters` returned an account object
   * carrying real populated `key_auths`, while the correctly-guarded `/api/account`
   * returned `key_auths: []` for the same name. That difference is the whole bug in
   * one field.
   *
   * A wallet reader may be about to send funds. `account_not_found` is the truthful
   * answer for a name with no chain identity of its own, and it is the answer these
   * routes already give for an ordinary lite account -- this just stops the squatter's
   * presence from changing it. Upgraded users keep their real chain wallet.
   */
  if (await isKeylessLiteName(username)) {
    return NextResponse.json(accountNotFoundBody(new HiveAccountNotFoundError(username)), {
      status: 404,
      headers: { 'cache-control': 'private, no-store' }
    });
  }

  try {
    const payload = await cachedRead(
      `wallet:history:${username}:${lang}:${group}:${cursor ?? 'head'}`,
      HISTORY_MEMO_MS,
      async () => {
        const chain = await getChain();
        const ids = await operationTypeIds(operationNamesForGroup(group));
        if (ids.length === 0) {
          // The node answered with an operation-type table that contains none
          // of the names this wallet knows. That is a broken upstream, not an
          // empty history — say so instead of rendering "no transactions yet".
          throw new Error(`no operation type ids resolved for group ${group}`);
        }
        const mask = operationFilterMask(ids);

        // hived asserts `start >= limit - 1`; `pageBoundsFromCursor` owns that
        // rule (and is unit-tested), this route only caps the page at the
        // node's own maximum.
        const { start, limit } = pageBoundsFromCursor(cursor, Math.min(HISTORY_PAGE_SIZE, MAX_HISTORY_LIMIT));

        // F1 (2026-09-08): a name the chain never registered gets an empty
        // history back, which would render as an honest-looking empty wallet.
        // One memoised existence read (shared with the summary and delegations
        // routes within the same 3s) turns that into a 404.
        const [, response, dynamicGlobal] = await Promise.all([
          assertHiveAccountExists(username).then(() => undefined),
          withHiveRetry(
            () =>
              chain.api.account_history_api.get_account_history({
                account: username,
                start,
                limit,
                include_reversible: true,
                operation_filter_low: mask.low,
                operation_filter_high: mask.high
              }),
            'account_history get_account_history'
          ),
          getDynamicGlobalProperties()
        ]);

        // The chain answers oldest-first; the list reads newest-first. Sorted
        // rather than reversed so the order is ours, not the node's promise.
        const history = [...(response.history ?? [])].sort((a, b) => a[0] - b[0]);
        const entries = history
          .slice()
          .reverse()
          .map(([sequence, op]) => describeHistoryOperation(op, { username, chain, dynamicGlobal }, lang, String(sequence)))
          .filter((entry): entry is DescribedHistoryEntry => entry !== null);

        const { nextCursor, hasMore } = nextCursorFrom(history.map(([sequence]) => sequence), limit);
        const body: WalletHistoryResponse = { entries, nextCursor, hasMore };
        return body;
      }
    );
    return NextResponse.json(payload, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof HiveAccountNotFoundError) {
      return NextResponse.json(accountNotFoundBody(error), { status: 404, headers: { 'cache-control': 'private, no-store' } });
    }
    logger.error(error, 'wallet history failed for %s', username);
    return NextResponse.json({ error: 'wallet_history_unavailable' }, { status: 502 });
  }
}
