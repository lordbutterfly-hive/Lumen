import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { requireActiveLiteUser } from '@/blog/lib/lite/http/actor';
import { listFolloweesOf } from '@/blog/lib/lite/repositories/follow-repository';
import * as posts from '@/blog/lib/lite/repositories/post-repository';
import { dbPostToEntry } from '@/blog/lib/lite/render/db-post-to-entry';
import { resolvePublicNames } from '@/blog/lib/lite/render/current-name';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import type { Entry } from '@hive/common-hiveio-packages/wax';

const logger = getLogger('app');

/**
 * ★★★ THE "FOLLOWING" FEED FOR A LUMEN LITE ACCOUNT.
 *
 * WHY THIS ROUTE HAD TO EXIST. The Following tab called
 * `bridge.get_account_posts({ sort: 'feed', account: <viewer> })` — Hive's own
 * follow feed, which is built from the CHAIN's follow graph and keyed on a real
 * Hive account. A lite account is not a Hive account. So the node answered, for
 * every lite reader, every time:
 *
 *     assert_exception — "Account <lite name> does not exist"
 *
 * React Query retried it six times over ~7 seconds and then rendered "There was
 * a problem fetching the data. Please check if permlink is correct or the node
 * is running properly." — on a feed page, about no permlink, with a healthy
 * node. The second-most-prominent control on the home page was unconditionally
 * broken for the exact audience this product is built for, and it blamed the
 * infrastructure while doing it. Found by an exploratory UX tester 2026-08-06
 * and reproduced independently before this was written.
 *
 * A lite reader's follows are not on chain either — they live in `lumen_follow`,
 * and they point at BOTH kinds of author:
 *
 *   * another Lumen account — stored as its `lumen_user_id` (a ULID), whose
 *     posts are rows in `lumen_post`;
 *   * an ordinary Hive account — stored as its Hive name, whose posts are on
 *     chain under that name.
 *
 * So this route reads the follow list, fans out to both stores, merges by
 * recency and returns the same `Entry` shape the feed already renders. That
 * split is not an implementation detail — it IS what following means here.
 */

/** How many chain followees we will fetch posts for on one request. */
const MAX_CHAIN_AUTHORS = 24;
/** Posts pulled per chain followee before the merge. */
const PER_CHAIN_AUTHOR = 6;
/** A ULID — how `listFolloweesOf` returns a LUMEN followee. Crockford base32. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

interface CachedFeed {
  entries: Entry[];
  at: number;
}
const FRESH_MS = 60_000;
const MAX_VIEWERS = 500;
const cache = new Map<string, CachedFeed>();

function cachePut(viewer: string, entries: Entry[]): void {
  if (cache.size >= MAX_VIEWERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(viewer, { entries, at: Date.now() });
}

/** Newest first, on the field every Entry carries. */
function byCreatedDesc(a: Entry, b: Entry): number {
  return new Date(b.created).getTime() - new Date(a.created).getTime();
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // Same actor resolution as every other lite route: the cookie is the truth,
  // and a suspended/banned account must not be served a feed.
  let userId: string;
  try {
    const session = await getLiteSession();
    const actor = await requireActiveLiteUser(session.user, session);
    if (!actor.ok) return NextResponse.json({ error: 'not_a_lite_session' }, { status: 401 });
    userId = actor.user.userId;
  } catch {
    // Not a lite session at all. The caller should be using the chain feed —
    // saying so beats pretending this reader follows nobody.
    return NextResponse.json({ error: 'not_a_lite_session' }, { status: 401 });
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 30;
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';

  const cached = refresh ? undefined : cache.get(userId);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return NextResponse.json({ entries: cached.entries.slice(0, limit), cache: 'fresh' });
  }

  try {
    const followees = await listFolloweesOf({ userId });
    if (followees.length === 0) {
      // A real, correct empty state — NOT an error. This is the single most
      // common case for a new reader and it must never look like a failure.
      return NextResponse.json({ entries: [], following: 0, cache: 'miss' });
    }

    const liteIds = followees.filter((f) => ULID.test(f));
    const chainNames = followees.filter((f) => !ULID.test(f)).slice(0, MAX_CHAIN_AUTHORS);

    const [liteRows, chainPages] = await Promise.all([
      posts.listByUsers(liteIds, { limit }),
      Promise.all(
        chainNames.map((author) =>
          // `sort: 'posts'` is this author's own root posts. Deliberately not
          // 'blog' (which folds in their reblogs) — a reblog by someone you
          // follow is a different product decision, and silently including it
          // here would make the feed disagree with what the follow promised.
          getAccountPosts('posts', author, author, '', '')
            .then((r) => (r ?? []).slice(0, PER_CHAIN_AUTHOR))
            // One unreachable author must not empty the whole feed.
            .catch((error) => {
              logger.warn('following feed: chain author %s failed: %o', author, error);
              return [] as Entry[];
            })
        )
      )
    ]);

    const names = await resolvePublicNames(liteRows);
    const liteEntries = liteRows.map((p) => dbPostToEntry(p, names.get(p.postId)));
    const entries = [...liteEntries, ...chainPages.flat()].sort(byCreatedDesc).slice(0, limit);

    cachePut(userId, entries);
    return NextResponse.json({
      entries,
      following: followees.length,
      sources: { lumen: liteEntries.length, chain: chainPages.flat().length },
      cache: 'miss'
    });
  } catch (error) {
    logger.error(error, 'Lite following feed failed');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
