import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost, getPostsRanked } from '@transaction/lib/bridge-api';
import {
  fetchRankedFeed,
  getRecsysConfig,
  RecsysOutcome,
  RecsysPost
} from '@/blog/lib/recsys/feed-client';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { listFolloweesOf } from '@/blog/lib/lite/repositories/follow-repository';
import { listBlockedIdentitiesOf, listBlockedKeysOf } from '@/blog/lib/lite/repositories/block-repository';
import { filterBlockedForViewer } from '@/blog/lib/lite/social/block-filter';
import type { FollowActor } from '@/blog/lib/lite/social/follow-actor';
import { findUserById, findUserByHiveAccountName } from '@/blog/lib/lite/repositories/user-repository';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import { isLumenPermlink } from '@/blog/lib/lite/render/lite-post-id';
import { findHiveReaderPrefs } from '@/blog/lib/lite/repositories/hive-reader-prefs-repository';
import { tagsForInterests } from '@/blog/lib/lite/interests/taxonomy';
import { getEngagementTotals } from '@/blog/lib/lite/repositories/engagement-repository';
import { resolveRankedLiteBatch } from '@/blog/lib/lite/repositories/post-repository';
import { liteConfig } from '@/blog/lib/lite/config';
import { filterBannedEntries } from '@/blog/lib/moderation/banned-authors';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import {
  FEED_FRESH_MS,
  type FeedLane,
  buildOnce,
  feedVersion,
  inFailureCooldown,
  isRebuilding,
  noteBuildFailure,
  readViewerFeed,
  recordFeedServe,
  viewerGeneration,
  writeViewerFeed
} from '@/blog/lib/feed/feed-cache';

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
 * ★★★ PER-VIEWER FEED STORE — the wait happens ONCE, EVER. (2026-08-08)
 *
 * MEASURED TODAY through this route, cold, per viewer:
 *   steevc 7.2s | melinda010100 9.3s | gtg 13.2s | lordbutterfly 16.3s
 *
 * Two things were wrong with that, and only one of them is "slow".
 *
 * 1. THE FIRST BUILD ABORTED AND KEPT NOTHING. `RECSYS_FEED_TIMEOUT_MS=15000`,
 *    so `lordbutterfly` died at 15s, cached nothing, and was served Hive
 *    trending marked `degraded: "unavailable"`. Reload: identical. There was no
 *    number of retries that got that reader a ranked feed — a PERMANENT TRAP,
 *    and the thing the owner actually noticed ("my logged-in feed is identical
 *    to the logged-out one"). Raising the timeout would not have fixed it; it
 *    would have moved the wall and made every cold reader wait longer at it.
 *    What fixes it is separating the BUILD from the REQUEST: the build is
 *    started, single-flighted per viewer, and runs to completion on its own —
 *    the request merely watches it for as long as a reader will plausibly wait
 *    (FEED_FIRST_BUILD_PATIENCE_MS, default 12s). If it finishes in time the
 *    reader gets their ranked feed; if it does not, they get trending ONCE,
 *    labelled `degraded: "building"`, while the build keeps going and stores its
 *    result. The next load is ranked and instant. The trap is gone either way.
 *
 * 2. THE CACHE DIED ON EVERY RESTART. It was an in-process Map, and recsys's own
 *    viewer cache expires after 300s, so a reader returning later paid the full
 *    cold cost again. The assembled feed is now written to Postgres
 *    (`lumen_feed_store`, migration 0026) with memory in front of it.
 *
 * THE SERVING RULE, which is the owner's sentence turned into code: once a
 * viewer has ANY stored feed they are NEVER made to wait again. Fresh is served
 * as-is; anything else is served INSTANTLY and rebuilt behind the reader. There
 * is no age at which this route goes back to blocking — the old 24h
 * `FEED_STALE_MS` cliff, which sent yesterday's reader back to a 16-second
 * spinner, is deleted. Only a viewer with nothing stored at all waits, and that
 * is the one spinner in the product.
 *
 * `cache` on the response says exactly which of those happened, and a copy that
 * came off disk never claims the freshness of one that did not.
 */

const HYDRATION_TTL_MS = 60_000;
const HYDRATION_MAX_ENTRIES = 1_000;
const hydrationCache = new Map<string, { entry: Entry; at: number }>();

/**
 * Topic-feed cache and single-flight, keyed by `viewer|topic`.
 *
 * Deliberately in-memory and small: a topic page is a browsing detour, not the
 * reader's home, so it does not deserve a durable per-viewer row the way the
 * personal feed does — it just must not rebuild from scratch on every single
 * visit. See the long comment at the `if (topic)` branch for the measurements
 * that made this necessary.
 */
const TOPIC_CACHE_MS = 120_000;
const TOPIC_CACHE_MAX = 200;
const topicFeedCache = new Map<string, { entries: Entry[]; ranked: number; at: number }>();
const topicInflight = new Map<string, Promise<BuiltFeed | null>>();

function rememberTopicFeed(key: string, entries: Entry[], ranked: number): void {
  // Bounded so a crawler walking every tag cannot grow this without limit.
  // Map preserves insertion order, so the oldest key is the first one.
  if (topicFeedCache.size >= TOPIC_CACHE_MAX) {
    const oldest = topicFeedCache.keys().next().value;
    if (oldest !== undefined) topicFeedCache.delete(oldest);
  }
  topicFeedCache.set(key, { entries, ranked, at: Date.now() });
}

/**
 * One build per `viewer|topic` at a time. Unlike `buildOnce` this does NOT
 * detach: a topic page has no persistent store to write into, so a build nobody
 * is awaiting would burn a recsys round trip and throw the result away.
 */
function buildTopicOnce(key: string, build: () => Promise<BuiltFeed | null>): Promise<BuiltFeed | null> {
  const existing = topicInflight.get(key);
  if (existing) return existing;
  const running = build().finally(() => {
    if (topicInflight.get(key) === running) topicInflight.delete(key);
  });
  topicInflight.set(key, running);
  // A rejection still reaches real awaiters; this only stops an unhandled one.
  void running.catch(() => undefined);
  return running;
}

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

/**
 * ★★★ GET — the real export, and the ONE place a blocked author is removed from
 * whatever this route decided to serve (block effect A: "I never see them again").
 *
 * WHY A WRAPPER RATHER THAN A FILTER AT EACH RETURN. `serveForYou` answers from six
 * different places — stored feed, cold build, topic cache, topic build, chain
 * continuation page, and the trending fallback (which is a separate function that
 * takes none of the viewer's state). Six is already more than anyone reliably
 * remembers, and a seventh will be added by someone who has not read this file. A
 * branch that forgets the filter does not fail loudly; it quietly serves a reader
 * the person they blocked, which is precisely the failure this feature exists to
 * prevent. Filtering the assembled response instead makes forgetting impossible.
 *
 * The ranker is ALSO told (`mutes`, see `collectViewerState`), so blocked authors do
 * not consume ranked slots. That is an optimisation; this is the guarantee. Neither
 * replaces the other: recsys can be unavailable, the stored feed can predate the
 * block, and the fallback path never involves recsys at all.
 *
 * Effect (B) is not served from here — it lives in the thread paths, where it can be
 * enforced against readers other than the blocker.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const response = await serveForYou(req);

  let blockedKeys: Set<string>;
  try {
    const session = await getLiteSession();
    const actor = await viewerBlockActor(session.user?.userId ?? '', session.user?.username ?? '');
    blockedKeys = actor ? new Set(await listBlockedKeysOf(actor)) : new Set();
  } catch (error) {
    // A reader whose block list cannot be read gets an unfiltered feed rather than
    // no feed. Logged, because silently ignoring a block is exactly the shape of
    // bug that gets reported as "blocking does not work".
    logger.warn('for-you: block list unavailable, serving unfiltered: %o', error);
    blockedKeys = new Set();
  }

  try {
    const body = (await response.clone().json()) as
      | { entries?: Entry[]; nextCursor?: { author: string; permlink: string } | null }
      | null;
    if (!body?.entries || body.entries.length === 0) return response;
    const identified = withIdentifiableAuthors(body.entries);
    const entries =
      blockedKeys.size > 0 ? await filterBlockedForViewer(identified, blockedKeys) : identified;
    if (entries.length === body.entries.length) return response;
    return NextResponse.json(
      {
        ...body,
        entries,
        // The cursor is the LAST ENTRY THE READER WAS GIVEN. Recomputing it here
        // keeps that true after a removal — otherwise a page whose last post was
        // filtered would hand back a cursor for a post that is not on it, and for
        // a lite post that cursor is in the wrong name-space entirely (`cursorOf`).
        // An emptied page keeps whatever the branch decided, so filtering everything
        // out does not silently end the reader's scroll.
        nextCursor: entries.length > 0 ? cursorOf(entries) : body.nextCursor
      },
      { status: response.status }
    );
  } catch (error) {
    logger.warn('for-you: could not apply block filter to the response: %o', error);
    return response;
  }
}

/**
 * ★ AN AUTHOR WE CANNOT NAME IS NOT SERVED HERE. Companion to the block filter
 * above, and deliberately in the same wrapper for the same reason.
 *
 * Blocking on this surface resolves a lite entry through `_lite.userId`. An entry
 * that IS a lite post (its permlink is in Lumen's own namespace) but carries no
 * `_lite` therefore cannot be block-filtered at all: `block-actor.ts` reads it as a
 * Hive account and computes a key that can never match a `u:<ULID>` edge. That is
 * the bug this file was fixed for, and `hydrate` no longer produces such entries —
 * but `lumen_feed_store` still holds pages ASSEMBLED BEFORE the fix, and they are
 * served straight to the reader (see the stored branch), so the hole outlives the
 * code change by exactly as long as those rows do.
 *
 * Withholding them is the fail-closed answer and it self-erases: the stale copy is
 * rebuilt behind the reader on the same request, and every rebuilt page carries
 * `_lite`. It is also a standing guard — a seventh serving branch that forgets
 * identity loses its lite posts loudly instead of quietly serving a blocked author.
 */
function withIdentifiableAuthors<T extends Entry>(entries: T[]): T[] {
  const kept = entries.filter((entry) => !isLumenPermlink(entry.permlink ?? '') || entry._lite);
  if (kept.length !== entries.length) {
    logger.warn(
      'for-you: withheld %d lite post(s) served without a Lumen identity — a page ' +
        'assembled before the identity fix. It is being rebuilt behind this reader.',
      entries.length - kept.length
    );
  }
  return kept;
}

/**
 * The block-graph node for whoever is signed in, resolved WITHOUT `sessionActor`
 * (which needs a `User` object this route does not keep).
 *
 * An upgraded account is the case that makes this more than one line: they sign in
 * with their own Hive keys, so their session carries a NAME and no `userId`, while
 * every block they have ever written or received is keyed on `u:<user_id>`. Reading
 * the name as a Hive node would hand them an empty block list the day they upgrade.
 */
async function viewerBlockActor(userId: string, username: string): Promise<FollowActor | null> {
  if (userId) return { userId };
  const name = (username || '').toLowerCase();
  if (!name) return null;
  const upgraded = await findUserByHiveAccountName(name).catch(() => null);
  return upgraded ? { userId: upgraded.userId } : { hive: name };
}

async function serveForYou(req: NextRequest): Promise<NextResponse> {
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
  //
  // ★ READ ONCE, HERE. `buildFeed` used to call `getLiteSession()` again from
  // inside itself. That is now impossible: a build outlives the request that
  // started it, and `getLiteSession` reads `next/headers` cookies — request
  // scope. Everything the ranker needs about the viewer is resolved from these
  // three values instead, so the background path never touches a request object.
  let viewer = '';
  let isLite = false;
  let userId = '';
  try {
    const session = await getLiteSession();
    viewer = session.user?.username ?? '';
    isLite = session.user?.account_tier === 'lite';
    userId = session.user?.userId ?? '';
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
      const merged = await mergeLumenEngagement(onTopic);
      return NextResponse.json({
        entries: merged,
        source: 'chain-page',
        // Through `cursorOf` like every other branch, so the chain-coordinate
        // rule lives in exactly one place and a sixth return cannot forget it.
        nextCursor: cursorOf(merged)
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

  // ★ A TOPIC FEED IS NOT THE READER'S FEED, and the store is keyed by viewer
  // alone — so a topic request neither reads nor writes it, and is deliberately
  // NOT single-flighted either (single-flight is keyed by viewer too, and a
  // `#photography` build must never be handed to whoever asked for their
  // personal feed a moment later). Topic pages are also cheap by comparison and
  // navigated to deliberately, so a synchronous build is the honest shape.
  if (topic) {
    // ★★ "TOPIC PAGES ARE CHEAP BY COMPARISON" WAS WRONG — MEASURED 2026-08-09.
    //
    // The comment above reasoned that a synchronous, uncached build is "the
    // honest shape" because topic pages are cheap and deliberately navigated to.
    // A tester timed it instead: signed OUT, first card in 654–1882ms (5 trials);
    // signed IN, 8.5–10.0s on `/topics/nsfw` (5 trials) and 11.6–24.6s on
    // `/topics/photography` (3 trials) — behind a bare skeleton with no progress
    // copy, on EVERY visit, because nothing here reads or writes any cache.
    //
    // That is the same cold-build cost this file's own history records for the
    // personal feed (7.2s–16.3s) — the cost the persistent store exists to pay
    // once. Topic feeds simply never got an equivalent.
    //
    // They cannot share the viewer store or `buildOnce`: both are keyed by
    // viewer alone, and handing a `#photography` build to someone who asked for
    // their personal feed is exactly the bug the original comment guards against.
    // So this is a small cache and single-flight keyed by BOTH — `viewer|topic`.
    // Same viewer, same topic joins one build; different topic never does.
    const topicKey = `${viewer}|${topic}`;
    const cached = topicFeedCache.get(topicKey);
    if (cached && Date.now() - cached.at < TOPIC_CACHE_MS) {
      return NextResponse.json({
        entries: cached.entries, source: 'recsys', ranked: cached.ranked,
        served: cached.entries.length, cache: 'topic-cached', nextCursor: cursorOf(cached.entries)
      });
    }

    const built = await buildTopicOnce(topicKey, async () => {
      const state = await collectViewerState(viewer, isLite, userId);
      return assembleFeed({ viewer, limit, chainObserver, topic, ...state });
    });
    if (!built) {
      return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic);
    }
    rememberTopicFeed(topicKey, built.entries, built.ranked);
    // ★ NOT RECORDED IN THE SERVED LOG, DELIBERATELY. The log's domain is the
    // PERSONAL ranked page — the thing the demotion will act on and the thing
    // §7's slot budgets are written about. `lumen_feed_served` has no topic
    // column (the requested shape is `viewer, post_key, served_at, position,
    // source`), so mixing #photography rows in would make "their last served
    // page" ambiguous: the newest rows for a viewer might be a topic page they
    // visited once. Excluded on purpose, and named here so a consumer knows the
    // log's boundary rather than discovering it as a gap. Same reason the
    // trending fallback and the chain continuation pages are not recorded.
    return NextResponse.json({
      entries: built.entries, source: 'recsys', ranked: built.ranked,
      served: built.entries.length, cache: 'topic', nextCursor: cursorOf(built.entries)
    });
  }

  // `?refresh=1` forces a rebuild: the interest picker calls it right after
  // saving, because serving a viewer the generic feed they had BEFORE telling us
  // what they like would make the picker look broken.
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1';

  /**
   * Start (or join) this viewer's rebuild. The returned promise belongs to the
   * VIEWER, not to this request — see `buildOnce`. It resolves the viewer's
   * ranking inputs itself, so nothing in here reaches for request scope, and it
   * stores its own result so a caller who stops waiting still gets the benefit.
   */
  const startBuild = (): Promise<BuiltFeed | null> =>
    buildOnce(viewer, async () => {
      // Stamped BEFORE any work: if the reader changes their interests while
      // this runs, the write is refused rather than resurrecting the feed they
      // just replaced.
      const era = viewerGeneration(viewer);
      const state = await collectViewerState(viewer, isLite, userId);
      const built = await assembleFeed({ viewer, limit, chainObserver, ...state });
      if (built) {
        await writeViewerFeed({
          viewer,
          entries: built.entries,
          ranked: built.ranked,
          builtLimit: limit,
          lanes: built.lanes,
          startedAtGeneration: era
        });
      } else {
        noteBuildFailure(viewer);
      }
      return built;
    });

  // ---- SERVE DECISION ----
  const stored = forceRefresh ? undefined : await readViewerFeed(viewer);

  if (stored) {
    // ★ ANYTHING STORED IS SERVED IMMEDIATELY. Not "if recent enough" — the
    // reader has waited for this feed once already and does not get asked twice.
    const age = Date.now() - stored.at;
    // Three separate ways a stored copy can be behind, and all three are
    // repaired the same way: serve it now, fix it behind them.
    //   age       the ordinary case — the world moved on.
    //   version   the ranking WEIGHTS changed (viewer-affinity), so the content
    //             is stale even though the timestamp is not. Soft by design:
    //             the owner asked for weight updates to be INVISIBLE.
    //   limit     this copy was assembled for a smaller page than the one being
    //             asked for. Self-heals after exactly one rebuild.
    const fresh =
      age < FEED_FRESH_MS && stored.version === feedVersion() && stored.builtLimit >= limit;

    if (!fresh && !isRebuilding(viewer) && !inFailureCooldown(viewer)) {
      void startBuild().catch((e) => logger.warn('for-you: background refresh failed: %o', e));
    }

    // ★ THE STORED FEED IS THE ONE PLACE A BAN CAN BE OUTRUN.
    //
    // Everything else in this route reaches the chain through `getPost` /
    // `getPostsRanked`, which drop banned authors at the source. This branch does
    // not: it serves `lumen_feed_store` rows that were ASSEMBLED EARLIER — before
    // the ban existed — straight to the reader. Without this filter the troll
    // would keep appearing in the For You feed of every viewer whose feed was
    // built before he was listed, for as long as that row survived, and no
    // amount of correct filtering anywhere else would have shown it.
    //
    // Filtering on read (rather than purging the table) also means the ban takes
    // effect on the next request, with no migration and no rebuild.
    const entries = filterBannedEntries(stored.entries).slice(0, limit);

    // ★★★ THE COMMON CASE, AND THEREFORE THE ONE THAT MATTERS MOST TO RECORD
    // (2026-08-08, ruling §7). Almost every delivery of the For You page comes
    // out of this branch — `fresh`, `stale-revalidating`, and both of their
    // `stored-` variants. Hooking the served log to the BUILD instead would have
    // recorded a handful of cold assemblies and missed essentially every actual
    // reading, i.e. it would undercount precisely the readers who come back most
    // often — the readers the 19-20/20 repetition is being measured on.
    //
    // Note what is recorded: `entries`, AFTER the ban filter and AFTER the slice.
    // A post the reader never received is not an impression, and its position is
    // its position on the page as delivered, not its rank in the build.
    recordFeedServe(viewer, entries, stored.lanes);

    return NextResponse.json({
      entries,
      source: 'recsys',
      ranked: stored.ranked,
      served: entries.length,
      // Honest on both axes: how fresh, and which tier it came off. A feed
      // served from disk after a restart must not read as a warm-cache hit.
      cache: `${stored.origin === 'store' ? 'stored-' : ''}${fresh ? 'fresh' : 'stale-revalidating'}`,
      builtAt: new Date(stored.at).toISOString(),
      nextCursor: cursorOf(entries)
    });
  }

  // ---- NOTHING STORED: the one spinner a reader is ever allowed to see ----

  // A build that just failed will fail again; do not queue another doomed
  // 3-attempt run behind every reload. `?refresh=1` is a deliberate user action
  // and bypasses it.
  if (!forceRefresh && inFailureCooldown(viewer)) {
    return fallback(
      chainObserver, limit, 'unavailable',
      'the last ranked build failed; retrying shortly', topic
    );
  }

  const outcome = await awaitWithPatience(startBuild(), firstBuildPatienceMs());

  if (outcome.settled && outcome.value) {
    // The cold path: this reader waited for the build and is being handed it.
    // Recorded HERE and not inside the build, because the same build also runs
    // to completion for a reader who stopped waiting (see `awaitWithPatience`) —
    // and a page nobody was shown is not an impression.
    recordFeedServe(viewer, outcome.value.entries, outcome.value.lanes);
    return NextResponse.json({
      entries: outcome.value.entries, source: 'recsys', ranked: outcome.value.ranked,
      served: outcome.value.entries.length, cache: 'miss',
      nextCursor: cursorOf(outcome.value.entries)
    });
  }
  if (outcome.settled) {
    return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic);
  }

  // ★ THE FIX FOR THE PERMANENT TRAP. We stopped WAITING; the build did not
  // stop. It runs to completion on its own and writes to `lumen_feed_store`, so
  // this reader's next load is ranked and instant instead of being another
  // 15-second abort that keeps nothing. `degraded` is honest — these are
  // trending posts, and the client already has copy for it.
  logger.info(
    'for-you: first build for %s exceeded %dms of patience — serving trending, build continues',
    viewer,
    firstBuildPatienceMs()
  );
  return fallback(
    chainObserver, limit, 'building',
    'the first ranked build is still running; it will be stored and served instantly on the next load',
    topic
  );
}

/** What an assembled feed is, everywhere below. */
interface BuiltFeed {
  entries: Entry[];
  ranked: number;
  /**
   * ★ THE LANE LABEL, NO LONGER THROWN AWAY (2026-08-08, ruling §7). recsys
   * tells us WHICH LANE surfaced each post (`in_network`, `oon_interest`,
   * `oon_engaged`, `exploration`, `popular_fallback`, …) and what it scored, and
   * until tonight both died with the HTTP response: every stored row matched
   * `has_in_network = f`, `has_oon_interest = f`, `has_exploration = f`. Nobody
   * could say what a feed had CONTAINED, so the weekly balance probe had to
   * re-request eight live feeds (8-35s each) to rediscover what one SQL query
   * should already know. It rides with the entries from here to storage.
   */
  lanes: FeedLane[];
}

/**
 * How long a request will WATCH a first build before answering with trending.
 *
 * ★ WHY 12s AND NOT "RAISE THE TIMEOUT". Against today's measurements (7.2s,
 * 9.3s, 13.2s, 16.3s) this serves `steevc` and `melinda010100` their ranked feed
 * synchronously on the very first request, and hands `gtg` and `lordbutterfly`
 * trending exactly once before they are ranked and instant forever. Raising
 * `RECSYS_FEED_TIMEOUT_MS` instead would have made every cold reader sit longer
 * and still left a wall for whoever is slower than the new number — the wall is
 * the problem, not its height. This number only decides how long a reader stares
 * at a spinner; it can no longer decide whether they EVER get a ranked feed.
 */
function firstBuildPatienceMs(): number {
  const raw = Number(process.env.FEED_FIRST_BUILD_PATIENCE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
}

type Patience =
  | { settled: true; value: BuiltFeed | null }
  | { settled: false };

/**
 * Watch a build for `ms`, then give up WATCHING — never give up BUILDING.
 *
 * The timer is always cleared: a pending 12s timer per fast request would keep
 * handles alive for no reason, and under load that is a real leak.
 */
async function awaitWithPatience(build: Promise<BuiltFeed | null>, ms: number): Promise<Patience> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const patience = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), ms);
  });
  try {
    const raced = await Promise.race([
      build.then((value): Patience => ({ settled: true, value })),
      patience
    ]);
    return raced === 'expired' ? { settled: false } : raced;
  } catch (error) {
    // The build threw rather than returning null. Same outcome for the reader.
    logger.warn('for-you: ranked build threw: %o', error);
    return { settled: true, value: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Everything the ranker needs to know about this viewer, resolved from session
 * VALUES rather than the session itself.
 *
 * ★ THIS USED TO LIVE INSIDE `buildFeed` AND CALL `getLiteSession()`. It cannot
 * any more: builds now outlive their request, and `getLiteSession` reads
 * `next/headers`. Splitting it out is not tidying — it is what makes a
 * background build safe to run after the response has been sent.
 */
async function collectViewerState(
  viewer: string,
  isLite: boolean,
  userId: string
): Promise<{ follows?: string[]; tags?: string[]; mutes?: string[] }> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return {};
  try {
    // ★★ A HIVE READER HAS INTERESTS TOO (2026-08-08). This whole block used to
    // be gated on `isLite`, so a reader signed in with their existing Hive
    // account was ranked with NO interest tags — the picker never even appeared
    // for them (see /api/lite/interests). Their follows come from the chain,
    // which recsys reads via `viewer`, but their PICKS live here and were simply
    // never passed along.
    if (!isLite) {
      const prefs = await findHiveReaderPrefs(viewer);
      const hivePicks = prefs?.interests ?? [];
      // Follows stay empty on purpose: a Hive reader's follow graph is on chain,
      // and recsys reads it from `viewer` itself. `listFolloweesOf` only knows
      // Lumen-local follows, which this reader has none of.
      //
      // ★ AND `mutes` IS OMITTED FOR THE SAME REASON, DELIBERATELY. recsys reads a
      // present-but-empty `mutes=` as "this viewer mutes nobody" and an ABSENT one
      // as "derive it from the chain" (see `recsys/feed-client.ts`). A Hive reader
      // has a real on-chain ignore list; sending them our Lumen block list instead
      // would ERASE it from the ranking. Their blocks are still enforced — by the
      // response filter in `GET`, which needs no cooperation from the ranker.
      return { tags: hivePicks.length > 0 ? tagsForInterests(hivePicks) : undefined };
    }

    const follows = userId ? await listFolloweesOf({ userId }) : [];
    // ★ A LITE VIEWER'S BLOCKS, REACHING THE RANKER. Safe to send here — and only
    // here — because a lite account has no chain identity and therefore no on-chain
    // mute list to overwrite: the Lumen list IS the whole truth for them. Sent even
    // when empty, exactly like `follows`, so recsys does not go looking on chain for
    // a ULID it cannot resolve.
    //
    // This is a RANKING input, not the enforcement point: it stops blocked authors
    // consuming slots in the page recsys builds. Enforcement is the response filter
    // in `GET`, which also covers the stored feed, the fallback and topic pages.
    const mutes = userId ? await listBlockedIdentitiesOf({ userId }) : [];
    // ★★★ THE SIGNUP INTEREST PICKS, FINALLY REACHING THE RANKER.
    //
    // recsys has accepted `explicit_interest_tags` since it was written and
    // nothing ever supplied them. Without these a fresh lite account arrives
    // with no follows, no interests and no history, and recsys correctly serves
    // the cold-start popular lane — measured 2026-08-06: every result came back
    // `popular_fallback`, identically for every new reader.
    //
    // Ids are mapped to real Hive tags here rather than stored as tags, so the
    // taxonomy can be re-tuned (a tag dies, a better one appears) without a
    // migration and without rewriting what readers already chose.
    const user = userId ? await findUserById(userId) : null;
    const picks = user?.interests ?? [];
    return { follows, mutes, tags: picks.length > 0 ? tagsForInterests(picks) : undefined };
  } catch (error) {
    logger.warn('for-you: could not read lite viewer state, ranking without it: %o', error);
    return { follows: [] };
  }
}

/**
 * Ask recsys, retrying ONLY a timeout/transport failure.
 *
 * ★ WHY RETRY AT ALL. `RECSYS_FEED_TIMEOUT_MS` is 15s and a cold viewer was
 * measured at 16.3s end-to-end today, so the first attempt for the slowest
 * readers aborts. The abort is not wasted: recsys keeps a per-viewer profile
 * cache (TTL 300s), so the work the first attempt provoked makes the second one
 * cheap. This is the difference between "sometimes slow" and "never ranked".
 *
 * ★ AND WHY NOT ALWAYS. A `refused` is recsys's deliberate FAIL_CLOSED 503 — its
 * weekly trust snapshot is stale and it will still be stale in 750ms, so
 * retrying would just be three times the load and three times the latency on the
 * one path that is already known-degraded. `unconfigured` is not an error at all.
 * Only `unavailable` is worth a second look.
 */
const RECSYS_ATTEMPTS = 3;
const RECSYS_RETRY_DELAY_MS = 750;

async function fetchRankedWithRetry(opts: {
  viewer: string;
  limit: number;
  follows?: string[];
  mutes?: string[];
  tags?: string[];
}): Promise<RecsysOutcome> {
  let outcome: RecsysOutcome = {
    ok: false,
    reason: 'unavailable',
    detail: 'no attempt was made'
  };
  for (let attempt = 1; attempt <= RECSYS_ATTEMPTS; attempt++) {
    outcome = await fetchRankedFeed(opts);
    if (outcome.ok) {
      if (attempt > 1) {
        logger.info('for-you: recsys answered for %s on attempt %d', opts.viewer, attempt);
      }
      return outcome;
    }
    if (outcome.reason !== 'unavailable') return outcome;
    logger.warn(
      'for-you: recsys attempt %d/%d for %s failed (%s: %s)',
      attempt, RECSYS_ATTEMPTS, opts.viewer, outcome.reason, outcome.detail
    );
    if (attempt < RECSYS_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RECSYS_RETRY_DELAY_MS));
    }
  }
  return outcome;
}

interface AssembleArgs {
  viewer: string;
  limit: number;
  chainObserver: string;
  topic?: string;
  /** A lite viewer's graph lives only in Lumen's Postgres — recsys cannot look
   *  up a ULID on chain, so it is handed over, or they rank as following nobody. */
  follows?: string[];
  /** Same, for the block list — see the note in `collectViewerState` for why this
   *  is sent for a lite viewer and deliberately withheld for a Hive one. */
  mutes?: string[];
  tags?: string[];
}

/**
 * Assemble one viewer's ranked feed: recsys -> hydrate -> order preserved.
 * Returns null when recsys cannot serve, so the caller falls back.
 *
 * ★ TAKES NO SESSION AND TOUCHES NO REQUEST. That is a hard requirement now,
 * not a style preference: this runs on after the response has been sent (see
 * `buildOnce`), and anything reading `next/headers` from there is reading a
 * scope that may no longer exist.
 */
async function assembleFeed(args: AssembleArgs): Promise<BuiltFeed | null> {
  const { viewer, limit, chainObserver } = args;
  const topic = args.topic ?? '';
  const follows = args.follows;
  const mutes = args.mutes;
  let tags = args.tags;

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
  const outcome = await fetchRankedWithRetry({ viewer, limit: overFetch, follows, mutes, tags });
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
  const first = await hydrate(ranked.slice(0, limit), chainObserver);
  const hydrated = first.entries;
  // ★ KEYED BY THE SERVED IDENTITY, WHICH IS NOT ALWAYS THE RANKED ONE. A lite
  // post is ranked under its ULID, lives on chain under the shared publisher
  // account, and is DISPLAYED under its writer's name — `hydrate` is the only
  // place that sees all three at once, so the lane lookup is built there and
  // handed back rather than reconstructed from `RecsysPost` afterwards.
  const postByKey = first.postByKey;
  if (hydrated.length < limit && ranked.length > limit) {
    const shortfall = limit - hydrated.length;
    const topUp = await hydrate(
      ranked.slice(limit, limit + Math.ceil(shortfall * OVER_FETCH_RATIO)),
      chainObserver
    );
    hydrated.push(...topUp.entries);
    for (const [key, post] of topUp.postByKey) postByKey.set(key, post);
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
        // These come off the chain, not the ranker, so they have NO lane — and
        // they are recorded as such (`source: null`) rather than being given a
        // borrowed label. Topic pages are not written to the feed store anyway.
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

  const entries = await mergeLumenEngagement(pool.slice(0, limit));
  if (hydrated.length === 0 && outcome.feed.posts.length > 0) {
    // Ranked results that ALL failed to hydrate is not an empty feed — it is a
    // broken one, and serving a blank page would look identical to "nothing new".
    logger.warn('for-you: %d ranked posts but 0 hydrated', outcome.feed.posts.length);
    return null;
  }

  // ★ BUILT FROM THE FINAL ARRAY, not from the ranker's output. Between recsys
  // and here, posts are dropped by moderation, by a failed chain fetch and by
  // the topic membership filter, and lite posts are re-attributed to their
  // display name. Deriving lanes from `outcome.feed.posts` would therefore
  // produce an array that does not line up with the page anybody sees. A post
  // with no matching `RecsysPost` (a chain top-up on a topic page) records a
  // NULL lane, which is the truth, rather than inheriting its neighbour's.
  const lanes: FeedLane[] = entries.map((entry, index) => {
    const key = `${entry.author}/${entry.permlink}`;
    const post = postByKey.get(key);
    return {
      key,
      source: post?.source || null,
      score: Number(post?.score?.final) || 0,
      rank: index
    };
  });

  return { entries, ranked: outcome.feed.count, lanes };
}

/**
 * What `hydrate` gives back: the posts, and the ranker's own record of each one.
 *
 * ★ THE MAP IS KEYED BY THE SERVED IDENTITY (`author/permlink` as it appears on
 * the card), not the ranked one. For a lite post those differ three ways —
 * ranked as a ULID, stored on chain under the shared publisher account,
 * displayed under the writer's name — and `hydrate` is the only place that holds
 * all three at once. Handing the map back from here is what lets the lane label
 * survive to storage without anyone downstream having to re-derive an identity
 * mapping it does not have.
 */
interface Hydrated {
  entries: Entry[];
  postByKey: Map<string, RecsysPost>;
}

/**
 * recsys returns identity + scores, not content. Fetch the posts and put them
 * back in the ORDER RECSYS CHOSE — that order is the entire product.
 */
async function hydrate(posts: RecsysPost[], observer: string): Promise<Hydrated> {
  if (posts.length === 0) return { entries: [], postByKey: new Map() };
  // Posts lost to a node error rather than deliberately withheld. See the catch below.
  let fetchFailures = 0;

  // A lite post lives on chain under the shared publisher account, so it must be
  // FETCHED as the publisher and DISPLAYED as its real writer. This query answers
  // only the first half — whether Lumen still permits serving it. WHO wrote it is
  // attached further down by `attachLiteIdentities`.
  const litePosts = posts.filter((p) => p.chain_author);
  const servableByKey = new Map<string, boolean>();
  if (litePosts.length > 0 && liteConfig.enabled && liteConfig.databaseUrl) {
    try {
      const mappings = await resolveRankedLiteBatch(
        litePosts.map((p) => p.chain_author as string),
        litePosts.map((p) => p.permlink)
      );
      for (const m of mappings) {
        servableByKey.set(`${m.hiveAuthor}/${m.hivePermlink}`, m.servable);
      }
    } catch (error) {
      // Cannot prove a lite post is still servable => do not serve it. Failing
      // OPEN here would turn a database blip into a way for taken-down content
      // to reappear in the most visible surface in the product.
      logger.error(error, 'for-you: lite resolution failed; dropping lite posts from this page');
    }
  }

  type Pair = { entry: Entry; post: RecsysPost };
  const settled = await Promise.all(
    posts.map(async (p): Promise<Pair | null> => {
      const fetchAuthor = p.chain_author ?? p.author;

      // ★ MODERATION HOLDS HERE. recsys ranks from HAFSQL and has no idea what
      // Lumen has hidden — it will happily rank a post taken down an hour ago,
      // because on chain it is still there. Unknown lite post (no row) is also
      // dropped: it is not something we can vouch for.
      if (p.chain_author && servableByKey.get(`${p.chain_author}/${p.permlink}`) !== true) {
        return null;
      }

      const cacheKey = `${fetchAuthor}/${p.permlink}/${observer}`;
      const cached = cacheGet(cacheKey);
      // ★ RETURNED AS THE CHAIN PRESENTED IT, re-attribution deliberately DEFERRED.
      // `attachLiteIdentities` proves an entry is a given Lumen post by comparing
      // its author against the account the row says signed it — so an entry whose
      // author has already been rewritten can never be identified again. Rewriting
      // here is exactly what stripped every lite post of its identity.
      if (cached) return { entry: cached, post: p };
      try {
        // ONE retry, short backoff. These ~30 calls go out together against a
        // public node, so failures arrive in clusters and are almost always
        // transient (rate limit, blip). Retrying once turns a lost post back
        // into a rendered one; retrying more would turn a real outage into a
        // slow one, which is why it stops at one.
        let fetched = await getPost(fetchAuthor, p.permlink, observer).catch(() => null);
        if (!fetched) {
          await new Promise((r) => setTimeout(r, 250));
          fetched = await getPost(fetchAuthor, p.permlink, observer);
        }
        if (!fetched) return null;
        cachePut(cacheKey, fetched);
        return { entry: fetched, post: p };
      } catch {
        // ★★ A FETCH FAILURE IS NOT A TAKEDOWN (2026-08-09).
        //
        // This returned the same bare `null` as the moderation drop above, so
        // "Lumen refuses to show this" and "the Hive node did not answer just
        // now" were indistinguishable — and both silently shrank the page.
        //
        // Every ranked post costs one `getPost` against a PUBLIC node, ~30 of
        // them fired at once per page. When that node rate-limits or blips, a
        // whole cluster fails together and the reader gets a feed with a handful
        // of posts in it, no error, nothing in the console. Measured by a tester:
        // 2 of 16 fresh loads rendered 3 of 30 cards while a manual re-fetch
        // moments later returned all 30 — the signature of exactly this.
        //
        // Counted so the caller can tell a thin page from a censored one.
        fetchFailures += 1;
        return null;
      }
    })
  );

  const pairs = settled.filter((p): p is Pair => p !== null);
  if (fetchFailures > 0) {
    logger.warn(
      'feed hydrate: %d of %d posts failed to fetch from the Hive node and were dropped — ' +
        'the served page is short by that much. Transient node failure, not moderation.',
      fetchFailures,
      posts.length
    );
  }

  // ★★★ WHO WROTE THIS — THE STEP THIS ROUTE USED TO SKIP ENTIRELY (2026-08-10).
  //
  // Hivemind reports every lite post as authored by the one shared publishing
  // account, so this route rewrote `author` to the writer's handle and stopped
  // there: `_lite` was never set, in this file, ever. A handle is not an identity
  // — a Lumen handle is BY CONSTRUCTION a name that was free on Hive — so
  // everything downstream that needed to know "this is a lite post, by this
  // person" had only an ambiguous string to work from, and four things broke on
  // the product's most visible surface at once:
  //
  //   * BLOCKING. `block-actor.ts` reads an entry with no `_lite` as a HIVE
  //     account and computes `h:<handle>`; the block edge is `u:<ULID>`. They can
  //     never match, so a blocked lite author kept being served — on For You,
  //     the one surface the feature exists for. Its own docstring forbids exactly
  //     this shape.
  //   * TITLE. Hivemind synthesises "RE: <parent title>" for every comment and
  //     every lite post is a container child, so all of them displayed as
  //     "RE: Lumen posts — <date>". The real title is on our row.
  //   * URL. The chain entry's `url` points at the CONTAINER under the publishing
  //     account (`/lumen/@<publisher>/lumen-c-…`), not at the writer's post.
  //   * CURSOR. See `cursorOf`.
  //
  // `attachLiteIdentities` is the helper the post page, the discussion route and
  // the reply lists all already use; this is not a new mechanism, it is the one
  // that was missing a caller. It runs HERE — after the fetch, before any
  // re-attribution — because it authenticates an entry by comparing its author
  // against the account our row says signed it, and that comparison is only
  // possible while the entry still carries the chain author.
  await attachLiteIdentities(pairs.map((p) => p.entry));

  const served: Pair[] = [];
  for (const { entry, post } of pairs) {
    if (!post.chain_author) {
      served.push({ entry, post });
      continue;
    }
    const lite = entry._lite;
    if (!lite?.userId) {
      // ★ FAIL CLOSED, same posture as the servability check above. A lite post we
      // cannot attribute cannot be block-filtered either, so serving it would put
      // an unidentifiable author on the surface where blocking is enforced.
      logger.warn(
        'for-you: dropping lite post %s/%s — its Lumen identity could not be resolved',
        post.chain_author,
        post.permlink
      );
      continue;
    }
    // A COPY. `attachLiteIdentities` mutates in place (adding `_lite` is
    // idempotent and true of the post wherever it is cached), but the DISPLAY
    // fields must not be written onto an object the hydration cache and the Hive
    // post cache both hand to other requests.
    const displayed: Entry = {
      ...entry,
      author: lite.author,
      title: lite.title,
      // Mirrors `render/lite-entry.ts`: the permlink is real, so the link
      // resolves; only the author segment becomes the person a reader sees.
      url: `/${entry.category}/@${lite.author}/${entry.permlink}`
    };
    served.push({
      entry: displayed,
      post
    });
  }

  const postByKey = new Map<string, RecsysPost>();
  for (const { entry, post } of served) {
    postByKey.set(`${entry.author}/${entry.permlink}`, post);
  }

  // ★ THE RANKER IS NOT THE MODERATOR. recsys scores from HAFSQL and will
  // happily rank a banned account's post — it has no idea Lumen refuses to show
  // him. `getPost` already returns null for a banned author, so in practice
  // nothing survives to here; this is the second lock, and it is the one that
  // also keeps him out of what gets WRITTEN to `lumen_feed_store`, so a stored
  // feed can never be built carrying him in the first place.
  //
  // A banned author's key is left in `postByKey`; that is harmless, because the
  // lane array is built by walking the ENTRIES, so a lane can only exist for a
  // post that survived to the page.
  return { entries: filterBannedEntries(served.map((p) => p.entry)), postByKey };
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
async function mergeLumenEngagement(entries: Entry[]): Promise<Entry[]> {
  if (entries.length === 0 || !liteConfig.enabled || !liteConfig.databaseUrl) return entries;
  try {
    const totals = await getEngagementTotals(
      entries.map((e) => ({ author: e.author, permlink: e.permlink }))
    );
    if (totals.size === 0) return entries;
    return entries.map((entry) => {
      const extra = totals.get(`${entry.author}/${entry.permlink}`);
      if (!extra) return entry;
      // ★ COPY, NEVER MUTATE (2026-08-08). The first version of this wrote the
      // merged totals straight onto `entry.stats.total_votes` / `entry.reblogs`.
      // Those post objects do NOT belong to this request — they come out of
      // shared caches (the feed cache here, and the Hive post cache underneath),
      // so every request re-applied the same Lumen votes to the same object and
      // the count CLIMBED on each reload with nobody voting: measured 2, 2, 2, 2,
      // 4, then 4, 4, 4… while the engagement API sat correctly at 1 the whole
      // time. A count that grows when you refresh is worse than one that is
      // merely wrong, because it looks alive.
      return {
        ...entry,
        reblogs: (entry.reblogs ?? 0) + extra.reblogs,
        stats: entry.stats
          ? { ...entry.stats, total_votes: (entry.stats.total_votes ?? 0) + extra.votes }
          : entry.stats
      };
    });
  } catch (error) {
    // A missing Lumen tally must never blank out a working feed — the chain
    // numbers alone are still true, just incomplete.
    logger.warn('for-you: could not merge Lumen engagement counts: %o', error);
    return entries;
  }
}

/**
 * The cursor a client uses to ask for the next page: the last post it was given.
 *
 * ★ IN CHAIN COORDINATES, ALWAYS (2026-08-10). Every page after the first
 * continues down Hive's own feed from this post, so the cursor has to be
 * something HIVE can find. A lite post's displayed author is a Lumen handle,
 * which is not a chain account at all: `bridge.get_ranked_posts` answers
 * `assert_exception — Post <handle>/<permlink> does not exist`, `getRankedPaged`
 * throws, the paging branch swallows it into `{entries: [], nextCursor: null}`,
 * and the reader's infinite scroll simply stops. Verified live against
 * api.hive.blog: `@<handle>/lumen-…` asserts, `@<publisher>/lumen-…` returns a
 * normal page of 20.
 *
 * `_lite.chainAuthor` is the account that actually signed the post — the one
 * identifier on a re-attributed entry that Hive has ever heard of.
 */
function cursorOf(entries: Entry[]): { author: string; permlink: string } | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  return { author: last._lite?.chainAuthor || last.author, permlink: last.permlink };
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
    const merged = await mergeLumenEngagement(posts);
    return NextResponse.json({
      entries: merged,
      source: 'trending-fallback',
      degraded: reason,
      detail,
      nextCursor: cursorOf(merged)
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
