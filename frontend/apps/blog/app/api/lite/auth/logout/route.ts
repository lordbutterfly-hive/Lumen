import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { hasCsrfHeader } from '@/blog/lib/lite/http/csrf';
import { destroyLiteSession } from '@/blog/lib/lite/http/session';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/logout — destroy the current session. Works regardless of
 * the feature flag so a stale session can always be cleared; CSRF header required.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  try {
    await destroyLiteSession();
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite logout failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
