import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListVotesByCommentVoter } from '@transaction/lib/hive-api';
import { isPermlinkValid } from '@/blog/utils/validate-links';

const logger = getLogger('app');

const ACCOUNT_SHAPE = /^[a-z][a-z0-9.-]{1,15}$/;

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). "Has `voter`
 * already voted on this post/comment" — `votes-component.tsx` called
 * `getListVotesByCommentVoter` directly to answer this, which reaches
 * `getChain()` and downloads `wax.common.wasm`. Its gate (`checkVote` — the
 * viewer's own vote already present in the post's `active_votes`) fires for
 * ANY rendered post/comment the signed-in reader has previously voted on —
 * every `MediumPostCard` on the home feed and both profile tabs, every
 * comment in the post page's thread, the moment the card mounts, no click
 * required. `use-vote-mutation.ts`'s post-broadcast confirmation read
 * (`database_api.list_votes`, same underlying call) shares this fix.
 *
 * `database_api.list_votes` with `order: 'by_comment_voter'` and a
 * `[author, permlink, voter]` start triple returns votes lexicographically
 * from that point — `limit: 1` server-side matches what both callers actually
 * need (a single yes/no answer for one voter on one post), never exposed as a
 * client-controlled pagination parameter.
 *
 * NOT CACHED and NOT `public`: per-viewer vote state.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  const voter = (req.nextUrl.searchParams.get('voter') ?? '').trim().toLowerCase();
  if (!ACCOUNT_SHAPE.test(author) || !isPermlinkValid(permlink) || !ACCOUNT_SHAPE.test(voter)) {
    return NextResponse.json({ error: 'author_permlink_voter_required' }, { status: 400 });
  }
  try {
    const result = await getListVotesByCommentVoter([author, permlink, voter], 1);
    return NextResponse.json(result, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'comment vote lookup failed for %s/%s (voter %s)', author, permlink, voter);
    return NextResponse.json({ error: 'comment_vote_unavailable' }, { status: 502 });
  }
}
