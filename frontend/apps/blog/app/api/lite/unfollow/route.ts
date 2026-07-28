import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireLiteUser } from '@/blog/lib/lite/http/actor';
import { enforceFollowRate } from '@/blog/lib/lite/antispam/rate-limit';
import { findUserByDisplayName } from '@/blog/lib/lite/repositories/user-repository';
import { unfollow } from '@/blog/lib/lite/repositories/follow-repository';

const logger = getLogger('app');

/** POST /api/lite/unfollow — { followeeName } (lite session). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  // Withdrawal, not participation: a suspended account may still unfollow.
  const actor = await requireLiteUser(session.user);
  if (!actor.ok) return actor.response;
  const user = actor.user;
  // FOLLOW-RECSYS-1 (PRUNED 2026-07-22): cap unfollow too — follow WAS capped but
  // unfollow wasn't, so an attacker could churn follow/unfollow to spam the recsys
  // edge feed. (The structural tombstone/resync fix for phantom edges is tracked
  // separately with the recsys consumer contract.)
  if (!(await enforceFollowRate(user.userId))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const followeeName = body?.followeeName;
  if (typeof followeeName !== 'string') {
    return NextResponse.json({ error: 'followeeName_required' }, { status: 400 });
  }

  try {
    const followee = await findUserByDisplayName(followeeName);
    if (!followee) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    await unfollow(user.userId, followee.userId);
    return NextResponse.json({ ok: true, following: false });
  } catch (error) {
    logger.error(error, 'Lite unfollow failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
