import { NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listByUser } from '@/blog/lib/lite/repositories/credential-repository';

const logger = getLogger('app');

/**
 * GET /api/lite/auth/methods — which sign-in methods are linked to this account.
 *
 * A lite account has no password and no recovery email; the linked credentials ARE the
 * account. Binding a second one has been possible since Phase 2 and was reachable by
 * nobody, so every lite user has been one lost phone or one revoked Google account away
 * from losing everything they have written, with no warning anywhere in the product.
 * This is what the security screen reads to say so.
 *
 * Deliberately returns no `externalRef`: a Google `sub`, a Bitcoin address and an EVM
 * address are all linkable identifiers, and this endpoint's only job is to answer "what
 * can I sign in with, and is it more than one?". A truncated hint is enough to tell two
 * wallets apart in a list.
 */

/** Enough to distinguish two bound wallets, far too little to identify one. */
function hint(method: string, externalRef: string): string | null {
  if (method === 'google_passkey') return null; // an opaque `sub` tells the user nothing
  if (externalRef.length <= 10) return externalRef;
  return `${externalRef.slice(0, 6)}…${externalRef.slice(-4)}`;
}

export async function GET(): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const credentials = await listByUser(user.userId);
    return NextResponse.json({
      methods: credentials.map((c) => ({
        credentialId: c.credentialId,
        method: c.method,
        network: c.network,
        hint: hint(c.method, c.externalRef),
        isPrimary: c.isPrimary,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt ?? null
      })),
      /** The whole reason this screen exists: one credential is a single point of loss. */
      atRisk: credentials.length < 2
    });
  } catch (error) {
    logger.error(error, 'Lite auth methods listing failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
