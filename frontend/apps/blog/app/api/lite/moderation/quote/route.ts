import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardModerator, guardBodySize } from '@/blog/lib/lite/http/guard';
import { moderateQuote } from '@/blog/lib/lite/moderation/moderation-service';
import { findByCoords } from '@/blog/lib/lite/repositories/quote-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/moderation/quote — { quoteId | author+permlink of the comment, hidden: boolean, reason } (moderator token). Hide or restore one reblog comment on Lumen (spec v2 7.6). For a Hive user's quote the chain keeps it; Lumen stops showing it. A lite quote is moderated through its post (/api/lite/moderation/post), which can also take it off Hive.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardModerator(req);
  if (blocked) return blocked;
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.hidden !== 'boolean') return NextResponse.json({ error: 'hidden_required' }, { status: 400 });
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (body.hidden && !reason) return NextResponse.json({ error: 'reason_required' }, { status: 400 });

  let quoteId = typeof body?.quoteId === 'string' ? body.quoteId : '';
  if (!quoteId && typeof body?.author === 'string' && typeof body?.permlink === 'string') {
    quoteId = (await findByCoords(body.author.toLowerCase(), body.permlink))?.quoteId ?? '';
  }
  if (!quoteId) return NextResponse.json({ error: 'quote_not_found' }, { status: 404 });

  try {
    const quote = await moderateQuote({
      actor: req.headers.get('x-lite-moderator-actor')?.trim() || 'operator',
      quoteId,
      hidden: body.hidden,
      reason: reason || null
    });
    if (!quote) return NextResponse.json({ error: 'quote_not_found' }, { status: 404 });
    return NextResponse.json({ status: 'ok', quoteId: quote.quoteId, state: quote.state });
  } catch (error) {
    logger.error(error, 'moderation/quote failed for %s', quoteId);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
