import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { unreadDmCount } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * GET /api/lite/dm/unread (authed) -> { count }
 *
 * How many unread INCOMING messages the caller has across all their threads. Drives the
 * Creator Studio Messages-tab badge and the notifications bell's new-message indicator.
 * Content is never touched — a count only. The service resolves the caller from the
 * session (both account tiers) and counts only messages in the caller's own threads.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  try {
    const result = await unreadDmCount(session.user, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ count: result.count });
  } catch (error) {
    logger.error(error, 'DM unread count failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
