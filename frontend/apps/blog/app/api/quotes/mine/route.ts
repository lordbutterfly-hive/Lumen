import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { sessionActor } from '@/blog/lib/lite/social/follow-actor';
import { findActive } from '@/blog/lib/lite/repositories/quote-repository';

const logger = getLogger('app');

/**
 * GET /api/quotes/mine?author=&permlink= — the signed-in person's own reblog comment on this post (Hive or lite login), so the reblog popup can open with it filled in. `{ quote: null }` when they have none or are signed out. Read-only.
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;
  const author = req.nextUrl.searchParams.get('author')?.toLowerCase() ?? '';
  const permlink = req.nextUrl.searchParams.get('permlink') ?? '';
  if (!author || !permlink) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const noStore = { headers: { 'cache-control': 'private, no-store' } };
  try {
    const session = await getLiteSession();
    const quoter = await sessionActor(session.user);
    if (!quoter) return NextResponse.json({ quote: null }, noStore);
    const quote = await findActive(quoter, author, permlink);
    return NextResponse.json({ quote: quote ? { state: quote.state, body: quote.bodyCache } : null }, noStore);
  } catch (error) {
    logger.error(error, 'quotes/mine failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
