import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getListVotesByCommentVoter } from '@transaction/lib/hive-api';
import { isPermlinkValid } from '@/blog/utils/validate-links';

const logger = getLogger('app');

const ACCOUNT_SHAPE = /^[a-z][a-z0-9.-]{1,15}$/;

/** Same shape of ceiling `/api/lite/block/state-bulk` puts on its own batch, and for
 *  the same reason: this travels in a query string, and one page's worth of posts is
 *  20-30. Over the cap the extra pairs are dropped rather than the batch rejected —
 *  a card whose answer is missing simply falls back to "no vote", which is the same
 *  state it shows today while its own request is in flight. */
const MAX_TARGETS = 100;

/** Bound the fan-out against the chain node: 19 posts is one page, but the cap above
 *  allows 100, and 100 simultaneous `list_votes` calls is a self-inflicted flood. */
const CONCURRENCY = 8;

/**
 * GET /api/comment-vote/bulk?voter=<name>&targets=<json> — `/api/comment-vote`, batched.
 *
 * ★★★ THE N+1. Measured in a real signed-in browser on `/@lordbutterfly`
 * (2026-08-13): **19 separate `/api/comment-vote` requests on one profile load**,
 * 400-590ms each, one per rendered post, plus the same shape on the home feed and
 * on every comment in a post thread. They are all the identical question — "has
 * this one viewer voted on this post" — asked once per card, and the browser
 * serialises them behind its per-host connection limit, which is what put the last
 * request on that page 12.7s after the click.
 *
 * The single-item route stays exactly as it is and keeps its callers; this answers
 * the same question for a page's worth of posts in ONE round trip. The work still
 * happens per target server-side (the chain offers no batched form of this read),
 * but it happens here — close to the node, `CONCURRENCY` at a time — instead of
 * across 19 browser round trips.
 *
 * `targets` is a JSON array of `[author, permlink]` tuples, the same terse-tuple
 * convention `/api/lite/block/state-bulk` uses; `voter` is sent once rather than
 * repeated in every tuple because a batch is always one viewer's own vote state.
 *
 * A malformed pair is skipped, not fatal — one bad permlink in a feed must not cost
 * the other 18 their answer. A pair whose chain read THROWS is likewise reported as
 * "no vote found" rather than failing the batch: that is what the caller already
 * shows when the single-item route 502s, so the batched path degrades identically.
 *
 * NOT CACHED and NOT `public`, exactly as the single-item route: per-viewer state.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const voter = (req.nextUrl.searchParams.get('voter') ?? '').trim().toLowerCase();
  if (!ACCOUNT_SHAPE.test(voter)) {
    return NextResponse.json({ error: 'voter_required' }, { status: 400 });
  }

  const raw = req.nextUrl.searchParams.get('targets');
  if (!raw) return NextResponse.json({ error: 'targets_required' }, { status: 400 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid_targets' }, { status: 400 });
  }
  if (!Array.isArray(parsed)) {
    return NextResponse.json({ error: 'invalid_targets' }, { status: 400 });
  }

  const targets: Array<[string, string]> = [];
  for (const pair of parsed.slice(0, MAX_TARGETS)) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const author = String(pair[0] ?? '').trim().toLowerCase();
    const permlink = String(pair[1] ?? '').trim();
    if (!ACCOUNT_SHAPE.test(author) || !isPermlinkValid(permlink)) continue;
    targets.push([author, permlink]);
  }

  // `key` is `author/permlink`, which is unique on Hive and is exactly what the
  // client already has in hand when it needs to look an answer up.
  const votes: Record<string, unknown> = {};
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const [author, permlink] = targets[index];
      try {
        const result = await getListVotesByCommentVoter([author, permlink, voter], 1);
        votes[`${author}/${permlink}`] = result?.votes?.[0] ?? null;
      } catch (error) {
        // Deliberately not fatal — see the doc above.
        logger.error(error, 'bulk comment vote lookup failed for %s/%s (voter %s)', author, permlink, voter);
        votes[`${author}/${permlink}`] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  return NextResponse.json({ votes }, { headers: { 'cache-control': 'private, no-store' } });
}
