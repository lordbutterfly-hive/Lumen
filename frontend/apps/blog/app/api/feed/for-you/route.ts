import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost, getPostsRanked } from '@transaction/lib/bridge-api';
import { fetchRankedFeed, getRecsysConfig, RecsysPost } from '@/blog/lib/recsys/feed-client';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listFolloweesOf } from '@/blog/lib/lite/repositories/follow-repository';
import { findUserById } from '@/blog/lib/lite/repositories/user-repository';
import { tagsForInterests } from '@/blog/lib/lite/interests/taxonomy';
import { getEngagementTotals } from '@/blog/lib/lite/repositories/engagement-repository';
import { resolveRankedLiteBatch } from '@/blog/lib/lite/repositories/post-repository';
import { liteConfig } from '@/blog/lib/lite/config';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';

const logger = getLogger('app');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** See the top-up note in `hydrate`. */
const OVER_FETCH_RATIO = 1.5;

/**
 * ★★★ HYDRATION CACHE (2026-08-06) — MEASURED, NOT SPECULATIVE.
 *
 * recsys answers a 30-post ranked feed in 0.5-0.7s. The same request through
 * this route took 3.5-15s, and the first view after login TIMED OUT. All of that
 * gap is here: recsys returns identity + scores, so every ranked post costs one
 * `bridge.get_post` against a public Hive node, and a 20-post page was firing 30
 * of them.
 *
 * Posts change slowly (payout and vote counts drift; title and body do not), and
 * ranked feeds OVERLAP heavily between viewers — the same popular post is on
 * many pages at once. A short TTL therefore turns most of that cost into a map
 * lookup, for every viewer after the first.
 */
/**
 * ★★★ PER-VIEWER FEED CACHE — the 14 seconds happens ONCE, not every login.
 *
 * MEASURED 2026-08-06: a viewer whose recsys profile is cold costs ~9.6s inside
 * recsys plus first-time post hydration — ~14s end to end. recsys's own viewer
 * cache TTL is 300s, so a reader who comes back tomorrow is cold AGAIN. Paying
 * that on every login is not a product.
 *
 * So the assembled feed is cached per viewer and served STALE-WHILE-REVALIDATE:
 *
 *   < FRESH  serve straight from cache, no upstream work at all
 *   < STALE  serve the cached feed INSTANTLY and rebuild in the background, so
 *            the reader waits for nothing and the next view is current
 *   older    rebuild synchronously (the genuine first-ever view)
 *
 * That makes the expensive build a ONE-TIME onboarding cost — paid behind the
 * interest picker's spinner, where the reader has been told their feed is being
 * built — and every subsequent login instant.
 *
 * Deliberately in-process and bounded. A shared cache (Redis) would survive
 * restarts and is the right end state; it is also infrastructure this does not
 * have yet, and an in-process one already removes the per-login cost that makes
 * the product unusable.
 */
const FEED_FRESH_MS = 5 * 60_000;
const FEED_STALE_MS = 24 * 60 * 60_000;
const FEED_MAX_VIEWERS = 5_000;

interface CachedFeed {
  entries: Entry[];
  ranked: number;
  at: number;
}
const feedCache = new Map<string, CachedFeed>();
const rebuilding = new Set<string>();

function feedCachePut(viewer: string, entries: Entry[], ranked: number): void {
  if (feedCache.size >= FEED_MAX_VIEWERS) {
    const oldest = feedCache.keys().next().value;
    if (oldest !== undefined) feedCache.delete(oldest);
  }
  feedCache.set(viewer, { entries, ranked, at: Date.now() });
}

// NOTE: no exported invalidator here — Next allows a route file to export ONLY
// route handlers, and exporting anything else is a build-time type error. A
// viewer whose interests just changed is handled by the picker itself, which
// re-requests the feed with `?refresh=1` (see GET) rather than by reaching into
// this module's cache from outside.

const HYDRATION_TTL_MS = 60_000;
const HYDRATION_MAX_ENTRIES = 1_000;
const hydrationCache = new Map<string, { entry: Entry; at: number }>();

function cacheGet(key: string): Entry | null {
  const hit = hydrationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > HYDRATION_TTL_MS) {
    hydrationCache.delete(key);
    return null;
  }
  return hit.entry;
}

function cachePut(key: string, entry: Entry): void {
  // Bounded, oldest-first. A feed cache that can grow without limit is a memory
  // leak with extra steps.
  if (hydrationCache.size >= HYDRATION_MAX_ENTRIES) {
    const oldest = hydrationCache.keys().next().value;
    if (oldest !== undefined) hydrationCache.delete(oldest);
  }
  hydrationCache.set(key, { entry, at: Date.now() });
}

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

  // ★ CURSOR — how the feed scrolls past its first page (2026-08-07).
  //
  // The ranked feed is ONE scored order with no natural cursor, so page 1 is the
  // ranking and every page after it continues down the chain feed from where the
  // last page ended. That is honest — `source` says which you got — and it is the
  // only way to keep scrolling: recsys has no page 2 to give.
  const startAuthor = (req.nextUrl.searchParams.get('startAuthor') ?? '').trim();
  const startPermlink = (req.nextUrl.searchParams.get('startPermlink') ?? '').trim();
  const paging = Boolean(startAuthor && startPermlink);

  // ★ TOPIC MODE. `?tag=photography` ranks that ONE subject with the same engine
  // the main feed uses, so a topic page is the feed filtered — not a different,
  // older-looking page with its own ordering.
  const rawTag = (req.nextUrl.searchParams.get('tag') ?? '').trim().toLowerCase();
  const topic = /^[a-z0-9-]{1,64}$/.test(rawTag) ? rawTag : '';


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

  if (paging) {
    // Continuation pages come straight from the chain, in order, from the cursor.
    try {
      const posts = await getRankedPaged(
        topic ? 'created' : 'trending',
        topic,
        chainObserver,
        limit,
        startAuthor,
        startPermlink
      );
      const onTopic = topic ? posts.filter((e) => hasTopic(e, topic)) : posts;
      await mergeLumenEngagement(onTopic);
      const last = onTopic[onTopic.length - 1];
      return NextResponse.json({
        entries: onTopic,
        source: 'chain-page',
        nextCursor: last ? { author: last.author, permlink: last.permlink } : null
      });
    } catch (error) {
      logger.error(error, 'for-you: cursor page failed');
      return NextResponse.json({ entries: [], source: 'chain-page', nextCursor: null });
    }
  }

  if (!getRecsysConfig()) {
    return fallback(chainObserver, limit, 'unconfigured', 'RECSYS_FEED_URL is not set', topic);
  }
  if (!viewer) {
    // Logged out: there is no viewer to personalise for, and recsys ranks
    // against a viewer by definition. Trending is the honest answer here, not a
    // degradation — say so distinctly so it does not pollute the alerting signal
    // for a genuinely broken ranker.
    return fallback(chainObserver, limit, 'anonymous', 'no signed-in viewer to rank for', topic);
  }

  // ---- CACHE DECISION, before any upstream work ----
  // `?refresh=1` forces a rebuild: the interest picker calls it right after
  // saving, because serving a viewer the generic feed they had BEFORE telling us
  // what they like would make the picker look broken.
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1';
  // The cache is keyed by viewer alone, so a topic feed must bypass it entirely
  // — otherwise one topic request would poison the reader's personal feed.
  const cached = forceRefresh || topic ? undefined : feedCache.get(viewer);
  const age = cached ? Date.now() - cached.at : Infinity;

  if (cached && age < FEED_FRESH_MS) {
    return NextResponse.json({
      entries: cached.entries, source: 'recsys', ranked: cached.ranked,
      served: cached.entries.length, cache: 'fresh', nextCursor: cursorOf(cached.entries)
    });
  }
  if (cached && age < FEED_STALE_MS) {
    // Serve NOW, refresh behind the reader. `rebuilding` stops a burst of
    // requests each kicking off its own expensive rebuild.
    if (!rebuilding.has(viewer)) {
      rebuilding.add(viewer);
      void buildFeed(viewer, isLite, limit, chainObserver)
        .then((b) => { if (b) feedCachePut(viewer, b.entries, b.ranked); })
        .catch((e) => logger.warn('for-you: background refresh failed: %o', e))
        .finally(() => rebuilding.delete(viewer));
    }
    return NextResponse.json({
      entries: cached.entries, source: 'recsys', ranked: cached.ranked,
      served: cached.entries.length, cache: 'stale-revalidating', nextCursor: cursorOf(cached.entries)
    });
  }

  const built = await buildFeed(viewer, isLite, limit, chainObserver, topic);
  if (!built) {
    return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic);
  }
  if (!topic) feedCachePut(viewer, built.entries, built.ranked);
  return NextResponse.json({
    entries: built.entries, source: 'recsys', ranked: built.ranked,
    served: built.entries.length, cache: 'miss',
    nextCursor: cursorOf(built.entries)
  });
}

/**
 * Assemble one viewer's ranked feed: recsys -> hydrate -> order preserved.
 * Returns null when recsys cannot serve, so the caller falls back.
 */
async function buildFeed(
  viewer: string,
  isLite: boolean,
  limit: number,
  chainObserver: string,
  topic = ''
): Promise<{ entries: Entry[]; ranked: number } | null> {
  // A lite viewer's graph lives only in Lumen's Postgres — recsys cannot look up
  // a ULID on chain. Hand it over, or they are ranked as following nobody.
  let follows: string[] | undefined;
  let tags: string[] | undefined;
  if (isLite && liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      const session = await getLiteSession();
      const userId = session.user?.userId;
      follows = userId ? await listFolloweesOf({ userId }) : [];
      // ★★★ THE SIGNUP INTEREST PICKS, FINALLY REACHING THE RANKER.
      //
      // recsys has accepted `explicit_interest_tags` since it was written and
      // nothing ever supplied them. Without these a fresh lite account arrives
      // with no follows, no interests and no history, and recsys correctly
      // serves the cold-start popular lane — measured 2026-08-06: every result
      // came back `popular_fallback`, identically for every new reader.
      //
      // Ids are mapped to real Hive tags here rather than stored as tags, so the
      // taxonomy can be re-tuned (a tag dies, a better one appears) without a
      // migration and without rewriting what readers already chose.
      const user = userId ? await findUserById(userId) : null;
      const picks = user?.interests ?? [];
      tags = picks.length > 0 ? tagsForInterests(picks) : undefined;
    } catch (error) {
      logger.warn('for-you: could not read lite viewer state, ranking without it: %o', error);
      follows = [];
    }
  }

  // ★ OVER-FETCH, then trim. `hydrate` DROPS anything hidden, deleted, or no
  // longer fetchable from Hive, so asking recsys for exactly `limit` posts
  // returns FEWER than `limit` — and a viewer whose ranked page happens to
  // contain moderated content would silently get a short feed. Worse: a flood
  // of content that is later taken down would shrink everyone's page. Ask for
  // headroom and cut back afterwards.
  // ★ A TOPIC REQUEST RANKS WITHIN THAT TOPIC. The reader asked for one subject,
  // so their standing interests must not dilute it — the topic replaces them
  // rather than joining them.
  if (topic) tags = [topic];

  const overFetch = Math.min(Math.ceil(limit * OVER_FETCH_RATIO), MAX_LIMIT * 2);
  const outcome = await fetchRankedFeed({ viewer, limit: overFetch, follows, tags });
  if (!outcome.ok) return null;

  // ★ HYDRATE ONLY WHAT WE WILL SERVE, then top up if some dropped.
  //
  // Eagerly hydrating the whole over-fetched set cost `limit * 1.5` Hive calls
  // on EVERY request to insure against a drop that usually does not happen —
  // 30 round-trips for a 20-post page. Hydrating the first `limit` and only
  // reaching for the remainder when moderation or a fetch failure actually
  // removed something makes the common case cost `limit`, and the bad case no
  // worse than before.
  const ranked = outcome.feed.posts;
  const hydrated = await hydrate(ranked.slice(0, limit), chainObserver);
  if (hydrated.length < limit && ranked.length > limit) {
    const shortfall = limit - hydrated.length;
    const topUp = await hydrate(
      ranked.slice(limit, limit + Math.ceil(shortfall * OVER_FETCH_RATIO)),
      chainObserver
    );
    hydrated.push(...topUp);
  }
  // ★ TOPIC PAGES CONTAIN ONLY THAT TOPIC (2026-08-07). The ranker biases towards
  // the tag but still returns other subjects, so keep only genuine members; if
  // that leaves the page thin, top it up with the newest posts actually carrying
  // the tag. Ranked-and-on-topic first, then chronological-and-on-topic.
  let pool = hydrated;
  if (topic) {
    pool = hydrated.filter((entry) => hasTopic(entry, topic));
    if (pool.length < limit) {
      try {
        const seen = new Set(pool.map((e) => `${e.author}/${e.permlink}`));
        const recent = await getRankedPaged('created', topic, chainObserver, limit);
        for (const post of recent ?? []) {
          const key = `${post.author}/${post.permlink}`;
          if (!seen.has(key) && hasTopic(post, topic)) {
            seen.add(key);
            pool.push(post);
          }
        }
      } catch (error) {
        logger.warn('for-you: topic top-up failed for #%s: %o', topic, error);
      }
    }
  }

  const entries = pool.slice(0, limit);
  await mergeLumenEngagement(entries);
  if (hydrated.length === 0 && outcome.feed.posts.length > 0) {
    // Ranked results that ALL failed to hydrate is not an empty feed — it is a
    // broken one, and serving a blank page would look identical to "nothing new".
    logger.warn('for-you: %d ranked posts but 0 hydrated', outcome.feed.posts.length);
    return null;
  }
  return { entries, ranked: outcome.feed.count };
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

      const cacheKey = `${fetchAuthor}/${p.permlink}/${observer}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        return lite?.displayName ? ({ ...cached, author: lite.displayName } as Entry) : cached;
      }
      try {
        const entry = await getPost(fetchAuthor, p.permlink, observer);
        if (!entry) return null;
        cachePut(cacheKey, entry);
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

/**
 * Does this post actually carry the topic?
 *
 * ★ A HARD FILTER, NOT A HINT (owner report, 2026-08-07). recsys treats
 * `explicit_interest_tags` as a ranking SIGNAL — it biases the order towards a
 * subject but still returns other posts, which is right for a personal feed and
 * wrong for a topic page. "#photography" must contain photography and nothing
 * else, so the ranker decides the ORDER and this decides MEMBERSHIP.
 *
 * Checks the post's category (the first tag, which is where Hive puts the
 * primary one) and the tag list in json_metadata.
 */
function hasTopic(entry: Entry, topic: string): boolean {
  if (!topic) return true;
  const category = String((entry as { category?: string }).category ?? '').toLowerCase();
  if (category === topic) return true;
  try {
    const meta = entry.json_metadata as unknown;
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
    const tags = (parsed as { tags?: unknown })?.tags;
    if (Array.isArray(tags)) {
      return tags.some((t) => String(t).toLowerCase() === topic);
    }
  } catch {
    // Malformed metadata is not membership evidence — fall through to false.
  }
  return false;
}

/**
 * Fetch `want` posts from Hive, paging past its per-request cap.
 *
 * ★ 20 IS A PER-REQUEST LIMIT, NOT A CEILING (2026-08-07). `bridge.get_ranked_posts`
 * asserts `limit = N outside valid range [1:20]`, so a single call can never
 * return more — but it takes `start_author`/`start_permlink`, which is how every
 * other Hive frontend scrolls indefinitely. Clamping to 20 stopped the empty-feed
 * bug and then quietly became its own bug: a reader could scroll for five posts
 * and hit the end of the internet.
 *
 * Each page starts from the last post of the previous one. Hive REPEATS that
 * boundary post as the first item of the next page, so it is dropped.
 */
const HIVE_RANKED_MAX = 20;

async function getRankedPaged(
  sort: string,
  tag: string,
  observer: string,
  want: number,
  fromAuthor = '',
  fromPermlink = ''
): Promise<Entry[]> {
  const out: Entry[] = [];
  let startAuthor = fromAuthor;
  let startPermlink = fromPermlink;

  while (out.length < want) {
    const page = await getPostsRanked(
      sort,
      tag,
      startAuthor,
      startPermlink,
      observer,
      Math.min(want - out.length + (startAuthor ? 1 : 0), HIVE_RANKED_MAX)
    );
    if (!page || page.length === 0) break;
    // The cursor post comes back again at the head of the next page.
    const fresh = startAuthor ? page.slice(1) : page;
    if (fresh.length === 0) break;
    out.push(...fresh);
    const last = page[page.length - 1];
    if (!last) break;
    startAuthor = last.author;
    startPermlink = last.permlink;
    if (page.length < HIVE_RANKED_MAX) break; // Hive had nothing more to give.
  }
  return out.slice(0, want);
}

/**
 * Fold Lumen-local votes and reblogs into the counts a card displays.
 *
 * ★ The chain does not know about them and never will (a lite vote is
 * Lumen-local by design), so the tallies a reader sees have to be the sum. This
 * mutates the entry's own `stats.total_votes` / `reblogs` deliberately: every
 * surface in the app already renders those two fields, so merging here fixes the
 * feed, the profile and the post page at once instead of teaching each card about
 * a second source of truth.
 */
async function mergeLumenEngagement(entries: Entry[]): Promise<void> {
  if (entries.length === 0 || !liteConfig.enabled || !liteConfig.databaseUrl) return;
  try {
    const totals = await getEngagementTotals(
      entries.map((e) => ({ author: e.author, permlink: e.permlink }))
    );
    if (totals.size === 0) return;
    for (const entry of entries) {
      const extra = totals.get(`${entry.author}/${entry.permlink}`);
      if (!extra) continue;
      if (extra.votes > 0 && entry.stats) {
        entry.stats.total_votes = (entry.stats.total_votes ?? 0) + extra.votes;
      }
      if (extra.reblogs > 0) {
        entry.reblogs = (entry.reblogs ?? 0) + extra.reblogs;
      }
    }
  } catch (error) {
    // A missing Lumen tally must never blank out a working feed — the chain
    // numbers alone are still true, just incomplete.
    logger.warn('for-you: could not merge Lumen engagement counts: %o', error);
  }
}

/** The cursor a client uses to ask for the next page: the last post it was given. */
function cursorOf(entries: Entry[]): { author: string; permlink: string } | null {
  const last = entries[entries.length - 1];
  return last ? { author: last.author, permlink: last.permlink } : null;
}

async function fallback(
  chainObserver: string,
  limit: number,
  reason: string,
  detail: string,
  tag = ''
): Promise<NextResponse> {
  try {
    // `chainObserver`, never the raw viewer — see the note at its declaration.
    //
    // ★ For a TOPIC we fall back to `created` (newest first) rather than
    // `trending`: a topic page that cannot be ranked should at least be current.
    // Trending within one tag is dominated by a handful of old high-payout posts,
    // which reads as a dead topic.
    // ★ HIVE CAPS THIS AT 20 (2026-08-07). `bridge.get_ranked_posts` asserts
    // `limit = N outside valid range [1:20]` and throws for anything larger —
    // and the feed asks for 30. The throw was swallowed by the catch below into
    // an empty 200, so a SIGNED-OUT visitor got "No posts yet" on the home page
    // while the identical call worked everywhere else in the app (every other
    // caller happens to ask for <= 20). Proven directly against api.hive.blog:
    // limit=20 -> 20 posts, limit=30 -> assert_exception.
    const posts = await getRankedPaged(tag ? 'created' : 'trending', tag, chainObserver, limit);
    await mergeLumenEngagement(posts);
    return NextResponse.json({
      entries: posts ?? [],
      source: 'trending-fallback',
      degraded: reason,
      detail,
      nextCursor: cursorOf(posts ?? [])
    });
  } catch (error) {
    // Loud, because an empty feed and a broken feed look identical to a reader.
    logger.error(error, 'for-you: fallback to trending also failed (limit=%d, tag=%s)', limit, tag || '(none)');
    return NextResponse.json(
      { entries: [], source: 'trending-fallback', degraded: reason, detail },
      { status: 200 }
    );
  }
}
