import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { blockState } from '@/blog/lib/lite/social/block-service';
import { isBlockTargetKind } from '@/blog/lib/lite/social/block-actor';

const logger = getLogger('app');

/**
 * GET /api/lite/block/state?target=<name>&kind=<hive|lumen|auto> — is the viewer
 * blocking this person, and should a Block control be offered at all?
 *
 * Shares the signup-funnel per-IP budget for the same reason the follow-state route
 * does: resolving a name we do not already know costs a Hive API call.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const target = req.nextUrl.searchParams.get('target') ?? '';
  if (!target) return NextResponse.json({ error: 'target_required' }, { status: 400 });
  const rawKind = req.nextUrl.searchParams.get('kind');
  const kind = isBlockTargetKind(rawKind) ? rawKind : 'auto';

  if (!(await enforceLookupRate(getClientIp(req)))) {
    return NextResponse.json({ ok: false, available: false, blocking: false }, { status: 429 });
  }

  try {
    const session = await getLiteSession();
    const state = await blockState(session.user, target, kind);
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    logger.error(error, 'Lumen block state failed');
    // Degrade to "no control, not blocking". A failed lookup must never claim a
    // block that may not exist, nor make the button vanish into an error state.
    return NextResponse.json({ ok: false, available: false, blocking: false });
  }
}
