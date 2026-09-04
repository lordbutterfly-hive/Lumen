import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import type { Entry } from '@hive/common-hiveio-packages/wax';
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
import { chainMutedKeysOfActor } from '@/blog/lib/lite/social/chain-mute';
import type { FollowActor } from '@/blog/lib/lite/social/follow-actor';
import { findUserById, findUserByHiveAccountName } from '@/blog/lib/lite/repositories/user-repository';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import { isLumenPermlink } from '@/blog/lib/lite/render/lite-post-id';
import { findHiveReaderPrefs } from '@/blog/lib/lite/repositories/hive-reader-prefs-repository';
import { tagsForInterests } from '@/blog/lib/lite/interests/taxonomy';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { resolveRankedLiteBatch } from '@/blog/lib/lite/repositories/post-repository';
import { liteConfig } from '@/blog/lib/lite/config';
import { filterBannedEntries } from '@/blog/lib/moderation/banned-authors';
import { DEFAULT_OBSERVER } from '@/blog/lib/utils';
import { startTopicWarmer } from '@/blog/lib/feed/topic-warmer';
import { trimEntriesForSeed } from '@/blog/lib/feed/seed-trim';
import {
  TOPIC_CACHE_MAX,
  TOPIC_CACHE_MS,
  attachLanes,
  cursorOf,
  fallbackMemo,
  forgetTopicFeed,
  peekTopicFeed,
  rememberTopicFeed,
  topicKeyFor
} from '@/blog/lib/feed/topic-cache';
import { noteViewerSeen } from '@/blog/lib/feed/viewer-seen';
import type { WarmCandidate } from '@/blog/lib/feed/viewer-seen';
import { startViewerWarmer } from '@/blog/lib/feed/viewer-warmer';
import {
  FEED_FRESH_MS,
  type FeedLane,
  buildOnce,
  feedBands,
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

/**
 * ★ OPT-IN PER-REQUEST TIMING TRACE. Off unless `FEED_TRACE_FILE` is set, and
 * when it is off `timed()` returns the caller's own promise with no wrapper and
 * no clock read — this file's own history is full of whole-request numbers that
 * could not say WHERE the time went, and every previous investigation here had
 * to re-add throwaway file timers to find out (see the 2026-08-11 note at
 * `FALLBACK_CACHE_MS`, which says so explicitly). `AsyncLocalStorage` rather
 * than a module-scope object because this route serves concurrent requests and
 * a shared accumulator would blend two readers' timings into one line.
 */
const TRACE_FILE = process.env.FEED_TRACE_FILE || '';
const traceStore = new AsyncLocalStorage<Record<string, number>>();

function mark(name: string, ms: number): void {
  // Checked before touching the store: `mark` is called unconditionally on the
  // hot path (once per Hive page in `getRankedPaged`), and with tracing off
  // there is no store to look up.
  if (!TRACE_FILE) return;
  const bag = traceStore.getStore();
  if (bag) bag[name] = (bag[name] ?? 0) + Math.round(ms);
}

function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!TRACE_FILE) return fn();
  const started = performance.now();
  return fn().finally(() => mark(name, performance.now() - started));
}

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
 * is no age at which this route goes back to BLOCKING — the old 24h
 * `FEED_STALE_MS` cliff, which sent yesterday's reader back to a 16-second
 * spinner, is deleted. Only a viewer with nothing stored at all waits, and that
 * is the one spinner in the product.
 *
 * ★★★ WHAT AN AGE *DOES* DECIDE, SINCE 2026-08-14: not whether the reader waits,
 * but whether a stored copy may still be PRESENTED AS THIS READER'S RANKING.
 * Past the ceiling it may not, and the reader is served the cached trending page
 * — instantly, labelled `degraded: 'stale'` — while the rebuild continues behind
 * them. Read that as a labelling ceiling, not a return of the cliff: nothing
 * about it reintroduces a spinner, which is the property the paragraph above is
 * actually protecting.
 *
 * ★★★ AND SINCE 2026-08-15, IT IS TWO AGES, NOT ONE (`feedBands`). A single 2h
 * ceiling was answering both "may I present this as your ranking" (18h) and "is
 * this still a ranking at all" (72h, the ranker's own sourcing window), and
 * answering both with the smaller number is why 50 of the 52 stored rows on this
 * box would have been served as trending. Off unless `FEED_BANDS_ENABLED=yes`,
 * in which case both values collapse back to `feedStaleMs()` and this paragraph
 * describes the code exactly as it stood on 2026-08-14.
 *
 * The failure that forced it: recsys is not a deployed service on this box
 * (nothing listening on `RECSYS_FEED_URL`), so a build that succeeded once on
 * 2026-08-11 01:58 UTC wrote a row that could never be replaced. Every request
 * for the next three days served that row as `source: 'recsys'` and advertised a
 * `stale-revalidating` rebuild that could not possibly complete. The route had
 * no way to distinguish a dead upstream from a slow one, and no state for "this
 * ranking is real but far too old", so the artifact simply never expired.
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
/**
 * ★ RAISED 120s -> 300s (2026-08-13). See `TOPIC_FAIL_MS` below for the
 * measurement that forced this pair to be re-thought. A topic page's ranked top
 * 20 is not a per-block quantity: posts arrive in a tag at a rate of minutes to
 * hours, while a cold build of one costs a measured 5,751ms. Five minutes is the
 * longest window over which "the top of #photography has not meaningfully moved"
 * is still an honest claim, and `?refresh=1` (honoured by the topic branch as of
 * this change) is the escape hatch for anyone who needs to skip it.
 */
/** When the ranker last failed to serve a `viewer|topic`. See the branch that writes it. */
const topicFailedAt = new Map<string, number>();
/**
 * How long that failure is trusted before the ranker is tried again.
 *
 * ★★★ RAISED 20s -> 300s (2026-08-13), MEASURED. At 20s this memo was doing
 * almost nothing: signed in on `?tag=hive-110713`, cold 5,751ms, then 12ms /
 * 13ms while the memo held — and **1,518ms again after a 25s idle**, answering
 * `cache=fallback-cached` every time. i.e. any visitor arriving more than 20
 * seconds after the last one paid a second and a half to rebuild the whole
 * viewer state and re-attempt a ranker that then handed back the fallback page
 * it already had. A 20s memory on a feed nobody can rank is a memory of nothing.
 *
 * The value is now EQUAL to `TOPIC_CACHE_MS`, deliberately. The old comment
 * argued the negative deserved a much shorter leash than the positive, but the
 * two answer the same question — "what can recsys serve for this viewer and this
 * tag" — and that is a property of the RANKER's coverage, which changes when the
 * ranker is redeployed or re-indexed, not per Hive block. Giving the negative
 * six times less memory than the positive bought nothing and cost 1.5s a visit.
 * Being wrong here still costs only what it cost before — one topic page serving
 * the trending fallback for a few more minutes after a ranker comes back — and
 * `?refresh=1` clears both memos immediately for anyone who cannot wait.
 */
const TOPIC_FAIL_MS = 300_000;
const topicInflight = new Map<string, Promise<BuiltFeed | null>>();


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
  if (!TRACE_FILE) return handleGet(req);
  const bag: Record<string, number> = {};
  const started = performance.now();
  return traceStore.run(bag, async () => {
    const res = await handleGet(req);
    bag.total = Math.round(performance.now() - started);
    try {
      appendFileSync(TRACE_FILE, `${JSON.stringify({ q: req.nextUrl.search, ...bag })}\n`);
    } catch {
      // A trace that cannot be written must never break the response it measures.
    }
    return res;
  });
}

async function handleGet(req: NextRequest): Promise<NextResponse> {
  const response = await timed('serveForYou', () => serveForYou(req));

  let blockedKeys: Set<string>;
  try {
    const session = await timed('blk_session', () => getLiteSession());
    const actor = await timed('blk_actor', () =>
      viewerBlockActor(session.user?.userId ?? '', session.user?.username ?? '')
    );
    if (actor) {
      // ★ CHAIN MUTES MERGED HERE TOO (owner ruling, 2026-08-12) — a PeakD mute
      // now removes the muted author from this reader's feed exactly like a Lumen
      // block does. See `chain-mute.ts`'s header for why this degrades to "none
      // known right now" on failure rather than failing the whole feed closed —
      // effect (A) is the viewer's own preference, and the existing catch below
      // already accepts an unfiltered feed over none for the SAME reason.
      const [lumenKeys, chainMutes] = await timed('blk_lists', () =>
        Promise.all([listBlockedKeysOf(actor), chainMutedKeysOfActor(actor)])
      );
      blockedKeys = new Set([...lumenKeys, ...chainMutes.keys]);
    } else {
      blockedKeys = new Set();
    }
  } catch (error) {
    // A reader whose block list cannot be read gets an unfiltered feed rather than
    // no feed. Logged, because silently ignoring a block is exactly the shape of
    // bug that gets reported as "blocking does not work".
    logger.warn('for-you: block list unavailable, serving unfiltered: %o', error);
    blockedKeys = new Set();
  }
  // ★ NOTHING BELOW CAN CHANGE THIS READER'S PAGE, so do not pay for it. Parsing
  // and re-serialising the body is real work on a ~300KB response, on the route
  // this file's three longest comments are about — and a reader who has blocked
  // nobody cannot have a block missed. (`withIdentifiableAuthors` therefore also
  // runs only for readers it can protect; see its note.)
  if (blockedKeys.size === 0) return response;

  try {
    const body = (await response.clone().json()) as
      | { entries?: Entry[]; nextCursor?: { author: string; permlink: string } | null }
      | null;
    if (!body?.entries || body.entries.length === 0) return response;
    const identified = withIdentifiableAuthors(body.entries);
    const entries = await filterBlockedForViewer(identified, blockedKeys);
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
 *
 * ★ SCOPE, STATED PLAINLY. This runs only for a reader who has blocked somebody,
 * because it sits behind the same early return the block filter does. A reader with
 * an empty block list can still be served one such stale page — they will see the
 * container's title on those cards until the rebuild lands, which is a cosmetic
 * defect with no one to protect them from. Paying a JSON round trip on every feed
 * request to fix a title for one page is the wrong trade; missing a block is not.
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

/* ------------------------------------------------------------------ */
/* What a feed card actually needs                                     */
/* ------------------------------------------------------------------ */

/**
 * ★★★ 772 KB TO RENDER THIRTY TWO-LINE EXCERPTS — MEASURED 2026-08-10.
 *
 * One `?limit=30` response off this route weighed 958,585 bytes, ~32 KB per post.
 * Broken down by field, across the real thirty:
 *
 *   active_votes   684 KB   73.0%     <- up to 1000 voter records per post
 *   body           189 KB   20.2%     <- full post text, for a two-line dek
 *   json_metadata   37 KB    4.0%
 *   everything else  ~9 KB    0.9%
 *
 * Neither of the top two is rendered. `active_votes` has exactly ONE consumer in
 * the card — `votes-component.tsx` does `post.active_votes.find(e => e.voter ===
 * voter)` to decide whether the signed-in reader has already voted — so every
 * vote by anyone else is shipped to be discarded. Keeping only the reader's own
 * vote is byte-for-byte identical from that component's point of view.
 *
 * `body` has two consumers, both of which read only the start of it:
 * `getPostSummary` -> `extractBodySummary` renders the body, strips it to text and
 * keeps THE FIRST LINE capped at 200 characters; `find_first_img` prefers
 * `json_metadata.image` (27 of the 30 sampled posts resolve there) and only scans
 * the body as a fallback. Measured against those same thirty, a 4000-character
 * head loses ZERO first images and still cuts the field from 190,645 to 95,040
 * bytes — and the head is padded with the first image markup found further down
 * whenever the cut would have dropped it, so a long post cannot lose its
 * thumbnail either.
 *
 * Projected on the measured response: 958,585 -> 161,368 bytes, an 83% cut, with
 * no change to a single pixel. The client wins twice, because `extractBodySummary`
 * renders whatever markdown it is handed — a smaller body is also less work in
 * the browser, on every card, on every render.
 */

/**
 * Strip a feed page down to what its cards read. See the note above for the
 * measurements and for why each field is safe to drop.
 *
 * `viewer` is whose vote to keep. Empty (signed out) keeps none, which is right:
 * there is nobody for the card to highlight the arrows for.
 */
// ★ Shared with the profile posts seed (2026-09-03): one definition of what a
// card seed needs, so the feed and the profile trim identically. See
// lib/feed/seed-trim.ts.
const trimFeedEntries = trimEntriesForSeed;

/**
 * ★ EVERY BRANCH ANSWERS THROUGH HERE, for the same reason the block filter sits in
 * a wrapper: this route already returns from eight places and the ninth will be
 * added by someone who has not read this file. A branch that forgets to trim does
 * not fail loudly — it just quietly ships a megabyte again.
 */
/**
 * ★★★ THE RANKING METADATA REACHES THE CLIENT (2026-08-23).
 *
 * recsys computes a lane and a score for EVERY post it returns
 * (`service/app.py`'s `serialize_scored`: `source`, and
 * `score{vote_norm,rep_norm,organic,final}`), and this route already rebuilds
 * them into `lanes` further down. Until now that array went to
 * `recordFeedServe` and into the `lumen_feed_store.lanes` column and was then
 * DROPPED before the response. So the browser received bare Hive posts and
 * nothing could answer "why is this post first?" — not a debugger, not an
 * explanation string, not an A/B test of a lane budget. The data existed and
 * was thrown away one line early.
 *
 * ★ JOINED ON `key`, NOT ON INDEX, AND THAT IS THE WHOLE CARE HERE. `lanes` is
 * built index-aligned with the BUILT page, and `FeedLane.rank`'s own doc says
 * "the served position can differ". By the time a page is served it has been
 * through `filterBannedEntries`, a `.slice(0, limit)` and possibly the viewer's
 * block filter. Attaching by position would therefore hand entries their
 * NEIGHBOUR's score on any page where something was dropped — a wrong number
 * that looks perfectly plausible, which is worse than no number. `key` is
 * `author/permlink` and survives every one of those filters.
 *
 * ★ `rank` IS REPORTED AS BUILT, not renumbered to the served position. It is
 * the ranker's own output and renaming it to something else would misreport
 * what the ranker decided — see the standing rule that relabelling a number
 * re-opens its proof.
 *
 * ★ NO `reason` FIELD. The audit that asked for this wanted `{score, lane,
 * reason}`. recsys does not compute a reason — grepped, there is no
 * per-candidate justification anywhere in the ranker — so inventing one here
 * would be fabricating an explanation the system never produced.
 */

function feedJson(
  body: Record<string, unknown> & { entries: Entry[]; lanes?: FeedLane[] | null },
  viewer: string,
  init?: { status?: number }
): NextResponse {
  // `lanes` is consumed here and must never be echoed as a top-level array: it
  // would double the payload this function exists to keep small.
  const { lanes, ...rest } = body;
  if (!TRACE_FILE) {
    return NextResponse.json(
      { ...rest, entries: attachLanes(trimFeedEntries(body.entries, viewer), lanes) },
      init
    );
  }
  const t0 = performance.now();
  const trimmed = attachLanes(trimFeedEntries(body.entries, viewer), lanes);
  const t1 = performance.now();
  const res = NextResponse.json({ ...rest, entries: trimmed }, init);
  mark('trim', t1 - t0);
  mark('serialise', performance.now() - t1);
  return res;
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

  // ★★★ `probe=1` — THIS REQUEST IS A MACHINE POLL, NOT A READER LOOKING AT A
  // PAGE (2026-08-15).
  //
  // MEASURED ON THIS BOX, and it is the reason this parameter exists rather
  // than a nicety: the home feed runs a silent poll that fetches a FULL page 1
  // every few minutes per open tab, purely to count how many posts the reader
  // has not seen. Those entries are used only to decide whether to show a
  // button — the reader is shown NONE of them unless they click it — and every
  // one of those polls went through the ordinary stored branch and straight
  // into `recordFeedServe`. The 60s coalesce floor does not stop a 180s poll.
  // Live counts from `lumen_feed_served` on 2026-08-15:
  //
  //   lordbutterfly  2,000 rows over   64 distinct posts = 31.3 impressions/post
  //   gtg            2,000 rows over   58 distinct posts = 34.5
  //   hbd-temp       2,000 rows over   50 distinct posts = 40.0
  //
  // Against a suppression rule of the shape `0.85^impressions`, 0.85^31 is
  // 0.0069 — a 99.3% demotion of a reader's entire feed, bought with pages
  // nobody ever looked at. All three viewers are also at the 2,000-row
  // per-viewer cap, so the machine traffic is evicting their real history.
  //
  // ★ ONE FLAG, ONE MEANING, BOTH LEDGERS. A probe records NEITHER an
  // impression NOR a visit (`noteViewerSeen` below is withheld too). Deciding
  // per-writer which half of "was a person here" a poll satisfies is how the
  // two ledgers drift apart; a single rule is checkable, and it fails safe —
  // the worst case is a reader whose only contact in 48h was a background poll
  // not being warmed, and their next real page load re-marks them.
  //
  // ★ FORGEABLE, AND HARMLESS. A client can set this on a real page load and
  // buy itself FEWER impressions of its own posts — self-harm, and the only
  // direction this flag can be pushed. The inflating direction (reporting
  // impressions somebody else's post did not get, to bury it) is not reachable
  // from here, which is why the rejected alternative — having the client report
  // back which posts it rendered — is strictly worse than this.
  const probe = req.nextUrl.searchParams.get('probe') === '1';

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
    const session = await timed('session', () => getLiteSession());
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

  // ★★★ "THIS READER WAS HERE" — RECORDED ABOVE EVERY BRANCH, ON PURPOSE
  // (2026-08-15). Same argument as the block filter's wrapper: this function
  // answers from six places, and the branch that matters most for this signal is
  // the one a reader hits when their stored ranking is too old — the trending
  // fallback, which records nothing at all today.
  //
  // ★ THAT BLINDNESS IS THE BUG, MEASURED. `recordFeedServe` fires only on the
  // two personal-ranked branches, so a returning daily reader — always served
  // trending because their row is past the ceiling — is INVISIBLE to the served
  // log. For `lordbutterfly` on 2026-08-14 the stored row was rebuilt at
  // 20:03:06Z and the newest served row is 03:52:33Z, sixteen hours earlier. A
  // warmer that looked for activity in the served log would never see the very
  // readers it exists to serve, and one that looked at `built_at` would end up
  // watching itself (see the migration).
  //
  // Detached, never awaited, and withheld for a probe — a reader waits for
  // nothing here, and an activity-log outage costs nothing but a cold cycle.
  if (viewer && !probe) noteViewerSeen({ viewer, isLite, userId });

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
      return feedJson({
        entries: merged,
        source: 'chain-page',
        // ★★★ SAY WHAT THIS PAGE ACTUALLY IS (2026-08-14). Page 1 is ranked and
        // reports `ranked`/`served`/`cache`/`builtAt`; page 2 onward is raw
        // chronological chain paging and reported NONE of those — so the switch
        // of mechanism mid-scroll was invisible to every consumer. A reader
        // scrolls from a personalised list into an unpersonalised one with
        // nothing in the payload marking the boundary.
        //
        // Ranking the whole scroll is not something this route can do: recsys
        // returns ONE scored order with no cursor (see the note on `startAuthor`
        // above), so there is no page 2 to ask it for. That is a real product
        // limitation and the honest response is to LABEL it rather than let
        // `source` be the only, easily-missed clue.
        //
        // `personalised` is deliberately the same field page 1 sets, so a
        // consumer can read one boolean across every branch instead of learning
        // the meaning of five `source` strings. `degraded` is deliberately NOT
        // set: this page is working exactly as designed, and reusing the
        // degradation channel would raise the "ranking is warming up" banner on
        // every scroll.
        personalised: false,
        detail: 'continuation pages are chronological chain paging, not ranked',
        // Through `cursorOf` like every other branch, so the chain-coordinate
        // rule lives in exactly one place and a sixth return cannot forget it.
        nextCursor: cursorOf(merged)
      }, viewer);
    } catch (error) {
      logger.error(error, 'for-you: cursor page failed');
      // ★ 502, NOT AN EMPTY 200 (2026-08-10). A continuation page that failed is a
      // FAILURE, and saying so is what lets the reader's client keep the pages it
      // already has. Answering `{entries: []}` with a 200 told react-query the
      // request succeeded and Hive simply had nothing more — which ends the
      // infinite scroll permanently on one transient node error.
      return NextResponse.json(
        { entries: [], source: 'chain-page', nextCursor: null, error: 'cursor page failed' },
        { status: 502 }
      );
    }
  }

  if (!getRecsysConfig()) {
    return fallback(chainObserver, limit, 'unconfigured', 'RECSYS_FEED_URL is not set', topic, viewer);
  }
  if (!viewer) {
    // Logged out: there is no viewer to personalise for, and recsys ranks
    // against a viewer by definition. Trending is the honest answer here, not a
    // degradation — say so distinctly so it does not pollute the alerting signal
    // for a genuinely broken ranker.
    return fallback(chainObserver, limit, 'anonymous', 'no signed-in viewer to rank for', topic, viewer);
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
    const topicKey = topicKeyFor(viewer, topic);
    // ★ `?refresh=1` REACHES THE TOPIC BRANCH TOO (2026-08-13). It used to be
    // read ~80 lines below this early return, so a topic page had no way to skip
    // its own cache at all. That was tolerable at a 20s TTL and is not at 300s:
    // raising a cache without leaving a way past it is how a stale page becomes
    // unreportable. Same parameter, same meaning, same single caller shape.
    const topicForceRefresh = req.nextUrl.searchParams.get('refresh') === '1';
    if (topicForceRefresh) {
      forgetTopicFeed(topicKey);
      topicFailedAt.delete(topicKey);
    }
    const cached = topicForceRefresh ? undefined : peekTopicFeed(topicKey);
    if (cached) {
      return feedJson({
        entries: cached.entries, lanes: cached.lanes, source: 'recsys', ranked: cached.ranked,
        served: cached.entries.length, cache: 'topic-cached', nextCursor: cursorOf(cached.entries)
      }, viewer);
    }

    // ★★★ REMEMBER THAT THE RANKER CANNOT SERVE THIS TAG (2026-08-13).
    //
    // `rememberTopicFeed` below only runs on SUCCESS, so when recsys cannot serve a
    // tag — which is every tag right now — nothing was ever remembered and each
    // request rebuilt the whole viewer state and re-attempted the ranker before
    // handing back a fallback page that was already cached. Measured signed-in on
    // `?tag=hive-110713`: 2,884ms cold and then a rock-steady 1,524/1,531/1,524ms,
    // every one of them answering `cache=fallback-cached` — i.e. paying ~1.5s to
    // serve something it already had. The plain feed on the same session is 15ms.
    //
    // So the negative gets a short memory of its own. `TOPIC_FAIL_MS` is deliberately
    // much shorter than `TOPIC_CACHE_MS`: a ranker that has just come back should be
    // picked up quickly, and being wrong here costs only that one topic page a stale
    // fallback for a few seconds, never a wrong or missing page.
    const failedAt = topicFailedAt.get(topicKey);
    if (failedAt !== undefined && Date.now() - failedAt < TOPIC_FAIL_MS) {
      return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic, viewer);
    }
    // ★ AND THE SAME ANSWER FOR A TAG THIS PROCESS HAS NEVER SEEN — see
    // `RANKER_DOWN_MEMO_MS`. This is the branch the owner's report is actually
    // about: `topicFailedAt` above can only help a REPEAT visit, so a first
    // visit to any new tag paid a full ranker attempt (and, before the
    // fast-fail fix, 1.5s of backoff) to be told what the previous tag had
    // already established. Skipping it also skips `collectViewerState`'s
    // database round trip, which exists only to feed the ranker.
    if (!topicForceRefresh && rankerIsKnownDown()) {
      return fallback(chainObserver, limit, 'unavailable', 'the ranker is not answering right now', topic, viewer);
    }

    const built = await buildTopicOnce(topicKey, async () => {
      const state = await timed('viewerState', () => collectViewerState(viewer, isLite, userId));
      return assembleFeed({ viewer, limit, chainObserver, topic, ...state });
    });
    if (!built) {
      if (topicFailedAt.size >= TOPIC_CACHE_MAX) {
        const oldest = topicFailedAt.keys().next().value;
        if (oldest !== undefined) topicFailedAt.delete(oldest);
      }
      topicFailedAt.set(topicKey, Date.now());
      return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic, viewer);
    }
    topicFailedAt.delete(topicKey);
    rememberTopicFeed(topicKey, built.entries, built.ranked, built.lanes);
    // ★ NOT RECORDED IN THE SERVED LOG, DELIBERATELY. The log's domain is the
    // PERSONAL ranked page — the thing the demotion will act on and the thing
    // §7's slot budgets are written about. `lumen_feed_served` has no topic
    // column (the requested shape is `viewer, post_key, served_at, position,
    // source`), so mixing #photography rows in would make "their last served
    // page" ambiguous: the newest rows for a viewer might be a topic page they
    // visited once. Excluded on purpose, and named here so a consumer knows the
    // log's boundary rather than discovering it as a gap. Same reason the
    // trending fallback and the chain continuation pages are not recorded.
    return feedJson({
      entries: built.entries, lanes: built.lanes, source: 'recsys', ranked: built.ranked,
      served: built.entries.length, cache: 'topic', nextCursor: cursorOf(built.entries)
    }, viewer);
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
   *
   * ★ THE BODY MOVED OUT TO `buildViewerFeed` (2026-08-15) so the warmer can
   * call the IDENTICAL function rather than a copy of it. See that function.
   */
  const startBuild = (): Promise<BuiltFeed | null> =>
    buildViewerFeed({ viewer, isLite, userId, limit, chainObserver });

  // ---- SERVE DECISION ----
  const stored = forceRefresh ? undefined : await readViewerFeed(viewer);

  if (stored) {
    // ★ THE READER NEVER WAITS. They waited for this feed once and do not get
    // asked twice — every path out of this branch answers immediately.
    //
    // ★★ AMENDED 2026-08-14, because the sentence that stood here ("ANYTHING
    // STORED IS SERVED IMMEDIATELY. Not 'if recent enough'") became false and is
    // worth correcting precisely rather than deleting. Two different promises
    // were being made in one line: "no spinner" and "the stored copy is always
    // the answer". Only the first is the owner's rule, and only the first
    // survives. Past `feedStaleMs` the stored copy is NOT the answer — but the
    // reader still waits for nothing, because what replaces it is the cached
    // trending page, not a rebuild they have to sit through.
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

    // ★★★ AND THE THIRD STATE THIS BRANCH DID NOT HAVE: TOO OLD TO BE A RANKING
    // AT ALL (2026-08-14). See `feedStaleMs`. `age` was computed here already and
    // spent entirely on a cache LABEL — the route knew the artifact was three
    // days old and served it as `source:'recsys'` anyway.
    //
    // ★★★ AND THE FOURTH, ADDED 2026-08-15: OLD, STILL YOURS (the AGING band).
    // One ceiling was answering two different questions — "may I still present
    // this as your ranking" and "is this so old it is no longer a ranking" — and
    // answering both with 2h is why 50 of the 52 stored rows on this box would
    // be served as trending. `feedBands()` splits them; with
    // `FEED_BANDS_ENABLED` unset both values ARE `feedStaleMs()`, the aging band
    // has zero width, and every byte below is what it is today.
    const bands = feedBands();
    const staleCeiling = bands.abandonMs;
    const expired = age >= staleCeiling;
    // Their ranking, still served, but old enough that saying nothing would be a
    // small lie. Unreachable unless the bands are on (see above).
    const aging = !expired && age >= bands.presentMaxMs;

    if (!fresh && !isRebuilding(viewer) && !inFailureCooldown(viewer)) {
      // ★ LOGGED ON BOTH EDGES (requirement: make the revalidation failure
      // VISIBLE). A background refresh that starts and never lands left no trace
      // whatsoever — which is why a dead ranker went unnoticed for three days
      // while every response advertised `stale-revalidating`. The age it was
      // trying to repair is the diagnostic that matters, so it rides along.
      const startedAt = Date.now();
      logger.info(
        'for-you: background refresh started for %s (stored feed is %dms old, ceiling %dms, expired=%s)',
        viewer,
        age,
        staleCeiling,
        expired
      );
      void startBuild()
        .then((built) => {
          if (built) {
            logger.info(
              'for-you: background refresh for %s SUCCEEDED in %dms (ranked=%d) — replaced a feed that was %dms old',
              viewer,
              Date.now() - startedAt,
              built.ranked,
              age
            );
          } else {
            // The case that was silent for three days: the build completed and
            // produced nothing, so the stored artifact stays exactly as stale as
            // it was and the next request advertises another revalidation.
            logger.warn(
              'for-you: background refresh for %s PRODUCED NOTHING after %dms — the ranker did not return a usable feed; the stored copy stays %dms old and will now be served as %s',
              viewer,
              Date.now() - startedAt,
              age,
              expired ? 'DEGRADED (past the staleness ceiling)' : 'stale-revalidating'
            );
          }
        })
        .catch((e) =>
          logger.warn(
            'for-you: background refresh for %s THREW after %dms: %o',
            viewer,
            Date.now() - startedAt,
            e
          )
        );
    }

    // ★★★ PAST THE CEILING THE ARTIFACT IS NOT SERVED. The reader gets fresh
    // trending — cached, instant, and labelled — instead of a frozen ranking
    // wearing a ranking's name. Note what this deliberately does NOT do: it does
    // not make the reader wait for the rebuild. That was the old 24h cliff the
    // owner rejected, and `feedStaleMs`'s note explains the difference at length.
    // The rebuild was started immediately above and continues behind them; the
    // moment it lands, the next request is ranked and instant again.
    //
    // MEASURED before this existed, signed in as the owner: a 71.4-hour-old set
    // whose newest post was 73.9h and whose median was 98.0h, served as
    // `source:'recsys'` with no banner, while the SAME box logged out served a
    // 1.6h/15.0h trending page. A signed-in reader was strictly worse off than a
    // stranger, which is the inversion this closes.
    if (expired) {
      logger.warn(
        'for-you: stored feed for %s is %dms old (ceiling %dms) — refusing to serve it as a ranking, falling back to trending while the rebuild runs',
        viewer,
        age,
        staleCeiling
      );
      return fallback(
        chainObserver,
        limit,
        'stale',
        `the stored ranking is ${Math.round(age / 60_000)} minutes old and is being rebuilt`,
        topic,
        viewer
      );
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
    //
    // ★ EXCEPT FOR A PROBE (2026-08-15). See the `probe` flag above: the silent
    // client poll reaches this exact line every few minutes per open tab and
    // recorded thirty impressions each time for a page the reader is shown none
    // of. This is the whole C-2 fix, and it is one line because the boundary was
    // already in the right place — it was just being crossed by machine traffic.
    if (!probe) recordFeedServe(viewer, entries, stored.lanes);

    return feedJson({
      entries,
      lanes: stored.lanes,
      source: 'recsys',
      ranked: stored.ranked,
      served: entries.length,
      // Honest on both axes: how fresh, and which tier it came off. A feed
      // served from disk after a restart must not read as a warm-cache hit.
      cache: `${stored.origin === 'store' ? 'stored-' : ''}${fresh ? 'fresh' : 'stale-revalidating'}`,
      builtAt: new Date(stored.at).toISOString(),
      // ★ FRESHNESS AS A FIELD, NOT AS AN INFERENCE (2026-08-14). `builtAt` was
      // already here and every consumer ignored it, because using it meant
      // parsing a timestamp and inventing a threshold — so each consumer would
      // have picked its own, or (as happened) none at all. The server owns the
      // threshold and states the verdict. `personalised` is the question the
      // banner actually wants answered and `source` was standing in for it
      // badly: `source` says WHICH MECHANISM produced the list, which is not the
      // same claim as "this is current, ranked, and yours".
      stale: !fresh,
      ageMs: age,
      // ★ THE PRESENTATION CEILING, NOT THE ABANDON ONE — and that choice is the
      // whole wire contract for the aging band. The client's verdict is
      // `now - builtAt < (staleAfterMs ?? RANKING_MAX_AGE_MS)`, so whatever goes
      // in this field BECOMES the client's definition of "current". Sending the
      // abandon ceiling would make a 60-hour-old ranking report itself as
      // current and silence the one line that tells the reader it is being
      // refreshed. With the bands off this is `feedStaleMs()`, exactly as before.
      staleAfterMs: bands.presentMaxMs,
      personalised: true,
      // ★ A SEPARATE FIELD, NOT A `degraded` REASON. `degraded` is the
      // degradation channel, and an aging ranking is a WORKING state — it was
      // built, it is theirs, it is being refreshed. Reusing `degraded` would
      // raise "Personalised ranking is warming up. Showing popular posts
      // meanwhile." over a page that is neither warming up nor popular posts:
      // false twice over. Same reasoning the chain-continuation branch already
      // applies when it sets `personalised: false` and deliberately leaves
      // `degraded` unset. Omitted entirely when false, so a response with the
      // bands off is byte-for-byte what it is today.
      ...(aging ? { aging: true } : {}),
      ...(swapOfferEnabled() ? { swapOffer: true } : {}),
      nextCursor: cursorOf(entries)
    }, viewer);
  }

  // ---- NOTHING STORED: the one spinner a reader is ever allowed to see ----

  // A build that just failed will fail again; do not queue another doomed
  // 3-attempt run behind every reload. `?refresh=1` is a deliberate user action
  // and bypasses it.
  if (!forceRefresh && inFailureCooldown(viewer)) {
    return fallback(
      chainObserver, limit, 'unavailable',
      'the last ranked build failed; retrying shortly', topic, viewer
    );
  }

  // ★★★ THE PATIENCE WINDOW IS PAID ONCE PER BUILD, NOT ONCE PER REQUEST
  // (2026-08-15, measured on production with a virgin account).
  //
  // Before this, a brand-new reader paid it TWICE:
  //     load 1  12,038ms  trending-fallback, degraded:"building"
  //     load 2  11,085ms  recsys, cache:"miss"
  //     load 3      25ms  recsys, fresh
  // ~23 seconds across two page loads before ever seeing a personalised feed.
  //
  // The cause is that `startBuild()` single-flights through `buildOnce`, so the
  // second load JOINS the build the first one started — and then sits in
  // `awaitWithPatience` for another full window waiting on it. The comment below
  // promises "this reader's next load is ranked and instant", which is only true
  // once the build has FINISHED; while it is still running the next load was
  // just as slow as the first.
  //
  // A reader who arrives while a build is already in flight has, by definition,
  // already been told to wait once. Serve them trending immediately instead. The
  // build is untouched — it keeps running, stores its result, and the load after
  // it lands is the 25ms one. `?refresh=1` still waits, because that is a
  // deliberate user action asking for the real thing.
  if (!forceRefresh && isRebuilding(viewer)) {
    logger.info(
      'for-you: a build for %s was already running when this request arrived — serving trending now rather than waiting a second patience window',
      viewer
    );
    return fallback(
      chainObserver, limit, 'building',
      'a ranked build for this reader is already running; it will be stored and served instantly once it lands',
      topic, viewer
    );
  }

  const outcome = await awaitWithPatience(startBuild(), firstBuildPatienceMs());

  if (outcome.settled && outcome.value) {
    // ★ SLICED TO THE REQUESTED LIMIT (2026-08-15). `buildOnce` single-flights by
    // VIEWER and knows nothing about `limit`, so this request can legitimately be
    // handed a build somebody else started — and since today a warm build may be
    // that somebody, it can be a build for `FEED_WARM_LIMIT` rather than for
    // `limit`. The stored branch above has always sliced; this one never did,
    // because before the warmer every build came from a request asking for the
    // same 30. A no-op while `FEED_WARM_LIMIT` is 30, and the thing that stops a
    // 60-entry warm row being served whole the day that number is raised.
    const served = outcome.value.entries.slice(0, limit);
    // The cold path: this reader waited for the build and is being handed it.
    // Recorded HERE and not inside the build, because the same build also runs
    // to completion for a reader who stopped waiting (see `awaitWithPatience`) —
    // and a page nobody was shown is not an impression. That property is what
    // the warmer depends on: it uses this same build function and therefore
    // cannot record anything, because the recording lives out here, on the
    // branch that hands a page to a person.
    if (!probe) recordFeedServe(viewer, served, outcome.value.lanes);
    return feedJson({
      entries: served, lanes: outcome.value.lanes, source: 'recsys', ranked: outcome.value.ranked,
      served: served.length, cache: 'miss',
      // This branch never set `personalised` and relied on the client inferring
      // it from `source === 'recsys'`. It is stated now because the swap offer
      // below is a claim ABOUT it, and an offer resting on an inference is how
      // the three-day-old feed passed the banner test.
      personalised: true,
      ...(swapOfferEnabled() ? { swapOffer: true } : {}),
      nextCursor: cursorOf(served)
    }, viewer);
  }
  if (outcome.settled) {
    return fallback(chainObserver, limit, 'unavailable', 'recsys did not return a usable feed', topic, viewer);
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
    topic, viewer
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
/**
 * ★★★ MAY THE CLIENT OFFER TO SWAP TRENDING FOR A READY RANKING? (2026-08-15)
 *
 * The flag lives on the SERVER and travels as a field, rather than as a
 * `NEXT_PUBLIC_` constant baked into the browser bundle, for two reasons: it can
 * be turned off without rebuilding the client, and it keeps every feed decision
 * in the one place that already owns them. Default off.
 */
function swapOfferEnabled(): boolean {
  return (process.env.FEED_READY_PILL || '').toLowerCase() === 'yes';
}

/**
 * ★★★ 12s -> 2s, AND WHY THE TWO CHANGES ARE ONE SWITCH (2026-08-15).
 *
 * The honest cost of cutting the patience is recorded below: at 12s, `steevc`
 * (7.2s) and `melinda010100` (9.3s) get their ranked feed SYNCHRONOUSLY on their
 * very first request. At 2s they get one trending page instead. That is a
 * regression for the 2-12s cohort and must be called one.
 *
 * It is only acceptable because the trending page now upgrades itself: the
 * reader is offered "your feed is ready" within one poll interval and is one
 * click from the ranking they would otherwise have waited for. Without that,
 * cutting the patience STRICTLY worsens their first session — they lose the
 * ranking and have nothing but a manual reload to get it back.
 *
 * So the two are wired to the same switch instead of being two independent
 * defaults with a note in a document asking an operator to ship them in order.
 * A deployment order that matters is a code invariant, not a memo. An explicit
 * `FEED_FIRST_BUILD_PATIENCE_MS` still wins over both, for an operator who
 * genuinely wants one without the other.
 */
function firstBuildPatienceMs(): number {
  const raw = Number(process.env.FEED_FIRST_BUILD_PATIENCE_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return swapOfferEnabled() ? 2_000 : 12_000;
}

/**
 * ★★★ THE ONE BUILD, USED BY BOTH THE READER'S REQUEST AND THE WARMER
 * (2026-08-15).
 *
 * This is the body that used to be inline in `serveForYou`'s `startBuild`,
 * lifted out unchanged so the warmer can call the SAME function rather than a
 * copy. `loadFallbackPage` makes the identical argument for the topic warmer:
 * "a warmer that assembled its own entry would be one edit away from writing a
 * subtly different shape… and a warmed entry that a reader's branch does not
 * accept warms nothing while looking like it works."
 *
 * Four properties the warm path depends on, all of them already true here:
 *
 *   1. `buildOnce` — a warm build and a reader's own request for the same viewer
 *      COLLAPSE into one, and `isRebuilding(viewer)` sees the warm build, so the
 *      reader's branch does not start a second one behind it.
 *   2. The generation fence — the era is stamped BEFORE any work, so a reader
 *      who saves new interests mid-warm can never be served the preferences they
 *      just replaced. Nothing extra is needed for the warmer; it inherits it.
 *   3. It takes no session and no request. `collectViewerState` was split out
 *      for exactly this reason; the identity arrives as three values.
 *   4. A failed build WRITES NOTHING. `assembleFeed` returning null means the
 *      stored row is untouched, so a warm failure leaves the reader exactly as
 *      they were — never a delete, never a downgrade.
 *
 * ★★★ AND WHAT IT DOES NOT DO: RECORD A SERVE. That is not an omission, it is
 * the contract. Recording lives on the two branches of `serveForYou` that hand a
 * page to a person, and this function is reachable from a timer with no reader
 * attached. If recording ever moved in here, every warm build would mark its
 * whole page seen for somebody who saw none of it.
 */
function buildViewerFeed(opts: {
  viewer: string;
  isLite: boolean;
  userId: string;
  limit: number;
  chainObserver: string;
}): Promise<BuiltFeed | null> {
  const { viewer, isLite, userId, limit, chainObserver } = opts;
  return buildOnce(viewer, async () => {
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

/**
 * ★★★ THE BACKOFF WAS 62% OF A TOPIC PAGE, AND IT WAS SLEEPING ON A SOCKET THAT
 * HAD ALREADY BEEN REFUSED — MEASURED 2026-08-14, PER STAGE, NOT GUESSED.
 *
 * Opening a tag nobody had opened before cost 2,290-3,285ms signed in. Traced
 * through this route stage by stage (`FEED_TRACE_FILE`, see `timed`), on five
 * tags:
 *
 *   recsys_sleep   1,501-1,518ms   <- THIS. Two `setTimeout`s. No work at all.
 *   fb_upstream      770-1,594ms   <- three bridge.get_ranked_posts round trips
 *   recsys_call         4-  11ms   <- all THREE attempts, together
 *   everything else     8-  150ms  <- session, viewer state, engagement merge,
 *                                     block filter, trim, serialise, COMBINED
 *
 * Read those first two lines together: the route slept for a second and a half
 * BETWEEN three attempts that each failed in about two milliseconds. recsys was
 * not slow, it was ABSENT — `ECONNREFUSED` on `RECSYS_FEED_URL` — and the retry
 * loop treated "there is nothing listening" exactly like "it is warming up".
 *
 * The docstring above is right about WHY the retry exists, and that reason is
 * specifically a TIMEOUT: attempt 1 aborts at `RECSYS_FEED_TIMEOUT_MS` having
 * provoked recsys into building the viewer's profile, so attempt 2 rides the
 * profile cache. That story requires the failed attempt to have COST something.
 * A refusal that comes back in 2ms provoked nothing, warmed nothing, and will
 * come back in 2ms again 750ms later — three times the connection attempts and
 * 1.5s of the reader's life for an outcome that is already known.
 *
 * So the gate is the attempt's OWN DURATION, which is the honest discriminator
 * between the two cases and needs no new failure taxonomy: slow failure => the
 * documented retry, unchanged, timeout behaviour byte-for-byte as before; fast
 * failure => there is nothing there, answer the reader now. Anything that fails
 * this fast (connection refused, DNS, an instant 502 from a proxy) is a
 * transport verdict, not a warm-up.
 */
const RECSYS_FAST_FAIL_MS = 1_000;

/**
 * ★★★ "IS THE RANKER ANSWERING" IS A PROPERTY OF THE RANKER, NOT OF THE TAG.
 *
 * `TOPIC_FAIL_MS` a few hundred lines up already makes exactly this argument —
 * "that is a property of the RANKER's coverage... not per Hive block" — and then
 * keys the memo on `viewer|topic`, so it can only ever help the SECOND visit to
 * the SAME tag. The owner's complaint is about the FIRST visit to a tag, which
 * by definition has no per-tag memo, so every new tag re-attempted a ranker that
 * had just refused every other tag on the site.
 *
 * This is the same memo at the granularity the argument actually supports.
 * Deliberately much shorter than `TOPIC_FAIL_MS` (60s vs 300s) because it is a
 * much broader claim — it suppresses the ranker for tags it was never asked
 * about — and because the cost of being wrong is one minute of topic pages
 * serving the chronological fallback they were already serving anyway. It is
 * set ONLY from a genuine ranker-level verdict (`unavailable`/`refused`), never
 * from "this particular tag hydrated nothing", which is a tag fact and belongs
 * in `topicFailedAt`.
 *
 * Success clears it immediately, so a ranker coming back is picked up by the
 * next request rather than after a timer.
 */
const RANKER_DOWN_MEMO_MS = 60_000;
let rankerDownUntil = 0;

function rankerIsKnownDown(): boolean {
  return Date.now() < rankerDownUntil;
}

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
    const startedAt = Date.now();
    outcome = await timed('recsys_call', () => fetchRankedFeed(opts));
    if (outcome.ok) {
      // The ranker is answering. Anything this process learned to the contrary
      // is now stale, and a reader must not keep being sent to the fallback by
      // a memo that a live 200 has just disproved.
      rankerDownUntil = 0;
      if (attempt > 1) {
        logger.info('for-you: recsys answered for %s on attempt %d', opts.viewer, attempt);
      }
      return outcome;
    }
    // A refusal (FAIL_CLOSED 503) and an unreachable ranker are different
    // causes with the SAME consequence for a topic page: no ranked answer
    // exists right now, for this viewer or any other. `unconfigured` is not a
    // failure and is deliberately not recorded.
    if (outcome.reason !== 'unconfigured') rankerDownUntil = Date.now() + RANKER_DOWN_MEMO_MS;
    if (outcome.reason !== 'unavailable') return outcome;

    const elapsed = Date.now() - startedAt;
    logger.warn(
      'for-you: recsys attempt %d/%d for %s failed in %dms (%s: %s)',
      attempt, RECSYS_ATTEMPTS, opts.viewer, elapsed, outcome.reason, outcome.detail
    );
    // See `RECSYS_FAST_FAIL_MS`. A failure this quick provoked no warm-up, so
    // there is nothing for a retry to ride and nothing for a backoff to wait on.
    if (elapsed < RECSYS_FAST_FAIL_MS) {
      logger.warn(
        'for-you: recsys failed in %dms — not a warm-up, not retrying (see RECSYS_FAST_FAIL_MS)',
        elapsed
      );
      return outcome;
    }
    if (attempt < RECSYS_ATTEMPTS) {
      await timed(
        'recsys_sleep',
        () => new Promise((resolve) => setTimeout(resolve, RECSYS_RETRY_DELAY_MS))
      );
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
  const outcome = await timed('recsys', () =>
    fetchRankedWithRetry({ viewer, limit: overFetch, follows, mutes, tags })
  );
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
      rank: index,
      // ★★★ THE TWO FACTS SEEN-SUPPRESSION NEEDS, CAPTURED HERE BECAUSE THIS IS
      // THE ONLY PLACE THEY BOTH EXIST (2026-08-15).
      //
      // `postByKey` is keyed by the SERVED identity and holds the ranker's own
      // record, so this map is the single point in the system where a lite
      // post's display handle, its ranked ULID and its engager count are all in
      // scope at once. One line later the RecsysPost is gone and no downstream
      // consumer can re-derive either — which is exactly how a suppression set
      // built from `key` ends up matching zero Lumen-native posts forever, with
      // no error (contract C8; 46 live rows prove the mismatch is real).
      //
      // ★ `null` WHERE THERE IS NO RecsysPost — a chain top-up on a topic page.
      // That is the truth. Inheriting a neighbour's value, or defaulting the
      // count to 0, would fabricate a baseline and make the resurrection rule
      // strict on data it never had. Same rule the `source` line above already
      // follows.
      rankedKey: post?.key ?? null,
      engagers: typeof post?.engagers === 'number' ? post.engagers : null
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
    /**
     * ★★★ A SECOND PAGE THAT FAILS MUST NOT DESTROY THE FIRST (2026-08-10) —
     * CAUGHT IN THE SERVER LOG, NOT REASONED ABOUT.
     *
     * The feed asks for 30 and Hive caps a request at 20, so this loop always runs
     * twice: 20 posts, then 11. When the SECOND call timed out — wax's own
     * `apiTimeout` is 8000ms and api.hive.blog does miss it — the throw propagated
     * out of here, past `fallback`, into its catch, and the reader was handed an
     * empty feed. Twenty perfectly good posts, already in `out`, thrown away
     * because the top-up was late. Verbatim from this box:
     *
     *   WaxRequestTimeoutError: Request timed out: "POST https://api.hive.blog"
     *     bridge.get_ranked_posts { sort: trending, start_author: "riverflows",
     *                               limit: 11 }
     *   msg: "for-you: fallback to trending also failed (limit=30, tag=(none))"
     *
     * That is the whole mechanism behind the 109-byte empty response, and it is
     * why the empty page looked random: it needed one slow call out of two.
     *
     * A short page is a fine answer; no page is not. So a failure with posts
     * already in hand ends the loop and returns them, and only a failure on the
     * FIRST call — where there is genuinely nothing to serve — still throws.
     */
    let page: Entry[] | null;
    try {
      mark('hive_calls', 1);
      page = await timed('hive_ms', () =>
        getPostsRanked(
          sort,
          tag,
          startAuthor,
          startPermlink,
          observer,
          Math.min(want - out.length + (startAuthor ? 1 : 0), HIVE_RANKED_MAX)
        )
      );
    } catch (error) {
      if (out.length === 0) throw error;
      logger.warn(
        'for-you: top-up page failed after %d posts; serving the short page: %o',
        out.length,
        error
      );
      break;
    }
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

/**
 * ★★★ THE SIGNED-OUT FEED HAD NO CACHE AT ALL (2026-08-10) — MEASURED.
 *
 * Every branch above this one caches: the personal feed has a durable per-viewer
 * store, topics have `topicFeedCache`, hydration has `hydrationCache`. The
 * fallback — which is what EVERY LOGGED-OUT VISITOR gets, on the home page, and
 * what every signed-in reader gets while their first build runs — cached nothing.
 * Each of those requests made two live `bridge.get_ranked_posts` calls (Hive caps
 * a page at 20, the feed asks for 30) with wax's 8000ms timeout on each.
 *
 * Measured on this box: a warm anonymous request took 5.4-6.5s, and under the
 * ordinary contention of a page load those calls TIMED OUT and the reader got a
 * 109-byte empty feed. Three sequential requests, one after another: 503, then 30
 * posts, then 30 posts. The reader's feed was a coin toss on the health of a
 * public node, thirty seconds at a time, for a list that is identical for every
 * signed-out visitor on the site.
 *
 * Trending is the most cacheable thing in the product — one global list, the same
 * bytes for everyone, and no reader can tell a sixty-second-old trending page from
 * a live one. Keyed by observer as well, because Hive scopes what it returns to
 * that observer, so one reader's copy is never handed to another.
 *
 * ★★★ A FRESH TTL IS NOT ENOUGH — THE COLD PATH WAS STILL ON THE REQUEST
 * (2026-08-11), PROFILED, NOT GUESSED.
 *
 * The 60s window above stops a BURST of concurrent visitors from each paying the
 * upstream cost (`fetchFallbackOnce` already collapses those into one call), but
 * every 61st second the VERY NEXT anonymous request — on the home page, the
 * highest-traffic surface in the product — still blocked synchronously on
 * `getRankedPaged`, i.e. on two sequential `bridge.get_ranked_posts` calls against
 * a public node this app does not control.
 *
 * Instrumented directly (temporary file-based timers, since this box's dev-server
 * stdout is a pipe with no second reader): on a QUIET path the two calls together
 * cost 2.3-9.8s — already above the "well under 10s" bar on their own, because
 * each call routinely ran 2-6s through wax against a ~1s direct-curl baseline to
 * the same node. Under the REAL, sustained contention this box carries (multiple
 * agents, a 10-core box regularly at load average 3-5, one dev-server restart
 * observed mid-session), the SAME two calls were measured at 19s, 73s and 90.5s
 * wall clock, and twice failed outright — a fast `WaxError: Unknown request error`
 * at 802ms and a hard `WaxError: Request timed out` at 7.5s — for calls that a
 * direct `curl` to the identical endpoint, run back-to-back six times in the same
 * window, answered in 0.85-4.4s every time. That gap is the node being no slower
 * than advertised while THIS PROCESS, under load, is slower to schedule the
 * callback that notices the response — exactly the kind of tail latency a
 * contended box produces unpredictably, which is precisely why no amount of
 * reordering or parallelising these two calls fixes it: they cannot be
 * parallelised anyway (`getRankedPaged`'s second page needs the first page's
 * cursor — see its own comment), and even a "fast" 2-9s run is not a 200 that a
 * reader on the single highest-traffic route should ever wait on if an answer
 * already exists.
 *
 * There was NO N+1 hydration hiding in this path — checked, not assumed:
 * `fallback()` never calls `hydrate()` (that per-post fetch loop belongs only to
 * `assembleFeed()`, on the signed-in recsys path). `getPostsRanked` does make one
 * extra `getPost` per genuine cross-post, but those run in parallel
 * (`Promise.all` in `resolvePosts`, `packages/transaction/lib/bridge-api.ts`) and
 * were not the measured cost.
 *
 * So the fix is the one already proven twice in this codebase for the identical
 * shape of problem — the personal feed a few hundred lines up (`readViewerFeed`:
 * "ANYTHING STORED IS SERVED IMMEDIATELY... rebuilt behind them") and
 * `apps/blog/lib/lite/retention/streak-cache.ts` (`readStaleStreakCache` +
 * `tryStartRevalidation`): ANY cached copy is served on the request that finds it
 * expired, and a background refresh is kicked — never awaited — to replace it.
 * `FALLBACK_CACHE_MS` still labels a copy `fresh` vs `stale-revalidating`, but it
 * no longer decides whether a reader waits; only "has this key ever been built"
 * does, matching the personal feed's own "no age at which this route goes back to
 * blocking" rule. That is a deliberately UNBOUNDED stale window — not a second,
 * shorter TTL — for the same reason the personal store has none: a reader must
 * never be the one who pays for a slow upstream when a usable answer, however old,
 * is sitting in memory.
 */
const FALLBACK_CACHE_MS = 60_000;
/**
 * ★★★ SIZED AGAINST REAL KEY CARDINALITY (2026-08-11). The key below is now
 * `(sort, tag, chainObserver)` — `limit` no longer multiplies it (see the note
 * at `cacheKey`). `sort` has 2 values. `chainObserver` is `DEFAULT_OBSERVER`
 * for every anonymous/unconfigured caller, which is the overwhelming majority
 * of traffic through this function; it is a real signed-in username only when
 * THAT viewer's own build is degraded, which is bounded by how many real
 * sessions are concurrently degraded, not by anything an anonymous caller can
 * inflate. `tag` is the one attacker-reachable axis — any `[a-z0-9-]{1,64}`
 * string reaches this cache on the anonymous path. `TOPIC_CACHE_MAX` a few
 * lines up is this file's own precedent for "how many distinct tags is
 * realistic" (200); matched here for the same reason rather than invented.
 */
const FALLBACK_CACHE_MAX = 200;
// ★ Process-wide, shared with the topic page's seed (lib/feed/topic-cache.ts).
const fallbackCache = fallbackMemo();
const fallbackInflight = new Map<string, Promise<Entry[]>>();

/**
 * ★★★ TRUE LRU, NOT INSERTION ORDER (2026-08-11) — this was a real eviction
 * bug, found by adversarial review and reproduced here before the fix:
 *
 *   const m = new Map(); m.set('a', 1); m.set('b', 2); m.set('a', 99);
 *   [...m.keys()] // -> ['a', 'b'] — 'a' is still FIRST, despite being
 *                 // written last. `Map.set` on an existing key never moves it.
 *
 * The old version below evicted `keys().next().value` — the oldest INSERTED
 * key — on the unstated assumption that refreshing an entry re-inserts it at
 * the tail. It does not. The home page's key is written ONCE at boot and only
 * ever REFRESHED after that (this function runs again on the same key for
 * every background revalidation), so it was the oldest-inserted key
 * permanently, from the moment a 50th distinct key ever appeared — and the
 * very next insertion evicted it, forever, in a loop: re-inserted at the
 * tail, aged back to the head as everything after it also cycles through, evicted
 * again next time the bound is hit. The hottest key in the product was the one
 * guaranteed to be gone, and any anonymous caller could force that moment on
 * demand just by requesting enough distinct `tag`/`limit` combinations.
 *
 * Fixed with delete-then-set on every WRITE here (a refresh now genuinely
 * moves the key to the tail) and, in `fallback()` below, on every READ too via
 * `touchFallback` — a key that is merely being SERVED, not rewritten, also has
 * to count as recently used, or a key refreshed only once every
 * `FALLBACK_CACHE_MS` would still drift back to "oldest" between refreshes
 * under sustained traffic to OTHER keys. That is real LRU; the previous code
 * was "oldest write wins forever."
 */
function rememberFallback(key: string, entries: Entry[]): void {
  fallbackCache.delete(key); // no-op if absent; makes a re-write move to the tail
  if (fallbackCache.size >= FALLBACK_CACHE_MAX) {
    const oldest = fallbackCache.keys().next().value;
    if (oldest !== undefined) fallbackCache.delete(oldest);
  }
  fallbackCache.set(key, { entries, at: Date.now() });
}

/** Marks `key` as just-used without changing its value — see `rememberFallback` above. */
function touchFallback(key: string): void {
  const hit = fallbackCache.get(key);
  if (!hit) return;
  fallbackCache.delete(key);
  fallbackCache.set(key, hit);
}

/**
 * One upstream fetch per key at a time — a burst of visitors joins one call, and
 * so does a background revalidation racing a synchronous cold-path caller for the
 * same key. This is the ONLY correctness-bearing dedup; a caller checking
 * `fallbackInflight.has(key)` first is purely an optimisation to skip building an
 * unnecessary closure, never required for safety.
 */
function fetchFallbackOnce(key: string, load: () => Promise<Entry[]>): Promise<Entry[]> {
  const running = fallbackInflight.get(key);
  if (running) return running;
  const started = load().finally(() => fallbackInflight.delete(key));
  fallbackInflight.set(key, started);
  return started;
}

/**
 * Build and store ONE fallback page. The single place that decides what a
 * `(sort, tag, observer)` entry contains.
 *
 * ★ THE WARMER GOES THROUGH HERE TOO, and that is the point rather than a
 * convenience. A warmer that assembled its own entry would be one edit away
 * from writing a subtly different shape — a different fetch size, a missing
 * engagement merge — and a warmed entry that a reader's branch does not accept
 * warms nothing while looking like it works. One function, one shape, and the
 * single-flight is shared: a warmer and a reader racing the same key collapse
 * into one upstream call instead of two.
 */
/**
 * ★ A TAG NOBODY HAS EVER USED IS AN ERROR UPSTREAM, NOT AN EMPTY LIST.
 *
 * `bridge.get_ranked_posts` answers an unknown tag with
 * `Assert Exception:Tag <tag> does not exist` (code -32602) rather than `[]`
 * — verified live against api.hive.blog on 2026-08-14, with a real tag
 * returning posts as the control. That throw reaches `getRankedPaged`'s FIRST
 * call, so it rethrows, and the caller cannot tell it apart from Hive being
 * down.
 *
 * Matched on the tag NAME as well as the phrase, deliberately: the sibling
 * assert on the paging path reads `Post <author>/<permlink> does not exist`
 * and is a genuinely different condition that must keep its 503. The wax
 * client's error shape is not contractual, so both the message and a
 * serialised form are searched.
 */
function isUnknownTagError(error: unknown, tag: string): boolean {
  const needle = `Tag ${tag} does not exist`;
  if (error instanceof Error && error.message.includes(needle)) return true;
  try {
    return JSON.stringify(error ?? '').includes(needle);
  } catch {
    // A circular or unserialisable error is not evidence of a missing tag.
    return false;
  }
}

/**
 * ★★★ ONE HIVE PAGE, NOT THREE (2026-08-18, owner: "any topic I pick is 12s").
 *
 * `getRankedPaged` cannot parallelise: each page's cursor comes from the last
 * post of the previous one, so asking for `MAX_LIMIT` (50) against Hive's
 * 20-per-call cap forced THREE sequential round trips to a public node. Measured
 * on this box: ~3.2s per call, and cold topics landed at 5.5s / 7.8s / 9.4s /
 * 12.7s / 14.7s across five real tags.
 *
 * Fetching exactly one page is the whole fix for the first paint. It is safe
 * because this function only ever builds PAGE ONE — continuation pages come
 * straight off the chain from the cursor (see the cursor-page branch above), not
 * from this cache — and because the topic list decides "is there more" from
 * `nextCursor`, never from comparing the page length to the limit it asked for
 * (topic-shell.tsx `getNextPageParam`). A reader gets 20 posts, which is already
 * more than one screen, and scrolling fetches the rest.
 */
const FALLBACK_FETCH_LIMIT = 20;

function loadFallbackPage(sort: string, tag: string, observer: string): Promise<Entry[]> {
  const cacheKey = `${sort}|${tag}|${observer}`;
  return fetchFallbackOnce(cacheKey, async () => {
    const posts = await timed('fb_upstream', () => getRankedPaged(sort, tag, observer, FALLBACK_FETCH_LIMIT));
    const merged = await timed('fb_merge', () => mergeLumenEngagement(posts));
    if (merged.length > 0) rememberFallback(cacheKey, merged);
    return merged;
  });
}

/**
 * ★ WHAT THE WARMER WARMS: a topic page's chronological fallback, under the
 * DEFAULT observer, which is the copy every reader can be served (see the
 * shared-copy note in `fallback`). `created` rather than `trending` because that
 * is what `fallback()` uses for a tag — warming the other sort would fill a key
 * nobody reads.
 */
async function warmTopicFallback(tag: string): Promise<void> {
  await loadFallbackPage('created', tag, DEFAULT_OBSERVER);
}

/**
 * ★ STARTED FROM MODULE SCOPE, DELIBERATELY, rather than from
 * `instrumentation.ts`. This is the only module that reads `fallbackCache`, so
 * the moment this module is loaded is the earliest moment warming can help
 * anybody — and it is loaded by the first request to this route, which on the
 * home page is the first page load of the process. Starting it from the boot
 * hook instead would mean importing a route module from instrumentation to
 * reach a cache that is private to it, for a head start measured in one page
 * load. `startTopicWarmer` is idempotent and no-ops outside the Node runtime.
 */
startTopicWarmer(warmTopicFallback);

/**
 * ★★★ WHAT THE PER-VIEWER WARMER WARMS: one reader's stored ranking, through
 * the same `buildViewerFeed` a reader's own background refresh uses
 * (2026-08-15).
 *
 * The identity comes from `lumen_feed_viewer_seen`, which recorded it at the
 * moment the request read the sealed session cookie — so this never guesses a
 * viewer's tier from their name, and `chainObserver` is derived by the same rule
 * the request path uses a few hundred lines up: a lite handle is not a Hive
 * account, and passing one to the bridge API asserts.
 *
 * ★ `FEED_WARM_LIMIT` MUST BE >= THE CLIENT'S `FOR_YOU_LIMIT` (30). The stored
 * branch treats `stored.builtLimit < limit` as NOT FRESH, so a row warmed at 20
 * would be rebuilt on its first read and the warmer would spend its whole budget
 * producing rows that are stale on arrival — silently, while every log line said
 * it was working. The coupling is stated on both sides; the default is 30.
 */
async function warmViewerFeed(candidate: WarmCandidate, limit: number): Promise<boolean> {
  const { viewer, isLite, userId } = candidate;
  if (!viewer) return false;
  const chainObserver = !isLite ? viewer : DEFAULT_OBSERVER;
  const built = await buildViewerFeed({ viewer, isLite, userId, limit, chainObserver });
  return Boolean(built);
}

/**
 * ★ REGISTERED FROM MODULE SCOPE FOR THE SAME REASON `startTopicWarmer` IS: the
 * builder above closes over `collectViewerState` and `assembleFeed`, and a Next
 * route file may export only route handlers, so they cannot be imported from
 * anywhere else. Registration therefore happens the moment this module is
 * loaded, which is the first feed request the process serves.
 *
 * Idempotent, a no-op outside the Node runtime and during `next build`, and it
 * starts NOTHING unless `FEED_WARM_ENABLED=yes`.
 */
startViewerWarmer(warmViewerFeed);

// Warm the home trending feed at boot so the first anonymous visitor never waits
// on a cold Hive node. Fire-and-forget; a failed warm just means the first visitor
// pays the cost, same as before this line existed.
void loadFallbackPage('trending', '', DEFAULT_OBSERVER).catch(() => undefined);

async function fallback(
  chainObserver: string,
  limit: number,
  reason: string,
  detail: string,
  tag = '',
  /** Whose own vote to keep in `active_votes` — see `trimFeedEntries`. */
  viewer = ''
): Promise<NextResponse> {
  const sort = tag ? 'created' : 'trending';
  // ★★★ NO LONGER KEYED BY `limit` (2026-08-11). `limit` is caller-supplied,
  // clamped 1..50 — keying on it let ONE caller alone create up to
  // `MAX_LIMIT` (50) distinct cache entries for what is otherwise the exact
  // same trending/topic list, a free 50x multiplier on top of whatever `tag`
  // already contributes (see `FALLBACK_CACHE_MAX`'s note). The cache now
  // always holds the `MAX_LIMIT`-sized page for a given `(sort, tag,
  // chainObserver)` and each caller's own `limit` slices it at response time,
  // so one entry serves every limit from 1 to 50 instead of up to 50 entries
  // serving one each.
  //
  // ★ SHOULD AN ANONYMOUS CALLER BE ABLE TO CREATE A KEY AT ALL? Yes,
  // deliberately: the anonymous home page (`tag=''`) is the highest-traffic
  // route in the product and the entire reason this cache exists, and topic
  // fallback (recsys down, reader on `/topics/x`) is a legitimate degraded
  // case for a signed-in OR signed-out reader. Refusing to cache for
  // anonymous callers would turn this back into the unbounded-latency,
  // unbounded-upstream-load route the 2026-08-10/11 comments above measured.
  // The defence against an anonymous caller weaponising that is the LRU fix
  // above (a key that is actually being read cannot be starved out) plus
  // dropping `limit` from the key (removing the cheapest amplification), not
  // withholding caching from anonymous traffic altogether.
  const cacheKey = `${sort}|${tag}|${chainObserver}`;

  // `chainObserver`, never the raw viewer — see the note at its declaration.
  //
  // ★ For a TOPIC we fall back to `created` (newest first) rather than
  // `trending`: a topic page that cannot be ranked should at least be current.
  // Trending within one tag is dominated by a handful of old high-payout posts,
  // which reads as a dead topic.
  // ★ HIVE CAPS THIS AT 20 (2026-08-07). `bridge.get_ranked_posts` asserts
  // `limit = N outside valid range [1:20]` and throws for anything larger, so
  // `getRankedPaged` pages past it internally. This now always asks for
  // `MAX_LIMIT` (50) rather than the caller's own `limit` (previously anywhere
  // from 1 to 50) — see the note above on why the key dropped `limit`; the
  // fetch size has to stop varying with it too, or the cached page would be
  // too short to slice for a caller who asks for more than whoever built it
  // asked for. The throw used to be swallowed by the catch below into an empty
  // 200, so a SIGNED-OUT visitor got "No posts yet" on the home page while the
  // identical call worked everywhere else in the app (every other caller
  // happens to ask for <= 20). Proven directly against api.hive.blog:
  // limit=20 -> 20 posts, limit=30 -> assert_exception.
  const load = (): Promise<Entry[]> => loadFallbackPage(sort, tag, chainObserver);

  const cached = fallbackCache.get(cacheKey);
  if (cached) {
    touchFallback(cacheKey); // LRU: being SERVED counts as recently used, not just being rewritten.
    const fresh = Date.now() - cached.at < FALLBACK_CACHE_MS;
    // ★ THE REQUEST NEVER WAITS ON THIS. Fire-and-forget, single-flighted with any
    // other caller (including a concurrent cold request — see `fetchFallbackOnce`),
    // and its own failure is logged rather than thrown at nobody.
    if (!fresh && !fallbackInflight.has(cacheKey)) {
      void load().catch((error) =>
        logger.warn('for-you: background trending refresh failed for %s: %o', cacheKey, error)
      );
    }
    const sliced = cached.entries.slice(0, limit);
    return feedJson({
      entries: sliced,
      source: 'trending-fallback',
      degraded: reason,
      detail,
      cache: fresh ? 'fallback-cached' : 'fallback-stale-revalidating',
      builtAt: new Date(cached.at).toISOString(),
      personalised: false,
      nextCursor: cursorOf(sliced)
    }, viewer);
  }

  // ---- THE SHARED TOPIC COPY: what makes warming reachable by a signed-in
  // reader at all (2026-08-14).
  //
  // ★★★ THE KEY IS OBSERVER-SCOPED, AND FOR A TOPIC PAGE THAT SCOPING BUYS
  // NOTHING — MEASURED, against api.hive.blog, before this was written.
  // `bridge.get_ranked_posts { sort: 'created', tag }` was run twice per tag,
  // once with `observer: ''` and once with `observer: 'lordbutterfly'` (an
  // account with 22 on-chain mutes), and the two answers were compared field by
  // field:
  //
  //   #photography  identical membership and order; ONE `active_votes` count
  //                 differed by one (a vote that landed between the two calls)
  //   #travel       byte-identical — zero differing fields
  //
  // So `chainObserver` in this key was not protecting a reader from anything; it
  // was giving every signed-in reader a PRIVATE copy of a list that is the same
  // for all of them. That is why warming could not work: a warmer necessarily
  // runs with no session, writes `created|photography|hive.blog`, and the owner
  // — signed in — reads `created|photography|lordbutterfly` and finds it empty.
  //
  // ★ WHY THIS IS SAFE, rather than "the diff looked small". The reason a
  // per-observer fetch could matter at all is that Hivemind drops authors the
  // OBSERVER has muted on chain. This route does not depend on that: `GET`
  // filters every response it returns through the viewer's Lumen blocks AND
  // their chain mutes (`chainMutedKeysOfActor`), by design — "Filtering the
  // assembled response instead makes forgetting impossible". The shared copy
  // therefore reaches the reader having been filtered by the same list
  // Hivemind would have used, just by us instead of by the node.
  //
  // ★ AND IT IS A FIRST-VIEW APPROXIMATION, NOT A REPLACEMENT. What is genuinely
  // observer-derived and not re-derived here is the per-observer annotation set
  // (`blacklists`, `stats.gray`). So the shared copy is served for THIS request
  // only, the reader's own properly-observed copy is fetched behind them, and
  // every later request answers from it. Same stale-while-revalidate posture as
  // the branch above; `cache: 'fallback-shared'` says which one happened rather
  // than letting a shared copy claim to be the reader's own.
  if (tag && chainObserver !== DEFAULT_OBSERVER) {
    const sharedKey = `${sort}|${tag}|${DEFAULT_OBSERVER}`;
    const shared = fallbackCache.get(sharedKey);
    if (shared) {
      touchFallback(sharedKey);
      if (!fallbackInflight.has(cacheKey)) {
        void load().catch((error) =>
          logger.warn('for-you: own-observer topic refresh failed for %s: %o', cacheKey, error)
        );
      }
      const sliced = shared.entries.slice(0, limit);
      return feedJson({
        entries: sliced,
        source: 'trending-fallback',
        degraded: reason,
        detail,
        cache: 'fallback-shared',
        builtAt: new Date(shared.at).toISOString(),
        personalised: false,
        nextCursor: cursorOf(sliced)
      }, viewer);
    }
  }

  // ---- NOTHING CACHED FOR THIS KEY YET: the one case a request actually waits
  // on the upstream node. Every key gets exactly one such reader, ever — after
  // this, the branch above always has something to serve instantly.
  try {
    const merged = await load();
    const sliced = merged.slice(0, limit);
    return feedJson({
      entries: sliced,
      source: 'trending-fallback',
      degraded: reason,
      detail,
      cache: 'fallback',
      builtAt: new Date().toISOString(),
      personalised: false,
      nextCursor: cursorOf(sliced)
    }, viewer);
  } catch (error) {
    // ★★★ A TAG THAT DOES NOT EXIST IS NOT AN OUTAGE (2026-08-14).
    //
    // Reproduced in a real browser on `/topics/zzzznonexistenttagxyz`: the page
    // rendered "We couldn't load this topic just now. Try again in a moment."
    // — a retry prompt for a condition no retry can ever fix — while
    // `topic-shell.tsx` already had the honest "Nothing here yet / No posts
    // carry the tag X" copy sitting unreachable behind it. The chain was
    // upstream assert -> `getRankedPaged` rethrows on its first call -> this
    // catch -> 503 -> the client's `if (!res.ok) throw` -> `isError`.
    //
    // ONLY this one assert is downgraded, and only when a tag was asked for.
    // Everything below keeps its 503: that status is what stops an errored
    // refetch from wiping a reader's rendered feed, and nothing here should
    // weaken it. `nextCursor: null` so the infinite scroll does not then ask
    // for page two of a tag that does not exist.
    if (tag && isUnknownTagError(error, tag)) {
      logger.info('for-you: tag %s does not exist upstream — serving an honest empty page', tag);
      return NextResponse.json(
        {
          entries: [],
          source: 'trending-fallback',
          // ★ `degraded: null`, NOT the ambient `reason` — caught by rendering it:
          // with `degraded` set, `topic-shell.tsx` takes its DEGRADED branch
          // ("Something went wrong on our side… It isn't necessarily empty" plus
          // a Try again button), because `degradedPage` is just
          // `pages.some(p => !!p.degraded)`. Nothing here was degraded: the
          // upstream answered definitively that this tag has no posts, and the
          // ambient reason ("anonymous", i.e. nobody to personalise FOR) says
          // nothing about a tag that does not exist. Null is what routes the
          // reader to the honest "Nothing here yet" empty state.
          degraded: null,
          detail: `no posts carry the tag ${tag}`,
          personalised: false,
          nextCursor: null
        },
        { status: 200 }
      );
    }

    // Loud, because an empty feed and a broken feed look identical to a reader.
    logger.error(error, 'for-you: fallback to trending also failed (limit=%d, tag=%s)', limit, tag || '(none)');

    // ★★★ THIS USED TO BE A 200, AND THAT IS HOW A READER'S FEED GOT WIPED
    // (2026-08-10). Reproduced on this box: three sequential requests to
    // `?limit=30`, no cookie, no interaction — 958,497 bytes / 30 posts, then
    // 958,585 / 30, then 109 bytes and ZERO. The third was this catch: Hive did
    // not answer in time, and we reported that as a perfectly successful page
    // that happens to contain no posts. A client cannot tell those apart, so
    // react-query replaced thirty rendered cards with "No posts yet."
    //
    // 503 is the honest answer and it is also the one that protects the reader:
    // an errored refetch leaves the previous data in place, which is exactly the
    // behaviour we want when the upstream blinks. The body keeps its shape so
    // any consumer that reads `degraded`/`detail` still can.
    return NextResponse.json(
      { entries: [], source: 'trending-fallback', degraded: reason, detail, personalised: false },
      { status: 503 }
    );
  }
}
