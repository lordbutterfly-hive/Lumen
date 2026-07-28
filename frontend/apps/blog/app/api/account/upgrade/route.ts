import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { upgradeToFullAccount } from '@/blog/lib/lite/upgrade/upgrade-service';
import { ensureAccountCreator } from '@/blog/lib/lite/upgrade/hive-account-creator';

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

  // Dev convenience: wire the env-var active-key signer if one is configured, the
  // same lazy-install the publisher drain does. In production this is a no-op unless
  // a KMS-backed creator was already injected at boot. Failures are logged, not
  // returned — `upgradeToFullAccount` deliberately reports "not configured" only
  // after it has reported a suspended account, and short-circuiting here would
  // replace that honest answer with a generic 503.
  ensureAccountCreator();

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
              : // Suspended/banned: the session is valid, the account is not permitted.
                result.code.startsWith('account_')
                ? 403
                : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite account upgrade failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
