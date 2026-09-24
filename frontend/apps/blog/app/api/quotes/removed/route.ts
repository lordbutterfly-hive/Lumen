import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { confirmHiveQuoteRemoved } from '@/blog/lib/lite/content/quote-service';
import { readHiveQuoteRequest, refusal } from '@/blog/lib/lite/http/quote-route';

const logger = getLogger('app');

/**
 * POST /api/quotes/removed — { author, permlink } (Hive login). After the user deleted or blanked their reblog comment (or undid the reblog), verify it on chain and stop showing it (spec v2 7.4).
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const req2 = await readHiveQuoteRequest(req);
  if (!req2.ok) return req2.response;
  try {
    const result = await confirmHiveQuoteRemoved(req2.quoter, req2.author, req2.permlink);
    if (!result.ok) return refusal(result.reason);
    return NextResponse.json(result.value);
  } catch (error) {
    logger.error(error, 'quotes/removed failed for %s/%s', req2.author, req2.permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
