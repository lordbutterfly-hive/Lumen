import { NextRequest, NextResponse } from 'next/server';

import { getGoogleDriveOAuth2Client } from '../client';
import { getLogger } from '@ui/lib/logging';
import { guardBodySize, payloadTooLarge, readBoundedBody } from '@/blog/lib/lite/http/guard';

const logger = getLogger('google-drive-auth');

/**
 * Proxy endpoint for exchanging Google Drive refresh token to new access token
 * Usage: POST /api/google-drive/refresh
 */
export async function POST(req: NextRequest): Promise<NextResponse> {

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

    const refreshToken = body['refreshToken'];

    if (!refreshToken || typeof refreshToken !== 'string') {
      logger.debug('Received invalid Google Drive refresh token format');
      return new NextResponse(null, { status: 400 });
    }

    const oauth2Client = getGoogleDriveOAuth2Client();

    // Exchange authorization code for access and refresh tokens
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await oauth2Client.refreshAccessToken();

    return NextResponse.json({
      accessToken: credentials.access_token
    }, { status: 200 });
  } catch (error) {
    logger.error('Error refreshing Google Drive access token: %s', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
