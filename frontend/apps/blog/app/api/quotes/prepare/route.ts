import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { prepareHiveQuote } from '@/blog/lib/lite/content/quote-service';
import { readHiveQuoteRequest, refusal } from '@/blog/lib/lite/http/quote-route';

const logger = getLogger('app');

/**
 * POST /api/quotes/prepare — { author, permlink } (Hive login). Check the rules and say where a Hive user's reblog comment goes (spec v2 7.2 step 1).
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const req2 = await readHiveQuoteRequest(req);
  if (!req2.ok) return req2.response;
  try {
    const result = await prepareHiveQuote(req2.quoter, req2.hiveName, req2.author, req2.permlink);
    if (!result.ok) return refusal(result.reason);
    return NextResponse.json(result.value);
  } catch (error) {
    logger.error(error, 'quotes/prepare failed for %s/%s', req2.author, req2.permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
