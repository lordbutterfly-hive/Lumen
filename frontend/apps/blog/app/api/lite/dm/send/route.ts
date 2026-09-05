import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
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

  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
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
