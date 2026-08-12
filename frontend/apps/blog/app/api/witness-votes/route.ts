import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListWitnessVotes } from '@transaction/lib/hive';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`, and the same page as `/api/witnesses`:
 * `use-witnesses-data.ts`'s `ownVotesQuery` called `getListWitnessVotes`
 * directly. Signed-in only (it is the reader's own witness votes), so this
 * one is `private, no-store` for an additional reason beyond the blanket
 * policy — the answer genuinely is per-viewer.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = (req.nextUrl.searchParams.get('username') ?? '').trim().toLowerCase();
  const order = (req.nextUrl.searchParams.get('order') ?? 'by_account_witness').trim();
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 1000) : 1000;
  if (!/^[a-z][a-z0-9.-]{1,15}$/.test(username)) {
    return NextResponse.json({ error: 'username_required' }, { status: 400 });
  }
  try {
    const votes = await getListWitnessVotes(username, limit, order);
    return NextResponse.json(votes, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'witness votes lookup failed for %s', username);
    return NextResponse.json({ error: 'witness_votes_unavailable' }, { status: 502 });
  }
}
