import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';
import { walletDids } from '@/blog/lib/lite/wallet/did-pkh';

const logger = getLogger('app');

/**
 * GET /api/lite/wallet/dids — the Magi account identifiers for the signed-in lite
 * user's bound wallets.
 *
 * This is the seam between lite accounts and anything token-related: a wallet is a
 * first-class Magi account (`did:pkh`), so token balances are looked up per wallet.
 * Returned as a LIST, never merged into one number — balances live under whichever
 * wallet holds them, and binding a second wallet does not move anything.
 *
 * Identity only. Spending needs a signature over a real Magi transaction, which is
 * a different payload from our login proof and is deliberately not offered here.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const credentials = await listByUser(user.userId);
    const wallets = walletDids(credentials);
    return NextResponse.json({
      wallets,
      // Explicit so a caller never has to infer it from an empty list: a Google-only
      // account has no key behind it and cannot hold tokens until a wallet is bound.
      canHoldTokens: wallets.length > 0
    });
  } catch (error) {
    logger.error(error, 'Lite wallet DID lookup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
