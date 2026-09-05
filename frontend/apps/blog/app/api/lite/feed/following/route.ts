import { NextRequest, NextResponse } from 'next/server';
import { enforceFeedRefreshRate } from '@/blog/lib/lite/antispam/rate-limit';
import { getClientIp } from '@/blog/lib/lite/http/ip';
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

  // ★ `refresh=1` BYPASSES THE 60s CACHE AND FANS OUT TO HIVE — up to
  // MAX_CHAIN_AUTHORS bridge calls per request. Unlimited, that is free
  // ammunition pointed at a Hive node, from one authenticated session, which is
  // exactly the class of bug this repo already fixes on `name/check`,
  // `follow/state` and the Magi GQL proxies. The CACHED path stays unlimited:
  // it is an in-memory read that costs nothing and rate-limiting it would
  // degrade an ordinary user's feed for no gain. (Audit B3, M2, 2026-08-20.)
  if (refresh && !(await enforceFeedRefreshRate(getClientIp(req)))) {
    return NextResponse.json({ ok: false, error: 'rate_limited' }, { status: 429 });
  }

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

    // ★★★ A DEAD SOURCE MUST NOT SINK A LIVE ONE (2026-08-12) — the equivalent,
    // on this route, of the /api/feed/for-you fix that keeps page-1 posts when
    // a later page times out. This used to be `Promise.all([listByUsers(...),
    // Promise.all(chainNames.map(...))])`: the per-author chain fetches already
    // caught their own failures (one unreachable author must not empty the
    // whole feed, per the comment below), but the Lumen lookup did not — so ONE
    // Postgres timeout rejected the OUTER `Promise.all` and threw away every
    // chain post that had already resolved successfully, turning a partial
    // failure into a total one and answering with a bare 500 to a reader who
    // actually had real posts sitting in the other, already-settled promise.
    // Each source now fails on its own; a working source is served even when
    // its sibling is down.
    let liteRows: Awaited<ReturnType<typeof posts.listByUsers>> = [];
    let liteOk = true;
    if (liteIds.length > 0) {
      try {
        liteRows = await posts.listByUsers(liteIds, { limit });
      } catch (error) {
        logger.warn('following feed: lite posts lookup failed: %o', error);
        liteOk = false;
      }
    }

    const chainResults = await Promise.all(
      chainNames.map(async (author) => {
        try {
          // `sort: 'posts'` is this author's own root posts. Deliberately not
          // 'blog' (which folds in their reblogs) — a reblog by someone you
          // follow is a different product decision, and silently including it
          // here would make the feed disagree with what the follow promised.
          // ★ OUTER `withRetry` REMOVED (2026-09-05, perf batch C-A).
          // `getAccountPosts` calls `getAccountPostsPage`, which now retries AND
          // fails over across Hive nodes internally (`withHiveRetry`,
          // 2026-09-03 -- see its own comment in bridge-api.ts). The `withRetry`
          // that used to wrap this call only retried transport faults/5xx on the
          // SAME node and never failed over, so per author it was a strictly
          // weaker second retry loop stacked on top of a stronger one -- and
          // this route already runs one such call per author in parallel via
          // `Promise.all` below, so the doubling applied to every author at once.
          const r = await getAccountPosts('posts', author, author, '', '');
          return { ok: true, entries: (r ?? []).slice(0, PER_CHAIN_AUTHOR) };
        } catch (error) {
          // One unreachable author must not empty the whole feed.
          logger.warn('following feed: chain author %s failed: %o', author, error);
          return { ok: false, entries: [] as Entry[] };
        }
      })
    );
    const chainPages = chainResults.map((r) => r.entries);
    const chainOk = chainNames.length === 0 || chainResults.some((r) => r.ok);

    // ★ TOTAL FAILURE GETS A FAILING STATUS, NOT AN EMPTY 200 — same reasoning
    // as the cursor-page branch in /api/feed/for-you (which answers 502 rather
    // than `{entries: []}`): a reader who follows people and got nothing back
    // because every source we asked was unreachable is not the same reader
    // whose followees genuinely posted nothing, and conflating them would tell
    // react-query the request succeeded — which is exactly what lets an empty
    // answer paint over a feed the reader was already reading. `attempted`
    // counts only the sources this reader's follow graph actually has; a
    // reader with no chain followees is never penalised for chainOk being
    // vacuously true.
    const attempted = (liteIds.length > 0 ? 1 : 0) + (chainNames.length > 0 ? 1 : 0);
    const succeeded = (liteIds.length > 0 && liteOk ? 1 : 0) + (chainNames.length > 0 && chainOk ? 1 : 0);
    if (attempted > 0 && succeeded === 0) {
      return NextResponse.json({ error: 'server_error' }, { status: 502 });
    }

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
