import { NextRequest, NextResponse } from 'next/server';
import { ensureSquatterList, isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';
import { getLogger } from '@ui/lib/logging';
import { getRebloggedBy } from '@transaction/lib/hive-api';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/list-of-posts/hooks/use-
 * reblogged-by-query.ts` called `getRebloggedBy` directly.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '').toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(author) || !/^[a-z0-9-]{1,255}$/.test(permlink)) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }
  try {
    const rebloggers = await getRebloggedBy(author, permlink);
    /**
     * ★★★ "REBLOGGED BY @X" CREDITED THE VICTIM FOR THE SQUATTER'S RESHARE
     * (2026-09-11).
     *
     * This list is rendered as a byline credit on the post card. A squatter resharing
     * anything put their name on that card, and since `/@<name>` resolves a squatted
     * name to the LITE account, the credit and its link pointed at the person being
     * impersonated. Same shape and same reasoning as the voter roster in
     * `/api/active-votes`: a reblog carries no lite overlay, so the name is
     * unambiguously the chain account. Awaited, or a cold worker filters nobody.
     */
    await ensureSquatterList();
    const visible = Array.isArray(rebloggers) ? rebloggers.filter((name) => !isSquatterName(name)) : rebloggers;

    return NextResponse.json(visible, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'reblogged-by lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'reblogged_by_unavailable' }, { status: 502 });
  }
}
