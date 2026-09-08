import { NextRequest, NextResponse } from 'next/server';

import { getGoogleDriveOAuth2Client } from '../client';
import { getLogger } from '@ui/lib/logging';
import { guardBodySize, payloadTooLarge, readBoundedBody } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';

const logger = getLogger('google-drive-auth');

/**
 * ★ FIX-DOS, 2026-09-08 (API-01). This route had NO rate limit of any kind, and no
 * session/CSRF gate either — fully public, unauthenticated. Measured: 30 consecutive
 * real POSTs (garbage code, unconfigured deploy), none ever 429. In-process only (no
 * new Postgres dependency for a route that has never depended on the lite backend),
 * matching the same `consumeLocalGlobal`/`consumeLocalPerIp` pair
 * `app/api/creator-tokens/{gql,submit}` already use for the identical class of
 * problem. Sized tightly: a real caller exchanges an OAuth code once per Google
 * Drive connect action, not repeatedly.
 */
const GOOGLE_DRIVE_AUTH_PER_IP_PER_MIN = 20;
const GOOGLE_DRIVE_AUTH_GLOBAL_PER_MIN = 500;

/**
 * Proxy endpoint for google drive authentication
 * Usage: POST /api/google-drive/auth
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req);
  if (!consumeLocalGlobal('google_drive_auth', GOOGLE_DRIVE_AUTH_GLOBAL_PER_MIN)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!consumeLocalPerIp(ip, 'google_drive_auth', GOOGLE_DRIVE_AUTH_PER_IP_PER_MIN)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  try {
    // ★ STREAM-BOUNDED, not header-bounded (2026-08-23). Unauthenticated route: the caller
    // chooses whether to send `content-length`, and `guardBodySize` trusts it. Reading
    // through `readBoundedBody` counts bytes and cancels past the limit, and parsing from
    // the returned string keeps this route's existing behaviour on malformed input exactly.
    const raw = await readBoundedBody(req);
    if (raw === null) return payloadTooLarge();
    let body: Record<string, unknown> = {};
    try {
      body = (JSON.parse(raw) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const code = body['code'];

    if (!code || typeof code !== 'string') {
      logger.debug('Received invalid Google Drive code format');
      return new NextResponse(null, { status: 400 });
    }

    // If the client signals redirect mode was used, construct the callback
    // URI from request headers instead of accepting a client-provided value
    let callbackUri: string | undefined;
    if (body['redirectUri']) {
      const host = req.headers.get('host');
      const proto = req.headers.get('x-forwarded-proto') || 'https';
      callbackUri = `${proto}://${host}/api/google-drive/callback`;
    }

    const oauth2Client = getGoogleDriveOAuth2Client(callbackUri);

    // Exchange authorization code for access and refresh tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Tokens consists of: access_token, refresh_token (only on first login), scope, expiry_date
    oauth2Client.setCredentials(tokens);

    return NextResponse.json({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, // May be undefined if the user logged in before and did not revoke consent
    }, { status: 200 });
  } catch (error) {
    logger.error('Error exchanging code for tokens: %s', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
