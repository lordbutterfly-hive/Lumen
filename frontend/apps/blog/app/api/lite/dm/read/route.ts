import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { markDmsRead } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * POST /api/lite/dm/read (authed)  { threadId?: string }
 *
 * Marks the caller's unread INCOMING messages read (read_at = now). With `threadId`,
 * only that conversation; without it, all of the caller's threads (what opening the
 * Messages inbox does). Idempotent — a repeat call marks nothing. The service resolves
 * the caller from the session and only ever touches messages the caller received in
 * their own threads; content is never touched.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const threadId = typeof body?.threadId === 'string' ? body.threadId : undefined;

  try {
    const result = await markDmsRead(session.user, session, { threadId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, marked: result.marked });
  } catch (error) {
    logger.error(error, 'DM mark-read failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
