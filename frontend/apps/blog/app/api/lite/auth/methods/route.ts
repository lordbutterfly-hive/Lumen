import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listByUser, unbindMethod } from '@/blog/lib/lite/repositories/credential-repository';
import { consumeChallenge } from '@/blog/lib/lite/repositories/challenge-repository';

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
  // F-L2: reads are exactly where a banned/suspended session must be blocked — this
  // endpoint enumerates the account's linked sign-in methods (a surveillance surface,
  // F-L17). requireActiveLiteUser (NOT requireLiteUser, which lets suspended through)
  // gates on the DB status + the F-L3 epoch.
  const actor = await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

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

/**
 * DELETE /api/lite/auth/methods — unbind a linked sign-in method (F-L2).
 *
 * Removing a credential is as sensitive as adding one, so it demands a fresh, user-bound
 * `stepup` challenge (not a plain login nonce) and the DB-status gate. The repository
 * REFUSES to remove the account's last credential — a lite account has no password or
 * recovery email, so zero credentials is unrecoverable. Success writes an audit row.
 * Body: { credentialId, nonce }.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const actor = await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const credentialId = body?.credentialId;
  const nonce = body?.nonce;
  if (typeof credentialId !== 'string' || typeof nonce !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const consumed = await consumeChallenge(nonce, 'stepup');
  if (!consumed || consumed.userId !== user.userId) {
    return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 401 });
  }

  try {
    const res = await unbindMethod(user.userId, credentialId);
    if (res === 'last_credential') {
      return NextResponse.json({ error: 'last_credential' }, { status: 409 });
    }
    if (res === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error(error, 'Lite auth method unbind failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
