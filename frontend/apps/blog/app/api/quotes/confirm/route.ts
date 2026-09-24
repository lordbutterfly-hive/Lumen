import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { confirmHiveQuote } from '@/blog/lib/lite/content/quote-service';
import { readHiveQuoteRequest, refusal } from '@/blog/lib/lite/http/quote-route';

const logger = getLogger('app');

/**
 * POST /api/quotes/confirm — { author, permlink } (Hive login). After the user broadcast, verify the reblog comment ON CHAIN and index it (spec v2 7.2 step 3).
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const req2 = await readHiveQuoteRequest(req);
  if (!req2.ok) return req2.response;
  try {
    const result = await confirmHiveQuote(req2.quoter, req2.hiveName, req2.author, req2.permlink);
    if (!result.ok) return refusal(result.reason);
    return NextResponse.json({ quote: { state: result.value.state, body: result.value.bodyCache, permlink: result.value.quotePermlink } });
  } catch (error) {
    logger.error(error, 'quotes/confirm failed for %s/%s', req2.author, req2.permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
