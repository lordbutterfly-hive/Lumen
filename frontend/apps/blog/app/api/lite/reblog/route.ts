import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { enforceFollowRate } from '@/blog/lib/lite/antispam/rate-limit';
import { reblog, unreblog } from '@/blog/lib/lite/repositories/engagement-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/reblog — { author, permlink, undo? } (lite session).
 * Lumen-local reblog (not proxied on-chain; see engagement-repository).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const author = body?.author;
  const permlink = body?.permlink;
  const undo = body?.undo === true;
  if (typeof author !== 'string' || typeof permlink !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    if (!(await enforceFollowRate(user.userId))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
    if (undo) {
      await unreblog(user.userId, author, permlink);
      return NextResponse.json({ ok: true, reblogged: false });
    }
    const created = await reblog(user.userId, author, permlink);
    return NextResponse.json({ ok: true, reblogged: true, created });
  } catch (error) {
    logger.error(error, 'Lite reblog failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
