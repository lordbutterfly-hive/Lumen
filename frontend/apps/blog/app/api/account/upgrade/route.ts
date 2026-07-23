import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { upgradeToFullAccount } from '@/blog/lib/lite/upgrade/upgrade-service';

const logger = getLogger('app');

/**
 * POST /api/account/upgrade — { newName }
 * Upgrades the signed-in lite account to a real Hive account. On success the
 * generated keys are returned ONCE (reveal-once custody) and never stored
 * server-side; the client is responsible for custody from here.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const newName = body?.newName;
  if (typeof newName !== 'string') {
    return NextResponse.json({ error: 'newName_required' }, { status: 400 });
  }

  try {
    const result = await upgradeToFullAccount(session.user, newName);
    if (result.status === 'error') {
      const status =
        result.code === 'unauthorized'
          ? 401
          : result.code === 'unavailable'
            ? 503
            : result.code === 'already_upgraded'
              ? 409
              : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite account upgrade failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
