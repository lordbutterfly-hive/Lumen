import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { getLiteSession, destroyLiteSession } from '@/blog/lib/lite/http/session';
import { bumpSessionEpoch } from '@/blog/lib/lite/repositories/user-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/logout — destroy the current session. Works regardless of
 * the feature flag so a stale session can always be cleared; CSRF header required.
 *
 * ★★★ QA 2026-08-06 — THIS NOW SIGNS OUT EVERY DEVICE, DELIBERATELY.
 *
 * It used to clear the browser cookie and nothing else, so a COPY of that cookie
 * captured beforehand stayed fully valid: replaying it after a 200 OK logout
 * returned the account's private data. Logout was a security control that
 * controlled nothing.
 *
 * There is no per-session identifier to revoke — the session is an encrypted
 * cookie carrying a per-USER `session_epoch`, so the only server-side revocation
 * available is to advance that epoch, which invalidates every device at once.
 *
 * THE TRADE, ACCEPTED BY THE OWNER 2026-08-06: logging out on your phone also
 * signs out your laptop. Per-device logout would need a session id plus a
 * revocation store — a real build, deliberately not done for launch. If that
 * lands later, this route should revoke only its own session id and
 * `logout-all` keeps the epoch bump.
 *
 * A missing/expired session is still cleared silently rather than 401'd (unlike
 * `logout-all`), so a stale cookie can always be got rid of.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  try {
    // Bump BEFORE destroying: once the cookie is gone we no longer know who to
    // revoke. A non-lite or absent session skips the bump and just gets cleared.
    const session = await getLiteSession();
    const user = session.user;
    if (user?.userId && user.account_tier === 'lite') {
      await bumpSessionEpoch(user.userId);
    }
    await destroyLiteSession();
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite logout failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
