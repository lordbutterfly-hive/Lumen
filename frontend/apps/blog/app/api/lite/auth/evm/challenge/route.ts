import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { createChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { loginMessage, isEvmAddress, addressChallengeHash } from '@/blog/lib/lite/auth/evm-verify';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/evm/challenge  — { address }
 * Issues a single-use login nonce for an EVM wallet to sign with personal_sign.
 * Mirrors the BTC challenge route, including its rate limit and address binding.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  // ECON-1-SIBLING (PRUNED 2026-07-22): per-source cap on the upstream funnel.
  if (!(await enforceChallengeRate(getClientIp(req), 'evm'))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const address = body?.address;
  if (typeof address !== 'string' || !isEvmAddress(address)) {
    return NextResponse.json({ error: 'address_required' }, { status: 400 });
  }

  try {
    // SEQ-1 (PRUNED 2026-07-22): bind the login challenge to this address so a
    // challenge issued for one address cannot be consumed with a different one.
    const challenge = await createChallenge({
      purpose: 'login',
      ttlSeconds: 300,
      payloadHash: addressChallengeHash(address)
    });
    return NextResponse.json({ nonce: challenge.nonce, message: loginMessage(challenge.nonce) });
  } catch (error) {
    logger.error(error, 'Lite EVM challenge issuance failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
