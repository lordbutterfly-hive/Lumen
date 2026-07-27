import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { verifyBtcSignature, loginMessage, btcNetwork, isTaproot, addressChallengeHash, normalizeBtcAddress } from '@/blog/lib/lite/auth/btc-verify';
import { btcKeyFingerprint } from '@/blog/lib/lite/auth/btc-key-fingerprint';
import { resolveLogin } from '@/blog/lib/lite/auth/auth-service';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/btc/verify  — { address, signature, nonce }
 * Consumes the nonce (single-use), verifies the BIP-137/BIP-322 signature over
 * the login message, then resolves to a session or `needs_name`.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  // ECON-1-SIBLING (PRUNED 2026-07-22): per-source cap on the upstream funnel.
  if (!(await enforceChallengeRate(getClientIp(req), 'btc'))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const address = body?.address;
  const signature = body?.signature;
  const nonce = body?.nonce;
  if (typeof address !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (isTaproot(address)) {
    return NextResponse.json({ error: 'taproot_unsupported' }, { status: 400 });
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
    const ok = verifyBtcSignature({ address, message: loginMessage(nonce), signatureBase64: signature });
    if (!ok) {
      return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
    }
    // Fingerprint the KEY, not the address: one key has three address encodings and
    // would otherwise be able to register three accounts.
    const result = await resolveLogin('btc_wallet', normalizeBtcAddress(address), {
      network: btcNetwork(address),
      keyFingerprint: btcKeyFingerprint(loginMessage(nonce), signature) ?? undefined
    });
    return NextResponse.json(result);
  } catch (error) {
    logger.error(error, 'Lite BTC login verification failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
