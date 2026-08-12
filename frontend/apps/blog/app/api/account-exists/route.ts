import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { checkAccountExists, isValidAccountNameFormat } from '@transaction/lib/validation';

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
  try {
    const validFormat = await isValidAccountNameFormat(name);
    if (!validFormat) {
      return NextResponse.json(
        { validFormat: false, status: 'not_found' },
        { headers: { 'cache-control': 'private, no-store' } }
      );
    }
    const result = await checkAccountExists(name);
    // `ExistenceResult`'s `api_error` branch carries a real `Error` object, which
    // `NextResponse.json` would serialize to `{}` (Error's own fields are
    // non-enumerable) — flatten it to a message string so the client-side
    // `status === 'api_error'` branches (which never read the object anyway,
    // only the status) get something readable if they ever do.
    const body =
      result.status === 'api_error'
        ? { validFormat: true, status: result.status, error: result.error.message }
        : { validFormat: true, ...result };
    return NextResponse.json(body, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'account-exists lookup failed for %s', name);
    return NextResponse.json({ error: 'account_exists_unavailable' }, { status: 502 });
  }
}
