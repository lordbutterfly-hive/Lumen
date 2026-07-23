import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRecsys } from '@/blog/lib/lite/http/guard';
import { listFollowEdges } from '@/blog/lib/lite/recsys/resolver';

const logger = getLogger('app');

/**
 * GET /api/lite/recsys/follow-edges?after=<seq>&limit= — the off-chain follow
 * graph over user_id, cursor-paginated by `seq`. Token-guarded.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRecsys(req);
  if (blocked) return blocked;

  const afterParam = Number(req.nextUrl.searchParams.get('after') ?? '0');
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? '500');
  // FOLLOW-RECSYS-3 (PRUNED 2026-07-22): clamp both — a negative/NaN value passed
  // the old finite-only check and reached Postgres as a negative LIMIT (→ 500).
  const after = Number.isFinite(afterParam) ? Math.max(Math.trunc(afterParam), 0) : 0;
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 1000) : 500;

  try {
    const edges = await listFollowEdges(after, limit);
    const nextCursor = edges.length ? edges[edges.length - 1].seq : after;
    return NextResponse.json({ edges, nextCursor });
  } catch (error) {
    logger.error(error, 'recsys follow-edges failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
