import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { enforceUpgradeRate } from '@/blog/lib/lite/antispam/rate-limit';
import * as upgradeEvents from '@/blog/lib/lite/repositories/upgrade-event-repository';
import { parseStepUpProof, verifyStepUpProof } from '@/blog/lib/lite/auth/step-up';

/**
 * The cap protects the creator account's Resource Credits, which only a NEW creation
 * spends. Reconciling an attempt that is already in flight spends nothing but two chain
 * reads — and refusing it would strand a user whose Hive account exists but is not yet
 * linked, on the very screen that tells them to reload. So an in-flight attempt is
 * always allowed through.
 */
async function allowUpgradeRequest(userId: string | undefined, inFlight: boolean): Promise<boolean> {
  if (!userId) return true;
  if (inFlight) return true;
  return enforceUpgradeRate(userId);
}
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireSessionOwner } from '@/blog/lib/lite/http/actor';
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
  const userId = session.user?.userId;
  // ★ REVOCATION GATE (2026-08-23). This route read the cookie directly, so a session the
  // account holder had explicitly signed out — `logout-all`, or an admin invalidating
  // sessions — could still reach the creator. That matters more here than almost anywhere
  // else in the app: as the comment below says, each attempt that reaches the creator can
  // trigger an on-chain token claim which spends the CREATOR ACCOUNT's resource credits,
  // and a successful run creates a permanent Hive account. So a revoked cookie could spend
  // the operator's resources and mint chain state.
  //
  // Anonymous requests are unchanged: the check only runs when the cookie actually carries
  // a userId, and the handler's existing behaviour for a missing one is left alone.
  if (userId) {
    const actor = await requireSessionOwner(session.user, session);
    if (!actor.ok) return actor.response;
  }
  // An attempt already in flight is a RECONCILIATION, not a new creation: it spends
  // no token and creates nothing. Both gates below let it through for the same
  // reason — refusing it would strand a user whose Hive account exists but is not
  // yet linked, on the very screen telling them to reload.
  const inFlight = userId ? Boolean(await upgradeEvents.findInFlightByUser(userId)) : false;

  // Each attempt that reaches the creator can trigger an on-chain token claim, which
  // spends the creator account's resource credits. The per-user advisory lock
  // serialises attempts but does not bound how many a user may make.
  if (!(await allowUpgradeRequest(userId, inFlight))) {
    return NextResponse.json(
      { status: 'error', code: 'rate_limited', message: 'Too many attempts today — please try again tomorrow.' },
      { status: 429 }
    );
  }

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const newName = body?.newName;
  if (typeof newName !== 'string') {
    return NextResponse.json({ error: 'newName_required' }, { status: 400 });
  }

  // ── F-L1 STEP-UP ─────────────────────────────────────────────────────────
  // Creating the Hive account is irreversible: it burns a creation token, takes a
  // name forever, and flips this row one-way. The spec has always required a fresh
  // credential proof for it (LUMEN-LITE-ACCOUNTS-SPEC-2026-07-22: "Step-up re-auth
  // required only for account-security actions (upgrade, ...)"), and /bind
  // implements exactly that — this route never did, so a stolen 14-day session was
  // sufficient on its own to seize an identity permanently.
  //
  // The proof is a fresh signature from a wallet key (or Google assertion) the
  // ACCOUNT already owns — see auth/step-up.ts for why a bare nonce here would be
  // theatre against this particular threat.
  if (userId && !inFlight) {
    const proof = parseStepUpProof(body?.stepUp);
    if (!proof) {
      return NextResponse.json(
        {
          status: 'error',
          code: 'step_up_required',
          message: 'Confirm with the wallet or Google account you signed up with before creating your Hive account.'
        },
        { status: 401 }
      );
    }
    const verdict = await verifyStepUpProof(userId, proof);
    if (!verdict.ok) {
      return NextResponse.json({ status: 'error', code: verdict.code }, { status: verdict.status });
    }
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
  const statusUserId = session.user?.userId;
  const statusInFlight = statusUserId ? Boolean(await upgradeEvents.findInFlightByUser(statusUserId)) : false;
  if (!(await allowUpgradeRequest(statusUserId, statusInFlight))) {
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
