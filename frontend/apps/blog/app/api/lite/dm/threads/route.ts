import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listThreads } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * GET /api/lite/dm/threads (authed) -> the caller's threads, newest first, each with its
 * last message's ciphertext for a client-decrypted preview.
 *
 * The caller is the session actor; only threads that name the caller's key are returned.
 * The `nonce`/`ciphertext` in every preview are opaque bytes the client decrypts — the
 * server never produces plaintext, so previews are decrypted in the browser too.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();

  try {
    const result = await listThreads(session.user, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ threads: result.threads });
  } catch (error) {
    logger.error(error, 'DM threads lookup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
