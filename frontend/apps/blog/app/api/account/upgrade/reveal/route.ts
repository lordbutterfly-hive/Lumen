import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { acknowledgeReveal, fetchOutstandingReveal } from '@/blog/lib/lite/upgrade/upgrade-service';

const logger = getLogger('app');

/**
 * The recovery half of the upgrade flow.
 *
 * `POST /api/account/upgrade` returns the new account's keys exactly once, and until
 * migration 0015 that single HTTP response was the only copy in existence — a dropped
 * connection lost the account. These two handlers are the way back:
 *
 *   GET  — re-fetch the keys this session's user is still owed.
 *   POST — "I have written them down", which wipes the stored copy.
 *
 * Both are scoped to the signed-in user; a reveal id is a label, not a capability.
 * Neither response is cacheable — the body contains private keys.
 */

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' };

export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  try {
    const result = await fetchOutstandingReveal(session.user);
    if (result.status === 'error') {
      const status =
        result.code === 'unauthorized' ? 401 : result.code === 'reveal_unreadable' ? 500 : 404;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    logger.error(error, 'Lite key reveal fetch failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const revealId = body?.revealId;
  if (typeof revealId !== 'string' || !revealId) {
    return NextResponse.json({ error: 'revealId_required' }, { status: 400 });
  }

  try {
    const result = await acknowledgeReveal(session.user, revealId);
    if (result.status === 'error') {
      return NextResponse.json(result, { status: result.code === 'unauthorized' ? 401 : 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite key reveal acknowledgement failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
