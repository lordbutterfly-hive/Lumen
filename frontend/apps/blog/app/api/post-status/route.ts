import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getPost } from '@transaction/lib/bridge-api';
import { isPermlinkValid } from '@/blog/utils/validate-links';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';

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
    // ★ OUTER `withRetry` REMOVED (2026-09-05, perf batch C-A). `getPost` itself
    // now retries AND fails over across Hive nodes internally (`withHiveRetry`,
    // 2026-09-03 -- see its own comment in bridge-api.ts). The `withRetry` that
    // used to wrap this call only retried transport faults/5xx on the SAME node
    // and never failed over, so it was a strictly weaker second retry loop
    // stacked on top of a stronger one -- doubling this route's worst-case
    // latency on a real outage for no added resilience.
    const post = await getPost(author, permlink, observer).catch(() => null);
    /**
     * ★★★ THE ONE POST FETCH THAT NEVER GOT ITS IDENTITY OVERLAY (2026-09-11).
     *
     * Every other server path that returns an entry runs it through
     * `attachLiteIdentities` (`/api/discussion`, `/api/account-posts`, the post page,
     * the feeds). This one returns the raw chain entry, and it feeds `crossPostData`
     * on the post page -- so a cross-posted Lumen post rendered its byline as the
     * SHARED PUBLISHING ACCOUNT (`lumen.proxy`) instead of the person who wrote it,
     * along with that account's reputation and hover card.
     *
     * `attachLiteIdentities` is a no-op for an ordinary Hive post (it only touches
     * entries it can prove are Lumen-proxied, by checking the row's recorded signer
     * against the entry's author), so this is safe for the poll's normal case and
     * never throws -- see its own doc.
     */
    const [overlaid] = post ? await attachLiteIdentities([post]) : [null];
    return NextResponse.json({ post: overlaid ?? post ?? null }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'post status lookup failed for %s/%s', author, permlink);
    return NextResponse.json({ error: 'post_status_unavailable' }, { status: 502 });
  }
}
