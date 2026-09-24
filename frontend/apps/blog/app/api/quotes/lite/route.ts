import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedJson, payloadTooLarge } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { saveLiteQuote } from '@/blog/lib/lite/content/quote-service';
import { refusal } from '@/blog/lib/lite/http/quote-route';

const logger = getLogger('app');

/**
 * POST /api/quotes/lite — { author, permlink, caption } (lite session). Create or edit the lite user's reblog comment on this post; Lumen publishes it to Hive for them (spec v2 8.1). The reblog is added with it.
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await getLiteSession();
  if (!session.user?.isLoggedIn || session.user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const parsed = await readBoundedJson(req);
  if (parsed === null) return payloadTooLarge();
  const { author, permlink, caption } = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof author !== 'string' || typeof permlink !== 'string' || typeof caption !== 'string' || !author || !permlink) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    const result = await saveLiteQuote(session.user, session, author.toLowerCase(), permlink, caption);
    if (!result.ok) return refusal(result.reason);
    return NextResponse.json(result.value);
  } catch (error) {
    logger.error(error, 'quotes/lite failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
