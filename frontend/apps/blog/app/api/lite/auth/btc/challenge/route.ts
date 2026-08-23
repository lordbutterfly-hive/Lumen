import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardBodySize, guardWrite, payloadTooLarge, readBoundedJson } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceChallengeRate } from '@/blog/lib/lite/antispam/rate-limit';
import { createChallenge } from '@/blog/lib/lite/repositories/challenge-repository';
import { loginMessage, isTaproot, addressChallengeHash } from '@/blog/lib/lite/auth/btc-verify';

const logger = getLogger('app');

/**
 * POST /api/lite/auth/btc/challenge  — { address }
 * Issues a single-use login nonce for the wallet to sign (spec §A.4).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;
  // ECON-1-SIBLING (PRUNED 2026-07-22): per-source cap on the upstream funnel.
  if (!(await enforceChallengeRate(getClientIp(req), 'btc'))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // ★ STREAM-BOUNDED, not header-bounded (2026-08-23). This route is reachable with no
  // token and no session, so the caller chooses whether to send `content-length` — and
  // `guardBodySize` trusts it. `readBoundedJson` counts bytes as it reads and cancels past
  // the limit, so an oversized body is never fully buffered.
  const parsed = await readBoundedJson<Record<string, unknown>>(req);
  if (!parsed) return payloadTooLarge();
  const body = parsed.body;
  const address = body?.address;
  if (typeof address !== 'string' || address.trim().length < 8) {
    return NextResponse.json({ error: 'address_required' }, { status: 400 });
  }
  if (isTaproot(address)) {
    return NextResponse.json({ error: 'taproot_unsupported' }, { status: 400 });
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
    logger.error(error, 'Lite BTC challenge issuance failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
