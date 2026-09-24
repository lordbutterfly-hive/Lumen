import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '@/blog/lib/lite/config';
import { liveQuotesOfTarget } from '@/blog/lib/lite/repositories/quote-repository';

const logger = getLogger('app');

/**
 * GET /api/quotes/of?author=&permlink= — the live reblog comments on one post, newest
 * first (the post page's "N quotes" list, spec v2 3.1). Public; the reader's blocks and
 * mutes are applied where the list is rendered with the quoters' entries (step 10).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!liteConfig.quoteReblogsEnabled) return NextResponse.json({ quotes: [] });
  const author = (req.nextUrl.searchParams.get('author') ?? '').toLowerCase();
  const permlink = req.nextUrl.searchParams.get('permlink') ?? '';
  if (!author || !permlink) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const rows = await liveQuotesOfTarget(author, permlink, 50);
    return NextResponse.json({
      quotes: rows.map((q) => ({
        quoter: q.quoterHive ?? null,
        quoterUserId: q.quoterUserId ?? null,
        author: q.quoteAuthor,
        permlink: q.quotePermlink,
        body: q.bodyCache,
        createdAt: q.createdAt.toISOString()
      }))
    });
  } catch (error) {
    logger.warn(error, 'quotes/of failed for %s/%s', author, permlink);
    return NextResponse.json({ quotes: [] });
  }
}
