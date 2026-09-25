import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { enforceDmKeyLookupRate } from '@/blog/lib/lite/antispam/rate-limit';
import { findThreadWith, listThreads } from '@/blog/lib/lite/dm/dm-service';

const logger = getLogger('app');

/**
 * GET /api/lite/dm/threads (authed) -> the caller's threads, newest first, each with its
 * last message's ciphertext for a client-decrypted preview.
 *
 * The caller is the session actor; only threads that name the caller's key are returned.
 * The `nonce`/`ciphertext` in every preview are opaque bytes the client decrypts — the
 * server never produces plaintext, so previews are decrypted in the browser too.
 *
 * GET /api/lite/dm/threads?with=<actor> (authed) -> { thread_id } | { thread_id: null }:
 * the caller's own thread with that person, if one exists (`with` takes any form the
 * key lookup does, including a wallet `did:pkh:`). Resolving a name can reach Hive, so
 * it spends the same per-IP bucket as GET /api/lite/dm/keys.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const session = await getLiteSession();
  const withParam = req.nextUrl.searchParams.get('with')?.trim();

  try {
    if (withParam) {
      if (!(await enforceDmKeyLookupRate(getClientIp(req)))) {
        return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
      }
      const found = await findThreadWith(session.user, session, withParam);
      if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
      return NextResponse.json({ thread_id: found.threadId });
    }
    const result = await listThreads(session.user, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ threads: result.threads });
  } catch (error) {
    logger.error(error, 'DM threads lookup failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
