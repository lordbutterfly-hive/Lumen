import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import {
  verifyEvmSignature,
  loginMessage,
  evmNetwork,
  isEvmAddress,
  normalizeEvmAddress,
  addressChallengeHash
} from '@/blog/lib/lite/auth/evm-verify';
import { resolveLogin } from '@/blog/lib/lite/auth/auth-service';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/evm/verify  — { address, signature, nonce }
 * Consumes the nonce (single-use), verifies the EIP-191 personal_sign signature
 * over the login message, then resolves to a session or `needs_name`.
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
  const signature = body?.signature;
  const nonce = body?.nonce;
  if (typeof address !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: 'invalid_address' }, { status: 400 });
  }

  try {
    // Single-use consume happens BEFORE signature check so a wrong signature
    // still burns the nonce (no oracle for repeated attempts).
    const consumed = await consumeChallenge(nonce, 'login');
    if (!consumed) {
      return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
    }
    // SEQ-1 (PRUNED 2026-07-22): the challenge is bound to a specific address.
    if (consumed.payloadHash !== addressChallengeHash(address)) {
      return NextResponse.json({ error: 'address_mismatch' }, { status: 401 });
    }
    const ok = await verifyEvmSignature({ address, message: loginMessage(nonce), signature });
    if (!ok) {
      return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
    }
    const result = await resolveLogin('evm_wallet', normalizeEvmAddress(address), {
      network: evmNetwork()
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite EVM login verification failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
