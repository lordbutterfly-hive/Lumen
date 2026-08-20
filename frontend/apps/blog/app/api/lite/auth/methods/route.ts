import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listByUser, unbindMethod } from '@/blog/lib/lite/repositories/credential-repository';
import { parseStepUpProof, verifyStepUpProof } from '@/blog/lib/lite/auth/step-up';

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
 * `stepup` challenge AND A CREDENTIAL PROOF, plus the DB-status gate. The repository
 * REFUSES to remove the account's last credential — a lite account has no password or
 * recovery email, so zero credentials is unrecoverable. Success writes an audit row.
 * Body: { credentialId, stepUp: { method, address, signature | idToken, nonce } }.
 *
 * ★★ THE PROOF WAS MISSING AND THAT WAS AN ACCOUNT TAKEOVER (audit B1, 2026-08-20).
 * This handler consumed a `stepup` nonce and stopped there. A `stepup` nonce proves only
 * that the caller HAS A SESSION — `POST /api/lite/auth/stepup` issues one to any live
 * session — so it is not evidence of key possession. `step-up.ts`'s own docblock says
 * exactly this: "a session thief CANNOT produce a fresh SIGNATURE".
 *
 * The full takeover, from session theft alone and with no key and no Google account:
 *   1. bind YOUR OWN wallet as a second credential (properly signature-gated — you own it)
 *   2. POST /stepup for a nonce (a session is all that is required)
 *   3. DELETE here to remove the VICTIM'S original credential — two remain, so the
 *      last-credential guard does not fire
 *   4. the account now has exactly one credential: yours. The victim has no password and
 *      no recovery email. They are locked out permanently.
 *
 * `verifyStepUpProof` is the same helper `app/api/account/upgrade/route.ts` already uses,
 * and it consumes the challenge itself, so the manual `consumeChallenge` is gone rather
 * than duplicated.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const session = await getLiteSession();
  const actor = await requireActiveLiteUser(session.user, session);
  if (!actor.ok) return actor.response;
  const user = actor.user;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const credentialId = body?.credentialId;
  if (typeof credentialId !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Prove possession of a credential this account owns — not merely possession
  // of a session. See the takeover written out above.
  const proof = parseStepUpProof(body?.stepUp);
  if (!proof) {
    return NextResponse.json(
      {
        error: 'step_up_required',
        message: 'Confirm with the wallet or Google account you signed in with before removing a sign-in method.'
      },
      { status: 401 }
    );
  }
  const verdict = await verifyStepUpProof(user.userId, proof);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.code }, { status: verdict.status });
  }

  // ★ AND IT MUST NOT BE THE CREDENTIAL BEING REMOVED. Proving control of the
  // credential you are deleting is circular: an attacker who bound their own
  // wallet could sign with THAT to remove the victim's. The proof has to come
  // from a credential that SURVIVES the removal.
  if (verdict.credentialId === credentialId) {
    return NextResponse.json(
      {
        error: 'step_up_other_credential_required',
        message: 'Confirm with a different sign-in method than the one you are removing.'
      },
      { status: 400 }
    );
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
