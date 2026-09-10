import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListVotesByCommentVoter } from '@transaction/lib/hive-api';
import { withRetry } from '@transaction/lib/retry';
import { isPermlinkValid } from '@/blog/utils/validate-links';

const logger = getLogger('app');

const ACCOUNT_SHAPE = /^[a-z][a-z0-9.-]{1,15}$/;

/** One feed page's worth. Cards mount together, so this is the natural batch. */
const MAX_POSTS = 60;
/** Parallel chain reads. `list_votes limit 1` is small; this bounds the fan-out. */
const CONCURRENCY = 8;

/**
 * ★★★ "DID I VOTE ON THIS" FOR A WHOLE PAGE, IN ONE REQUEST (2026-09-10, owner:
 * "a post i voted 20 mins ago, inside my feed doesnt show me a full blade upvote
 * icon").
 *
 * The single-post sibling of this route (`../route.ts`) answers the same question
 * and is the right shape for a post page, which renders one. A FEED renders thirty,
 * and the reason the card could not simply ask was cost: thirty round trips to fill
 * in one boolean each. So `votes-component.tsx` only asked when it ALREADY knew the
 * answer was yes -- `enabled: !!checkVote` -- and `checkVote` reads the viewer's own
 * vote out of the entry's `active_votes`, which is exactly the field that is not
 * dependable on a feed card:
 *
 *   · the feed seed is TRIMMED to the viewer's own vote (`lib/feed/seed-trim.ts`),
 *     which is correct, but it is trimmed at the moment the page was BUILT, and a
 *     stored feed row is re-served to its owner for up to 18h (`feed-cache.ts`
 *     bands). A vote cast after that row was written is not in it.
 *   · an anonymous/shared seed keeps NOBODY's vote (`trimEntriesForSeed(entries, '')`).
 *
 * Either way the card concluded "not voted" from a list that never contained the
 * answer, and because the lookup that would have corrected it was gated on that same
 * conclusion, nothing ever corrected it. The blade stayed hollow until the entry was
 * fetched from a source that carries full votes -- i.e. until you opened the post.
 *
 * Batching is what makes asking affordable. `my-vote-batch.ts` coalesces every card
 * that mounts in the same tick into one POST, so a thirty-card feed costs ONE request
 * instead of thirty, and the 2026-08-10 payload work that trimmed `active_votes` out
 * of the feed (684 KB of it) is not undone -- this asks for the one bit that was
 * actually being used.
 *
 * PER-VIEWER AND NEVER CACHED, same as the single route.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    voter?: unknown;
    posts?: unknown;
  } | null;

  const voter = typeof body?.voter === 'string' ? body.voter.trim().toLowerCase() : '';
  if (!ACCOUNT_SHAPE.test(voter)) {
    return NextResponse.json({ error: 'voter_required' }, { status: 400 });
  }

  const raw = Array.isArray(body?.posts) ? body.posts : null;
  if (!raw || raw.length === 0) {
    return NextResponse.json({ error: 'posts_required' }, { status: 400 });
  }
  if (raw.length > MAX_POSTS) {
    return NextResponse.json({ error: 'too_many_posts' }, { status: 400 });
  }

  // Validated exactly as the single route validates its query string. A pair that
  // fails is DROPPED rather than failing the batch: one malformed card must not cost
  // the other twenty-nine their answer.
  const posts: { author: string; permlink: string }[] = [];
  for (const item of raw) {
    const author = typeof (item as { author?: unknown })?.author === 'string'
      ? (item as { author: string }).author.trim().toLowerCase()
      : '';
    const permlink = typeof (item as { permlink?: unknown })?.permlink === 'string'
      ? (item as { permlink: string }).permlink.trim()
      : '';
    if (!ACCOUNT_SHAPE.test(author) || !isPermlinkValid(permlink)) continue;
    posts.push({ author, permlink });
  }
  if (posts.length === 0) {
    return NextResponse.json({ votes: {} }, { headers: { 'cache-control': 'private, no-store' } });
  }

  const votes: Record<string, { voter: string; vote_percent: number; rshares: string }> = {};
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= posts.length) return;
      const { author, permlink } = posts[index];
      try {
        const result = await withRetry(
          () => getListVotesByCommentVoter([author, permlink, voter], 1),
          { label: `list_votes(${author}/${permlink})` }
        );
        // `by_comment_voter` returns lexicographically FROM the start triple, so a
        // row for a different post (or a different voter on this post) means this
        // viewer has not voted here. Same check the single route's caller makes.
        const hit = result?.votes?.[0];
        if (hit && hit.voter === voter && hit.author === author && hit.permlink === permlink) {
          votes[`${author}/${permlink}`] = {
            voter: hit.voter,
            vote_percent: hit.vote_percent,
            rshares: String(hit.rshares)
          };
        }
      } catch (error) {
        // One post's chain hiccup is not the batch's problem. Absent from the map
        // means "we do not know", which the client treats exactly as it treats
        // today's missing answer: leave the blade as the entry described it.
        logger.warn(error, 'batch vote lookup failed for %s/%s (voter %s)', author, permlink, voter);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, posts.length) }, worker));

  return NextResponse.json({ votes }, { headers: { 'cache-control': 'private, no-store' } });
}
