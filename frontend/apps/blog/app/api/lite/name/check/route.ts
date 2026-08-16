import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { checkNameAvailability } from '@/blog/lib/lite/names/vetting';
// Server-side t(): this route runs inside a Next request (Route Handlers get the
// same request-scoped `cookies()` a Server Component does), which is exactly the
// context checkNameAvailability/vetNameFormat do NOT have — see the ReservedCode
// comment in lib/lite/names/vetting.ts for why the translation happens here and
// not there. Aliased for the same reason as the `loading.tsx` files: this is the
// async SERVER helper, not the `useTranslation` React hook.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

const logger = getLogger('app');

/**
 * GET /api/lite/name/check?name=<name> — read-only availability check for live
 * UX feedback (format + reserved + on-chain existence). Does not reserve.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;
  // Uncapped this fans out two Hive API calls per request — free ammunition
  // against Hive and a name-enumeration surface.
  if (!(await enforceLookupRate(getClientIp(req)))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const name = req.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 });
  }
  try {
    const result = await checkNameAvailability(name);
    // H6: a "reserved" refusal carries a translation code (see ReservedCode in
    // vetting.ts) instead of already being localized — resolve it to the caller's
    // locale here, at the one place in this call chain that has a request to read
    // that locale from. Every other refusal reason is unaffected.
    if (!result.available && result.code) {
      const { t } = await getServerTranslation('common_blog');
      // Not spreading `result`: `code` is an internal i18n key, not part of the
      // public response shape (`{ available, reason }`), so it stays server-side.
      return NextResponse.json({ available: false, reason: t(result.code, { name: name.trim() }) });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite name check failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
