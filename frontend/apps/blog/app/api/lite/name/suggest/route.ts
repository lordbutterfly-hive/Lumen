import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { suggestNames } from '@/blog/lib/lite/names/suggest';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { LITE_HANDLE_REUSE_MESSAGE, isOwnLiteHandle } from '@/blog/lib/lite/names/upgrade-name';

const logger = getLogger('app');

/**
 * GET /api/lite/name/suggest?name=<name> — is this Hive name free, and if not, what
 * close alternatives are?
 *
 * Backs the upgrade name picker. A Lumen handle is not reserved on Hive (reserving
 * one would mean spending an account creation token), so the picker has to be honest
 * that the user's own handle may be gone, and useful about what to pick instead.
 *
 * Rate limiting, stated accurately: this shares the `lookup` budget with
 * `/api/lite/name/check` and costs one unit, but it answers for the base name AND up
 * to ten fixed derivatives — so per unit it reveals more names than `/check` does.
 * That is fine on both counts that matter. It makes ONE batched `find_accounts` call
 * where `/check` makes two, so it is strictly LIGHTER on Hive per request (the reason
 * `/check` is capped at all). And Hive account existence is public and uncapped at
 * the source — anyone can ask `api.hive.blog` directly, without us — so there is no
 * secret here to ration, only our own upstream courtesy budget.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  if (!(await enforceLookupRate(getClientIp(req)))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });

  try {
    // The one name this picker can never grant is the caller's own Lumen handle —
    // the upgrade service refuses it because the DB constraint makes the resulting
    // row impossible (names/upgrade-name.ts). Hive often has it free, so without
    // this the picker would say "available" about a name the server then rejects.
    const session = await getLiteSession();
    const handle = session.user?.account_tier === 'lite' ? session.user.username : '';
    const refuseBaseBecause =
      handle && isOwnLiteHandle(name, handle) ? LITE_HANDLE_REUSE_MESSAGE : undefined;

    return NextResponse.json(await suggestNames(name, { refuseBaseBecause }));
  } catch (error) {
    logger.error(error, 'Lite name suggestion failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
