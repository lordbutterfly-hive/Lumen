import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { unfollowByName } from '@/blog/lib/lite/social/follow-service';

const logger = getLogger('app');

/**
 * POST /api/lite/unfollow — { followeeName }. Mirror of the follow route; a suspended
 * account may still take back a follow (withdrawal, not participation).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const followeeName = body?.followeeName;
  if (typeof followeeName !== 'string') {
    return NextResponse.json({ error: 'followeeName_required' }, { status: 400 });
  }

  try {
    const result = await unfollowByName(session.user, followeeName, session.sessionEpoch);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, following: false });
  } catch (error) {
    logger.error(error, 'Lite unfollow failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
