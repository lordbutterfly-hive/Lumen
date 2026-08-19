import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
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
  // F-L2/F-L17: this exposes the account's full cross-wallet linkage (every bound
  // DID) — a banned/suspended/revoked session must be refused, so gate on the DB
  // status + F-L3 epoch, not a bare cookie presence check.
  /**
   * ★★★ `allowUpgraded: true` (2026-08-19). Without it this route 403s
   * `account_upgraded` the moment a user creates a Hive account - and because
   * `/api/users/me` serves `account_tier` straight from the iron-session cookie with no
   * DB read, that cookie still says `lite` for its full 14-day life. So the client keeps
   * calling this route, keeps getting 403, and the tokens page shows "We couldn't check
   * your wallet just now. Try reloading the page." - a transient-sounding error that
   * could never resolve, for up to two weeks.
   *
   * The exemption is the right one on the merits, not just a workaround: the default
   * FALSE exists to stop an upgraded user ACTING through the shared publishing account.
   * This route acts on nothing. It reads back which wallet credentials the user still
   * owns - Lumen-local identity data, no on-chain equivalent, exactly the class the
   * exemption was written for. Their wallet did not stop being theirs.
   */
  const actor = await requireActiveLiteUser(session.user, session, { allowUpgraded: true });
  if (!actor.ok) return actor.response;
  const user = actor.user;

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
