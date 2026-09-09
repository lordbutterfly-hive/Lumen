import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { isValidAccountNameFormat } from '@transaction/lib/validation';
import { getAccounts } from '@transaction/lib/hive-api';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { takeSuggestToken } from '@/blog/lib/search/suggest-limiter';

/**
 * ★ BOUNDED BEFORE IT COSTS ANYTHING (security scrutiny S-3, 2026-09-09).
 * The wallet's recipient picker now asks this route while a person types, not
 * only on submit, and the route was unauthenticated, unthrottled and took a name
 * of any length straight into the WASM validator and then into
 * `getAccountFull`, whose own measurement is nineteen upstream requests for one
 * name. Three changes, in the order they run:
 *  1. a Hive name is at most 16 characters; anything longer is answered as
 *     "not a valid name" without touching the validator;
 *  2. the same per-IP token bucket the sibling /api/search/people takes
 *     (suggest-limiter.ts), taken BEFORE any upstream work, 429 + retry-after;
 *  3. existence is ONE `database_api.find_accounts` (`getAccounts`), which
 *     answers the only question asked here and carries `posting_json_metadata`
 *     for the display name. The profile and follow-graph legs of
 *     `getAccountFull` were never read by any caller of this route.
 */
const MAX_HIVE_NAME_LEN = 16;

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`, for account-name VALIDATION rather than
 * profile data. Three browser call sites checked a typed-in account name
 * against the chain directly — `features/witnesses/set-proxy-dialog.tsx`
 * (`checkAccountExists`), `features/proposals/components/set-proxy-dialog.tsx`
 * (`isHiveAccountNameValid` + `getAccount`), and `features/account-lists/
 * hooks/use-add-to-list-form.ts` (`isValidAccountNameFormat` +
 * `checkAccountExists`). Every one of those reaches `getChain()` and
 * downloads `wax.common.wasm`, and all three only run on an explicit user
 * action (submitting a proxy/add-to-list form), never on every keystroke.
 *
 * `isValidAccountNameFormat` itself calls `getChain()` too (it validates via
 * WASM, with a regex fallback only on WASM memory errors — see
 * `validate-hive-account.ts`), so doing the format check here first, before
 * the existence lookup, still keeps both chain touches on the server.
 *
 * Returns the same discriminated shape `checkAccountExists` already used
 * (`ExistenceResult`), plus `validFormat`, so callers can tell "malformed
 * name" apart from "well-formed but not on chain" apart from "could not ask".
 *
 * NOT CACHED, NOT `public`: this answers a form the reader is actively
 * filling in, and a stale "not found" for an account that was just created
 * would be a worse failure mode than one extra chain round trip.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const name = (req.nextUrl.searchParams.get('name') ?? '').trim().toLowerCase();
  if (!name) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 });
  }
  if (name.length > MAX_HIVE_NAME_LEN) {
    return NextResponse.json({ validFormat: false, status: 'not_found' }, { headers: { 'cache-control': 'private, no-store' } });
  }
  if (!takeSuggestToken(`exists:${getClientIp(req)}`)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'cache-control': 'private, no-store', 'retry-after': '5' } });
  }
  try {
    const validFormat = await isValidAccountNameFormat(name);
    if (!validFormat) {
      return NextResponse.json(
        { validFormat: false, status: 'not_found' },
        { headers: { 'cache-control': 'private, no-store' } }
      );
    }
    // One find_accounts. The api_error branch flattens the Error to a message
    // string (Error's own fields are non-enumerable and would serialise to {}).
    let body: Record<string, unknown>;
    try {
      const account = (await getAccounts([name]))[0];
      body =
        account && account.name === name
          ? { validFormat: true, status: 'exists', data: account }
          : { validFormat: true, status: 'not_found' };
    } catch (error) {
      body = { validFormat: true, status: 'api_error', error: error instanceof Error ? error.message : String(error) };
    }
    return NextResponse.json(body, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account-exists lookup failed for %s', name);
    return NextResponse.json({ error: 'account_exists_unavailable' }, { status: 502 });
  }
}
