import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedJson, payloadTooLarge } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { followByName } from '@/blog/lib/lite/social/follow-service';

const logger = getLogger('app');

/**
 * POST /api/lite/follow — { followeeName }.
 *
 * Open to BOTH session kinds. A lite account has no key to sign a chain follow, and
 * it also cannot BE followed on chain because there is no account there to follow —
 * so a Hive user following a lite user lands here too. Only Hive-to-Hive follows are
 * refused; those belong on chain. Rate-limited per actor (§H).
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
  const followeeName = body?.followeeName;
  if (typeof followeeName !== 'string') {
    return NextResponse.json({ error: 'followeeName_required' }, { status: 400 });
  }

  try {
    const result = await followByName(session.user, followeeName, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, following: true, created: result.changed });
  } catch (error) {
    logger.error(error, 'Lite follow failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
