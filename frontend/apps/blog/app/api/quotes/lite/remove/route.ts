import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedJson, payloadTooLarge } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireLiteUser } from '@/blog/lib/lite/http/actor';
import { removeLiteQuote } from '@/blog/lib/lite/content/quote-service';

const logger = getLogger('app');

/**
 * POST /api/quotes/lite/remove — { author, permlink, undoReblog? } (lite session). Remove the lite user's reblog comment on this post, and undo the reblog when asked (spec v2 7.4). A withdrawal: allowed while suspended.
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await getLiteSession();
  const actor = await requireLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const parsed = await readBoundedJson(req);
  if (parsed === null) return payloadTooLarge();
  const { author, permlink, undoReblog } = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof author !== 'string' || typeof permlink !== 'string' || !author || !permlink) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    return NextResponse.json(await removeLiteQuote(actor.user.userId, author.toLowerCase(), permlink, undoReblog === true));
  } catch (error) {
    logger.error(error, 'quotes/lite/remove failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
