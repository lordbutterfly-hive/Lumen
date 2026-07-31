import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { getLiteSession, destroyLiteSession } from '@/blog/lib/lite/http/session';
import { bumpSessionEpoch } from '@/blog/lib/lite/repositories/user-repository';

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
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    await bumpSessionEpoch(user.userId);
    await destroyLiteSession();
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite logout-all failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
