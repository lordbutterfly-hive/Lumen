import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { createChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { bindMessage } from '@/blog/lib/lite/auth/btc-verify';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/stepup — issue a fresh, single-use STEP-UP nonce bound to
 * the signed-in lite user, required before linking a SECOND auth method
 * (SEQ-1 / XC-2, PRUNED 2026-07-22). A BTC bind signs `message`; a Google bind
 * passes `nonce` as the Google sign-in nonce (later checked against the ID
 * token's `nonce` claim). Because the challenge purpose is 'stepup' and it is
 * user-bound, a plain login nonce (purpose 'login') can never be replayed into
 * /bind, and an attacker cannot pre-bind a victim's identity without our nonce.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const challenge = await createChallenge({
      purpose: 'stepup',
      userId: user.userId,
      ttlSeconds: 300
    });
    return NextResponse.json({ nonce: challenge.nonce, message: bindMessage(challenge.nonce) });
  } catch (error) {
    logger.error(error, 'Lite step-up challenge issuance failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
