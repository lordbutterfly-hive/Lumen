import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { getEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { liteTargetServable } from '@/blog/lib/lite/content/engagement-target';

const logger = getLogger('app');

/**
 * GET /api/lite/engagement?author=…&permlink=… — the read side of Lumen-local
 * votes and reblogs.
 *
 * `lumen_vote` and `lumen_reblog` were write-only, so the vote button and the reblog
 * button both read Hivemind — where a Lumen-local vote does not exist. The result was
 * a vote that appeared, then silently vanished on the next refetch or reload. This is
 * where the UI reads the truth instead.
 *
 * Unauthenticated and full Hive accounts get a null vote and false reblog rather than
 * a 401: the totals are public and a caller with no lite session simply has no lite
 * engagement of its own. The response is shaped like `getListVotesByCommentVoter` so
 * the existing vote component needs no new branches in its render logic.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  const author = req.nextUrl.searchParams.get('author');
  const permlink = req.nextUrl.searchParams.get('permlink');
  if (!author || !permlink) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }

  const session = await getLiteSession();
  const user = session.user;
  const userId = user?.account_tier === 'lite' && user.userId ? user.userId : null;

  try {
    // ★ B5 — a taken-down post must not keep reporting live counts. QA found
    // `posts/:id` 404ing while THIS endpoint served incrementable numbers for
    // the same post; same predicate as the write path, one helper.
    if (!(await liteTargetServable(author, permlink))) {
      return NextResponse.json({ error: 'target_unavailable' }, { status: 404 });
    }
    const engagement = await getEngagement(userId, author, permlink);
    // Mirrors a chain vote row closely enough for the existing consumer; `voter` is
    // the lite display name, which is exactly what the component compares against.
    // Matches wax's IVoteListItem field-for-field (note `weight` is a string there),
    // and `_temporary: true` is literally accurate: this row is not from the chain.
    const votes =
      engagement.weight !== null && user?.username
        ? [
            {
              id: 1,
              voter: user.username,
              author,
              permlink,
              weight: String(engagement.weight),
              rshares: engagement.weight,
              vote_percent: engagement.weight,
              last_update: new Date().toISOString(),
              num_changes: 0,
              _temporary: true
            }
          ]
        : [];
    return NextResponse.json({
      votes,
      reblogged: engagement.reblogged,
      voteCount: engagement.voteCount,
      reblogCount: engagement.reblogCount
    });
  } catch (error) {
    logger.error(error, 'Lite engagement read failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
