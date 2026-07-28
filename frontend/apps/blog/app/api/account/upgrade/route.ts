import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { enforceUpgradeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { upgradeStatus, upgradeToFullAccount } from '@/blog/lib/lite/upgrade/upgrade-service';
import { ensureAccountCreator } from '@/blog/lib/lite/upgrade/hive-account-creator';

const logger = getLogger('app');

/**
 * POST /api/account/upgrade — { newName, publicKeys: { owner, active, posting, memo } }
 *
 * Upgrades the signed-in lite account to a real Hive account. The browser generated
 * the keys and the user has already saved them; only the four PUBLIC keys arrive here,
 * and the response carries no key material of any kind. Nothing on this side of the
 * wire ever holds a secret that could open the account.
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
  // Each attempt that reaches the creator can trigger an on-chain token claim, which
  // spends the creator account's resource credits. The per-user advisory lock
  // serialises attempts but does not bound how many a user may make.
  if (session.user?.userId && !(await enforceUpgradeRate(session.user.userId))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const newName = body?.newName;
  if (typeof newName !== 'string') {
    return NextResponse.json({ error: 'newName_required' }, { status: 400 });
  }

  try {
    const result = await upgradeToFullAccount(session.user, newName, body?.publicKeys);
    if (result.status === 'error') {
      const status =
        result.code === 'unauthorized'
          ? 401
          : result.code === 'unavailable'
            ? 503
            : result.code === 'already_upgraded'
              ? 409
              : result.code === 'reconcile_unavailable'
                ? 503
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

/**
 * GET /api/account/upgrade — where does this account actually stand?
 *
 * Called before the upgrade screen offers to create anything. It settles any attempt
 * left in flight (a create that landed but was never recorded here) using the PUBLIC
 * owner key, so the answer is authoritative without any secret being involved.
 *
 * Without it, a user whose previous attempt succeeded but whose response was lost
 * would be shown a freshly generated set of keys for an account that already exists —
 * keys that open nothing, presented as theirs. That is the one outcome this whole
 * design exists to prevent.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  // Deliberately guarded like a write. This GET reconciles state — it can conclude an
  // attempt is dead and free the name — and session cookies are SameSite=Lax, which
  // still travel on a cross-site top-level navigation. Requiring a custom header makes
  // it unreachable from another origin without a CORS preflight we never grant.
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }

  const session = await getLiteSession();
  if (session.user?.userId && !(await enforceUpgradeRate(session.user.userId))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  ensureAccountCreator();
  try {
    const state = await upgradeStatus(session.user);
    return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logger.error(error, 'Lite upgrade status failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
