import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { getLiteSession, destroyLiteSession } from '@/blog/lib/lite/http/session';
import { requireLiteUser } from '@/blog/lib/lite/http/actor';
import { bumpSessionEpoch } from '@/blog/lib/lite/repositories/user-repository';
import { forgetRevocations } from '@/blog/lib/lite/repositories/session-revocation-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/logout-all — sign out EVERY device (F-L3).
 *
 * Advances the account's `session_epoch`, which every acting request re-reads
 * (checkLiteActorById); every cookie stamped with the old epoch is refused on its
 * next use. The caller's own cookie is destroyed here too, so this device is signed
 * out immediately rather than on its next acting request. Works regardless of the
 * feature flag so a user who suspects a compromise can always lock the account down;
 * CSRF header required.
 *
 * ★★★ 2026-08-10 — THIS ROUTE HAD THE SAME LOCKOUT WEAPON AS `/logout`, AND THE
 * AUDIT DID NOT NAME IT. It checked only that the cookie CLAIMED a lite userId, so
 * a stale cookie — one already refused by every ordinary route — got 200 here and
 * advanced the epoch. Measured before this fix: `{"status":"ok"}`, epoch 2 -> 3,
 * from a cookie that `/api/lite/profile` had just answered 401. That is the whole
 * attack: capture once, replay after every re-authentication, lock the account out
 * forever. `requireLiteUser` closes it — the same gate every other acting route
 * uses, on the route whose entire job is revocation.
 *
 * `requireLiteUser` rather than `requireActiveLiteUser` on purpose: a SUSPENDED
 * account must still be able to lock itself down. Status is not the question here;
 * whether the cookie is still a live session is.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  const session = await getLiteSession();
  const actor = await requireLiteUser(session.user, session);
  if (!actor.ok) return actor.response;

  try {
    await bumpSessionEpoch(actor.user.userId);
    // The new epoch already refuses every outstanding cookie, so the per-device
    // rows can no longer refuse anything. Dropping them keeps the table to its
    // real working set. Janitorial only — never the revocation itself, which is
    // why it runs AFTER the bump and its failure cannot leave a session alive.
    await forgetRevocations(actor.user.userId);
    await destroyLiteSession();
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite logout-all failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
