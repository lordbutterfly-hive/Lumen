import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { findUserByDisplayName } from '@/blog/lib/lite/repositories/user-repository';
import { follow } from '@/blog/lib/lite/repositories/follow-repository';
import { enforceFollowRate } from '@/blog/lib/lite/antispam/rate-limit';

const logger = getLogger('app');

/** POST /api/lite/follow — { followeeName } (lite session). Rate-limited (§H). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const followeeName = body?.followeeName;
  if (typeof followeeName !== 'string') {
    return NextResponse.json({ error: 'followeeName_required' }, { status: 400 });
  }

  try {
    const followee = await findUserByDisplayName(followeeName);
    if (!followee) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    if (followee.userId === user.userId) {
      return NextResponse.json({ error: 'cannot_follow_self' }, { status: 400 });
    }
    if (!(await enforceFollowRate(user.userId))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    const created = await follow(user.userId, followee.userId);
    return NextResponse.json({ ok: true, following: true, created });
  } catch (error) {
    logger.error(error, 'Lite follow failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
