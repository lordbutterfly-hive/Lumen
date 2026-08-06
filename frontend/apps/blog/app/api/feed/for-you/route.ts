import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost, getPostsRanked } from '@transaction/lib/bridge-api';
import { fetchRankedFeed, getRecsysConfig, RecsysPost } from '@/blog/lib/recsys/feed-client';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listFolloweesOf } from '@/blog/lib/lite/repositories/follow-repository';
import { resolveRankedLiteBatch } from '@/blog/lib/lite/repositories/post-repository';
import { liteConfig } from '@/blog/lib/lite/config';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';

const logger = getLogger('app');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** See the over-fetch note in GET: hydration drops moderated/unfetchable posts. */
const OVER_FETCH_RATIO = 1.5;

/**
 * ★★★ GET /api/feed/for-you — the ranked feed, finally plugged in (2026-08-06).
 *
 * "For You" used to be `sort: 'trending'` straight off Hive's bridge API: the
 * global payout-ranked list, byte-identical for every viewer, on a product whose
 * entire premise is its own ranking engine. recsys had been built, hardened
 * across five councils and 870 tests, and had **no consumer at all**. This route
 * is that consumer.
 *
 * Shape: `{ entries: Entry[], source, degraded? }` — `entries` is the same
 * `Entry[]` the trending path returns, so `MediumPostCard` and everything
 * downstream render it unchanged.
 *
 * ★ WHY THE BROWSER CANNOT CALL RECSYS DIRECTLY. `RECSYS_API_TOKEN` is a shared
 * bearer secret and `/feed?viewer=<anyone>` returns any account's ranked feed
 * plus its full score decomposition. Shipping the token to the client would hand
 * every visitor both. The token stays server-side; this route is the only door.
 *
 * ★ WHY IT FALLS BACK RATHER THAN ERRORING. recsys is FAIL_CLOSED by design: it
 * refuses (503) whenever its weekly trust snapshot is stale, because every Sybil
 * defence would otherwise revert to fail-open. That is correct behaviour and it
 * WILL happen (a missed batch, a cold deploy, a slow warm-up measured at ~232s).
 * A reader must never see an error page for it. They get the chronological
 * feed, and `source` says which one they got — the degradation is reported, not
 * hidden, so an operator can alert on it instead of discovering it from a user.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  // Identity comes from the SESSION COOKIE, never from a query parameter. A
  // caller-supplied `?viewer=` would let anyone request anyone else's
  // personalised feed — the exact exposure recsys's own bearer auth closed.
  let viewer = '';
  let isLite = false;
  try {
    const session = await getLiteSession();
    viewer = session.user?.username ?? '';
    isLite = session.user?.account_tier === 'lite';
  } catch {
    viewer = '';
  }

  // ★ A LITE VIEWER IS NOT A HIVE ACCOUNT, and Hive's bridge API asserts on
  // that: `get_post`/`get_ranked_posts` with `observer=<a ULID handle>` throws
  // `Account <name> does not exist`, which took out hydration AND the fallback
  // and returned an EMPTY For You feed for exactly the audience this product is
  // built for. Found by running it, not by reading it.
  //
  // `viewer` is who recsys ranks for (it understands lite identities); the chain
  // observer is a separate thing — it only annotates posts with "did YOU vote on
  // this", and for a lite account the honest answer is the anonymous default.
  const chainObserver = viewer && !isLite ? viewer : DEFAULT_OBSERVER;

  if (!getRecsysConfig()) {
    return fallback(chainObserver, limit, 'unconfigured', 'RECSYS_FEED_URL is not set');
  }
  if (!viewer) {
    // Logged out: there is no viewer to personalise for, and recsys ranks
    // against a viewer by definition. Trending is the honest answer here, not a
    // degradation — say so distinctly so it does not pollute the alerting signal
    // for a genuinely broken ranker.
    return fallback(chainObserver, limit, 'anonymous', 'no signed-in viewer to rank for');
  }

  // A lite viewer's graph lives only in Lumen's Postgres — recsys cannot look up
  // a ULID on chain. Hand it over, or they are ranked as following nobody.
  let follows: string[] | undefined;
  if (isLite && liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      const session = await getLiteSession();
      const userId = session.user?.userId;
      follows = userId ? await listFolloweesOf({ userId }) : [];
    } catch (error) {
      logger.warn('for-you: could not read lite follows, ranking without them: %o', error);
      follows = [];
    }
  }

  // ★ OVER-FETCH, then trim. `hydrate` DROPS anything hidden, deleted, or no
  // longer fetchable from Hive, so asking recsys for exactly `limit` posts
  // returns FEWER than `limit` — and a viewer whose ranked page happens to
  // contain moderated content would silently get a short feed. Worse: a flood
  // of content that is later taken down would shrink everyone's page. Ask for
  // headroom and cut back afterwards.
  const overFetch = Math.min(Math.ceil(limit * OVER_FETCH_RATIO), MAX_LIMIT * 2);
  const outcome = await fetchRankedFeed({ viewer, limit: overFetch, follows });
  if (!outcome.ok) {
    return fallback(chainObserver, limit, outcome.reason, outcome.detail);
  }

  const hydrated = await hydrate(outcome.feed.posts, chainObserver);
  const entries = hydrated.slice(0, limit);
  if (hydrated.length === 0 && outcome.feed.posts.length > 0) {
    // Ranked results that ALL failed to hydrate is not an empty feed — it is a
    // broken one, and serving a blank page would look identical to "nothing new".
    logger.warn(
      'for-you: %d ranked posts but 0 hydrated — falling back',
      outcome.feed.posts.length
    );
    return fallback(chainObserver, limit, 'unavailable', 'ranked posts could not be hydrated');
  }

  return NextResponse.json({
    entries,
    source: 'recsys',
    generatedAt: outcome.feed.generated_at,
    ranked: outcome.feed.count,
    // How many ranked posts survived hydration, so a shrinking gap between
    // `ranked` and this is visible instead of looking like a quiet feed.
    served: entries.length
  });
}

/**
 * recsys returns identity + scores, not content. Fetch the posts and put them
 * back in the ORDER RECSYS CHOSE — that order is the entire product.
 */
async function hydrate(posts: RecsysPost[], observer: string): Promise<Entry[]> {
  if (posts.length === 0) return [];

  // A lite post lives on chain under the shared publisher account, so it must be
  // FETCHED as the publisher and DISPLAYED as its real writer. One batched query
  // resolves both the display name and whether Lumen still permits serving it.
  const litePosts = posts.filter((p) => p.chain_author);
  const liteByKey = new Map<string, { displayName: string; servable: boolean }>();
  if (litePosts.length > 0 && liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      const mappings = await resolveRankedLiteBatch(
        litePosts.map((p) => p.chain_author as string),
        litePosts.map((p) => p.permlink)
      );
      for (const m of mappings) {
        liteByKey.set(`${m.hiveAuthor}/${m.hivePermlink}`, {
          displayName: m.displayName,
          servable: m.servable
        });
      }
    } catch (error) {
      // Cannot prove a lite post is still servable => do not serve it. Failing
      // OPEN here would turn a database blip into a way for taken-down content
      // to reappear in the most visible surface in the product.
      logger.error(error, 'for-you: lite resolution failed; dropping lite posts from this page');
    }
  }

  const settled = await Promise.all(
    posts.map(async (p) => {
      const fetchAuthor = p.chain_author ?? p.author;
      const lite = p.chain_author ? liteByKey.get(`${p.chain_author}/${p.permlink}`) : undefined;

      // ★ MODERATION HOLDS HERE. recsys ranks from HAFSQL and has no idea what
      // Lumen has hidden — it will happily rank a post taken down an hour ago,
      // because on chain it is still there. Unknown lite post (no row) is also
      // dropped: it is not something we can vouch for.
      if (p.chain_author && (!lite || !lite.servable)) return null;

      try {
        const entry = await getPost(fetchAuthor, p.permlink, observer);
        if (!entry) return null;
        // Re-attribute to the ranked identity so a lite writer is credited in
        // the UI, matching how they were ranked.
        return lite?.displayName ? ({ ...entry, author: lite.displayName } as Entry) : entry;
      } catch {
        return null;
      }
    })
  );

  return settled.filter((e): e is Entry => e !== null);
}

async function fallback(
  chainObserver: string,
  limit: number,
  reason: string,
  detail: string
): Promise<NextResponse> {
  try {
    // `chainObserver`, never the raw viewer — see the note at its declaration.
    const posts = await getPostsRanked('trending', '', '', '', chainObserver, limit);
    return NextResponse.json({
      entries: posts ?? [],
      source: 'trending-fallback',
      degraded: reason,
      detail
    });
  } catch (error) {
    logger.error(error, 'for-you: fallback to trending also failed');
    return NextResponse.json(
      { entries: [], source: 'trending-fallback', degraded: reason, detail },
      { status: 200 }
    );
  }
}
