import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { planHiveQuoteRemoval } from '@/blog/lib/lite/content/quote-service';
import { readHiveQuoteRequest } from '@/blog/lib/lite/http/quote-route';

const logger = getLogger('app');

/**
 * POST /api/quotes/remove-plan — { author, permlink } (Hive login). What removing their reblog comment on this post takes, read from the node now: `{ plan: null }` when nothing of theirs is on chain, otherwise where it is and whether Hive allows a real delete (else it is blanked). Spec v2 4 and 7.4.
 * `author`/`permlink` are the reblogged post's on-chain coordinates.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const req2 = await readHiveQuoteRequest(req);
  if (!req2.ok) return req2.response;
  try {
    return NextResponse.json({ plan: await planHiveQuoteRemoval(req2.hiveName, req2.author, req2.permlink) });
  } catch (error) {
    logger.error(error, 'quotes/remove-plan failed for %s/%s', req2.author, req2.permlink);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
