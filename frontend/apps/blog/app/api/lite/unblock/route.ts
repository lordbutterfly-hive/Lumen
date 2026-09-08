import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, readBoundedJson, payloadTooLarge } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { unblockByName } from '@/blog/lib/lite/social/block-service';
import { isBlockTargetKind } from '@/blog/lib/lite/social/block-actor';

const logger = getLogger('app');

/**
 * POST /api/lite/unblock — { targetName, targetKind? }. Mirror of the block route.
 *
 * The edge is TOMBSTONED rather than deleted (see migration 0030), so an unblock is
 * an observable event rather than the silent disappearance of a row.
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
  const targetName = body?.targetName;
  if (typeof targetName !== 'string') {
    return NextResponse.json({ error: 'targetName_required' }, { status: 400 });
  }
  const kind = isBlockTargetKind(body?.targetKind) ? body.targetKind : 'auto';

  try {
    const result = await unblockByName(session.user, targetName, kind, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, blocking: false });
  } catch (error) {
    logger.error(error, 'Lumen unblock failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
