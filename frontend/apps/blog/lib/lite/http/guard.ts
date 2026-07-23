import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { liteConfig } from '../config';
import { hasCsrfHeader } from './csrf';

/** Constant-time string compare (avoids a timing side-channel on the token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Preconditions shared by every lite route. Returns a ready NextResponse to
 * short-circuit with, or null to proceed.
 *
 * The feature stays dark (503) until infra is provisioned + the flag is set —
 * so merging this code cannot expose an unfinished backend by accident.
 */

function disabledResponse(): NextResponse {
  return NextResponse.json({ error: 'lite_accounts_disabled' }, { status: 503 });
}

/** For mutating routes (POST): enabled + CSRF header. */
export function guardWrite(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  if (!hasCsrfHeader(req)) {
    return NextResponse.json({ error: 'missing_csrf_header' }, { status: 403 });
  }
  return null;
}

/** For read-only routes (GET): enabled only. */
export function guardRead(): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  return null;
}

/** For recsys ingestion routes: enabled + a valid shared token (constant-time). */
export function guardRecsys(req: NextRequest): NextResponse | null {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return disabledResponse();
  const token = req.headers.get('x-lite-recsys-token') ?? '';
  if (!liteConfig.recsysToken || !safeEqual(token, liteConfig.recsysToken)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
