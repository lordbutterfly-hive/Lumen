import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listThreadMessages } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * GET /api/lite/dm/threads/[id]/messages?limit=&before= (authed, paginated)
 *   -> that thread's ciphertext messages, newest first — ONLY if the caller is one of
 *      the thread's two participants (enforced in the service; a non-participant gets a
 *      404 that does not reveal the thread exists).
 *
 * `before` is a ULID cursor (the oldest message_id from the previous page). Every
 * message's `nonce`/`ciphertext` is opaque; the browser decrypts them.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const before = req.nextUrl.searchParams.get('before') ?? undefined;

  try {
    const result = await listThreadMessages(session.user, session, params.id, {
      limit: Number.isFinite(limitParam) ? limitParam : undefined,
      before
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      thread_id: result.threadId,
      status: result.status,
      other_actor_key: result.otherActorKey,
      messages: result.messages
    });
  } catch (error) {
    logger.error(error, 'DM messages lookup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
