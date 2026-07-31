import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { createChallenge } from '@/blog/lib/lite/repositories/challenge-repository';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/google/challenge — issue a single-use, server-issued `login`
 * nonce for the Google OIDC flow (F-L11).
 *
 * The BTC/EVM login paths already consume a server nonce; Google did not, so a captured
 * Google ID token was replayable for its whole ~1h validity. The client passes this
 * nonce as the OIDC `nonce` when requesting the ID token; google/verify then requires the
 * token to echo it AND consumes the nonce (single-use), so a replay presents a spent
 * nonce and is refused. Anonymous / pre-session (no address to bind, unlike BTC), so no
 * payload hash — the binding comes from Google echoing the nonce back inside the token.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  if (!(await enforceChallengeRate(getClientIp(req), 'google'))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  try {
    const challenge = await createChallenge({ purpose: 'login', ttlSeconds: 300 });
    return NextResponse.json({ nonce: challenge.nonce });
  } catch (error) {
    logger.error(error, 'Lite Google challenge issuance failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
