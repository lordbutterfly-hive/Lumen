import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardModerator } from '@/blog/lib/lite/http/guard';
import { listActions } from '@/blog/lib/lite/moderation/moderation-service';
import { ModerationTargetType } from '@/blog/lib/lite/repositories/moderation-repository';

const logger = getLogger('app');

/**
 * GET /api/lite/moderation/actions — the moderation log.
 *
 * Read side of the trail: what was done, to whom, by which operator label, and why.
 * Filterable by target so an appeal ("why was my account suspended?") is one query.
 *
 * Query: ?limit=&before=&targetType=user|post&targetId=
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardModerator(req);
  if (blocked) return blocked;

  const params = req.nextUrl.searchParams;
  const targetType = params.get('targetType');

  try {
    const actions = await listActions({
      limit: Number(params.get('limit')) || 50,
      before: params.get('before') ?? undefined,
      targetType:
        targetType === 'user' || targetType === 'post' ? (targetType as ModerationTargetType) : undefined,
      targetId: params.get('targetId') ?? undefined
    });
    return NextResponse.json({
      status: 'ok',
      actions,
      // Keyset cursor: pass back as `before` for the next page.
      nextBefore: actions.length ? actions[actions.length - 1].actionId : null
    });
  } catch (error) {
    logger.error(error, 'Moderation (actions) failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
