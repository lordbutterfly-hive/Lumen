import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { followState } from '@/blog/lib/lite/social/follow-service';

const logger = getLogger('app');

/**
 * GET /api/lite/follow/state?target=<name> — does the viewer follow this person on
 * Lumen, and is Lumen where that follow belongs?
 *
 * The Follow button used to read the viewer's Hive following list, which can never
 * contain a Lumen-local edge, so it said "Follow" no matter how many times it was
 * pressed. This is the missing read side.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const target = req.nextUrl.searchParams.get('target') ?? '';
  if (!target) return NextResponse.json({ error: 'target_required' }, { status: 400 });

  // Resolving an unknown name costs a Hive API call, so this is the same class of
  // endpoint as the name-availability check and shares its per-IP budget.
  if (!(await enforceLookupRate(getClientIp(req)))) {
    return NextResponse.json({ ok: false, lumenEdge: false, following: false }, { status: 429 });
  }

  try {
    const session = await getLiteSession();
    const state = await followState(session.user, target);
    return NextResponse.json({ ok: true, ...state });
  } catch (error) {
    logger.error(error, 'Lite follow state failed');
    // Degrade to "not following, not ours": a failed lookup must never make the
    // button vanish or claim a relationship that may not exist.
    return NextResponse.json({ ok: false, lumenEdge: false, following: false });
  }
}
