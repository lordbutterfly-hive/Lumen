import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getWitnessesByVote } from '@transaction/lib/hive';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/witnesses/hooks/use-witnesses-
 * data.ts` called `getChain()`/`getWitnessesByVote` directly, with NO
 * `enabled` guard, on `/witnesses` — a page with no sign-in wall at all. Every
 * visitor, anonymous or signed in, downloaded `wax.common.wasm` just to view
 * a read-only witness table.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 200) : 100;
  try {
    const witnesses = await getWitnessesByVote(limit);
    return NextResponse.json(witnesses, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'witnesses lookup failed');
    return NextResponse.json({ error: 'witnesses_unavailable' }, { status: 502 });
  }
}
