import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getPost } from '@transaction/lib/bridge-api';
import { withRetry } from '@transaction/lib/retry';
import { isPermlinkValid } from '@/blog/utils/validate-links';

const logger = getLogger('app');

const AUTHOR_SHAPE = /^[a-z0-9][a-z0-9.-]{1,31}$/;

/**
 * ★ Same rule as `/api/account`. `components/pending-indexing-message.tsx`
 * polls `getPost` directly, every 10s for up to 180s, right after a reader
 * publishes — it called `getChain()` on every single poll, which downloads
 * `wax.common.wasm` on first call. Narrow (only a just-published post that
 * has not indexed yet triggers this component at all) but real, and a poll
 * loop is exactly the shape where a client-side chain call is most wasteful.
 *
 * NOT CACHED: the whole point of the poll is to notice the moment the answer
 * changes from "not indexed" to "indexed".
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim().replace(/^@/, '').toLowerCase();
  const permlink = (req.nextUrl.searchParams.get('permlink') ?? '').trim();
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim();
  if (!AUTHOR_SHAPE.test(author) || !isPermlinkValid(permlink)) {
    return NextResponse.json({ error: 'author_and_permlink_required' }, { status: 400 });
  }
  try {
    // ★ A6 retry rollout (2026-08-18): wired here, not inside `getPost` itself —
    // that function's other caller (`/api/feed/for-you`) already has its own
    // hand-rolled retry across a ~30-way fan-out; see `getPost`'s own comment.
    const post = await withRetry(() => getPost(author, permlink, observer), {
      label: `getPost(${author}/${permlink})`
    }).catch(() => null);
    return NextResponse.json({ post: post ?? null }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'post status lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'post_status_unavailable' }, { status: 502 });
  }
}
