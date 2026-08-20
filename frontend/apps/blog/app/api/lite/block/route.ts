import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardWrite, guardBodySize } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { blockByName } from '@/blog/lib/lite/social/block-service';
import { isBlockTargetKind } from '@/blog/lib/lite/social/block-actor';

const logger = getLogger('app');

/**
 * POST /api/lite/block — { targetName, targetKind? }.
 *
 * Open to BOTH session kinds, and to every combination of the two: unlike a follow,
 * a block between two full Hive accounts still belongs here, because the chain has
 * no way to express "hide this person's replies under my post from everyone".
 * `social/block-service.ts` carries the full reasoning for keeping it Lumen-local.
 *
 * `targetKind` says WHICH NAME-SPACE the name came from — `'hive'` for a chain-signed
 * byline, `'lumen'` for a Lumen handle. It matters: a Lumen handle is by construction
 * a name that was free on Hive, so the same spelling can be two different people, and
 * blocking the wrong one would delete an innocent third party's comments from a page.
 * Omitted, it falls back to the follow graph's Lumen-first guess.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const session = await getLiteSession();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const targetName = body?.targetName;
  if (typeof targetName !== 'string') {
    return NextResponse.json({ error: 'targetName_required' }, { status: 400 });
  }
  const kind = isBlockTargetKind(body?.targetKind) ? body.targetKind : 'auto';

  try {
    const result = await blockByName(session.user, targetName, kind, session);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, blocking: true, created: result.changed });
  } catch (error) {
    logger.error(error, 'Lumen block failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
