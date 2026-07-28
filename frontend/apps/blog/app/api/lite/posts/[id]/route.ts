import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead, guardWrite } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { deleteLitePost, getLitePost } from '@/blog/lib/lite/content/post-service';
import { liteEntryForPost } from '@/blog/lib/lite/render/lite-entry';

const logger = getLogger('app');

/** GET /api/lite/posts/:id — single post detail, DB-sourced (§E.1). */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  try {
    const post = await getLitePost(params.id);
    if (!post || post.deletedLocally || post.feedVisibility === 'hidden') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    // Overlaid entry, not the raw row: a published post's body lives on chain
    // (pruneBodyAfterPublish drops our copy), and the identity overlay is applied
    // there too.
    //
    // Feed cards call this endpoint once per lite post (client/use-lite-overlay.ts),
    // and resolving the author's CURRENT name costs one extra primary-key lookup on
    // top of the post read. Accepted deliberately: it sits next to a remote call to a
    // Hive node, which dominates this request by orders of magnitude, and the client
    // caches the result per post id. Batching it would mean a second endpoint shape
    // for a few hundred microseconds.
    const entry = await liteEntryForPost(post);
    if (!entry) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ entry, post });
  } catch (error) {
    logger.error(error, 'Lite post fetch failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * DELETE /api/lite/posts/:id — the post owner removes their post.
 *
 * Hides it from Lumen immediately, then queues the on-chain removal. Hive only
 * allows a true delete while a comment has no replies, no net-positive votes and
 * has not paid out (hive_evaluator_social.cpp:60,66,68-69); the worker falls back to
 * blanking the content when that is refused, so "delete" always succeeds from the
 * user's point of view.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const session = await getLiteSession();
  const user = session.user;
  if (!user?.userId || user.account_tier !== 'lite') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await deleteLitePost(user.userId, params.id);
    if (result.status === 'error') {
      return NextResponse.json(
        { error: result.code, message: result.message },
        { status: result.code === 'not_found' ? 404 : 400 }
      );
    }
    return NextResponse.json({ status: 'ok', onChain: result.onChain });
  } catch (error) {
    logger.error(error, 'Lite post delete failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
