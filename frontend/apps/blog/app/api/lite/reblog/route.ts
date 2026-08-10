import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser, requireLiteUser } from '@/blog/lib/lite/http/actor';
import { enforceReblogRate } from '@/blog/lib/lite/antispam/rate-limit';
import { reblog, unreblog } from '@/blog/lib/lite/repositories/engagement-repository';
import { checkEngagementTarget } from '@/blog/lib/lite/content/engagement-target';

const logger = getLogger('app');

/**
 * POST /api/lite/reblog — { author, permlink, undo? } (lite session).
 * Lumen-local reblog (not proxied on-chain; see engagement-repository).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const author = body?.author;
  const permlink = body?.permlink;
  const undo = body?.undo === true;
  if (typeof author !== 'string' || typeof permlink !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Undoing a reblog is a withdrawal, so a suspended account may still do it; adding
  // one is participation and may not (see http/actor.ts).
  const actor = undo ? await requireLiteUser(session.user, session) : await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  // F-L34 — undo is a withdrawal and stays ungated; adding a reblog is not.
  if (!undo) {
    const target = await checkEngagementTarget(user, author, permlink);
    if (!target.ok) {
      return NextResponse.json({ error: target.code }, { status: target.status });
    }
  }

  try {
    if (!(await enforceReblogRate(user.userId))) {
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
