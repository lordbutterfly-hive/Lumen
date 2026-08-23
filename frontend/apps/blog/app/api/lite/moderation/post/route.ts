import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardModerator, guardBodySize } from '@/blog/lib/lite/http/guard';
import { moderatePost } from '@/blog/lib/lite/moderation/moderation-service';
import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { FeedVisibility } from '@/blog/lib/lite/types';

const logger = getLogger('app');

const VISIBILITIES: FeedVisibility[] = ['visible', 'author_only', 'hidden'];

/**
 * POST /api/lite/moderation/post — set a post's Lumen visibility, optionally
 * removing it from Hive too.
 *
 * `visibility` and `takedown` are separate on purpose. Hiding changes what Lumen
 * shows and stops an unpublished post ever being broadcast; it does nothing to a
 * post already on chain. `takedown: true` is the extra, explicit step that queues
 * the on-chain removal (the worker blanks the content when Hive refuses the delete).
 *
 * Accepts a permlink as well as a post id — a lite permlink encodes its own row id,
 * so an operator can paste the URL segment straight from a report.
 *
 * Body: { postId | permlink, visibility, reason?, takedown?, actor? }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardModerator(req);
  if (blocked) return blocked;

  // Refuse an oversized body before it is buffered and parsed. See guardBodySize.
  const tooBig = guardBodySize(req);
  if (tooBig) return tooBig;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const visibility = body?.visibility;
  if (typeof visibility !== 'string' || !VISIBILITIES.includes(visibility as FeedVisibility)) {
    return NextResponse.json({ error: 'invalid_visibility', allowed: VISIBILITIES }, { status: 400 });
  }

  let postId = typeof body?.postId === 'string' ? body.postId : '';
  if (!postId && typeof body?.permlink === 'string') {
    postId = litePostIdOf({ permlink: body.permlink }) ?? '';
    if (!postId) {
      return NextResponse.json({ error: 'not_a_lumen_permlink' }, { status: 400 });
    }
  }
  if (!postId) return NextResponse.json({ error: 'post_required' }, { status: 400 });

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (visibility !== 'visible' && !reason) {
    return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  }

  try {
    const result = await moderatePost({
      actor: actorOf(req, body),
      postId,
      visibility: visibility as FeedVisibility,
      reason: reason || null,
      takedown: body?.takedown === true
    });
    if (!result) return NextResponse.json({ error: 'post_not_found' }, { status: 404 });

    return NextResponse.json({
      status: 'ok',
      postId: result.post.postId,
      userId: result.post.userId,
      visibility: result.post.feedVisibility,
      onChain: result.onChain,
      takedownQueued: result.takedownQueued,
      cancelledJobs: result.cancelledJobs,
      note:
        result.onChain && !result.takedownQueued && visibility === 'hidden'
          ? 'Hidden in Lumen only — this post is still on Hive. Re-send with takedown: true to queue its removal.'
          : undefined
    });
  } catch (error) {
    logger.error(error, 'Moderation (post) failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/** Who did it, as claimed by the caller. An attribution hint, not an identity. */
// F-L14: attribution from the operator-tooling HEADER only, never the request body
// (a body actor let any token-holder frame another operator). `_body` kept for symmetry.
function actorOf(req: NextRequest, _body: Record<string, unknown> | null): string {
  return req.headers.get('x-lite-moderator-actor')?.trim() || 'operator';
}
