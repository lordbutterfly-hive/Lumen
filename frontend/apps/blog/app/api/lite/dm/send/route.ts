import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedJson, payloadTooLarge } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { sendMessage } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * POST /api/lite/dm/send
 *   { recipientActor, nonce, ciphertext, senderKeyVersion, recipientKeyVersion }
 *
 * ★★★ THE SERVER STORES CIPHERTEXT, NEVER PLAINTEXT. `nonce` and `ciphertext` are
 * base64 of opaque bytes the browser produced (XChaCha20-Poly1305); this route hands
 * them to the service, which stores them verbatim and never decodes them.
 *
 * The SENDER is the session actor — `sendMessage` derives it from the cookie and never
 * trusts a client-asserted sender. The service resolves the recipient, rejects self-DM,
 * enforces the block graph both ways, rate-limits (new-thread stricter than reply),
 * upserts the sorted-pair thread ('request' for a stranger's first message, else
 * 'open') and inserts the row. Open to both account tiers, like follow/block.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  // ★ STREAM-BOUNDED, NOT HEADER-BOUNDED (FIX-DOS, 2026-09-08 — AUTH-02). See
  // lib/lite/http/guard.ts's readBoundedJson doc: guardWrite only checks that a
  // CSRF header is PRESENT, not an identity, so an unauthenticated caller reaches
  // this parse — guardBodySize's caller-optional content-length let a chunked
  // body bypass it and be buffered whole. readBoundedJson counts bytes as it
  // reads and refuses (413) before that happens.
  const session = await getLiteSession();
  const parsed = await readBoundedJson(req);
  if (parsed === null) return payloadTooLarge();
  const body = parsed.body;
  if (!body) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const result = await sendMessage(session.user, session, {
      recipientActor: body.recipientActor,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      senderKeyVersion: body.senderKeyVersion,
      recipientKeyVersion: body.recipientKeyVersion
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      ok: true,
      thread_id: result.threadId,
      status: result.status,
      message_id: result.messageId,
      created_at: result.createdAt
    });
  } catch (error) {
    // ★ Log the failure, NEVER the body — the body carries ciphertext, and a log is a
    // place it must never land.
    logger.error(error, 'DM send failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
