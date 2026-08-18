import { NextRequest, NextResponse } from 'next/server';
import { getAccount, getActiveVotes } from '@transaction/lib/hive-api';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { computeStreak } from '@/blog/features/retention/lib/compute-streak';
import { busiestWeekday, countWords, longestGap, longestRun } from '@/blog/features/retention/lib/act-stats';
import { filterEngagers } from '@/blog/lib/moderation/engagement-exclusions';
import {
  ESTABLISHED_VOTER_MIN_RSHARES,
  VOTER_MIN_RSHARES,
  creditedGivers,
  type VoteLike
} from '@/blog/features/retention/lib/credited-givers';
import { daySetCompleteFrom } from '@/blog/features/retention/lib/walk-coverage';
import { computeLeague } from '@/blog/features/retention/lib/compute-league';
import { deriveGate, deriveLeagueInputs, utcDay } from '@/blog/features/retention/lib/derive-league-inputs';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceStreakRate } from '@/blog/lib/lite/antispam/rate-limit';
import {
  finishRevalidation,
  readStaleStreakCache,
  readStreakCache,
  tryStartRevalidation,
  writeStreakCache
} from '@/blog/lib/lite/retention/streak-cache';
import {
  countFeedsReachedWithPrior,
  findHiveWalkCursor,
  listHiveActDays,
  newPeopleIsTrustworthy,
  recordRankMark,
  authoredWordsPercentile,
  sumAuthoredWords,
  type AuthoredWords,
  recordHiveGivers,
  recordHiveWalk,
  type HiveWalkCursor
} from '@/blog/lib/lite/repositories/hive-retention-repository';

const logger = getLogger('app');

/**
 * Chain-derived retention summary for one account — the real source behind the
 * league showcase, byline emblem and profile card (replacing the mock).
 *
 * WHAT THIS ROUTE OWNS vs WHAT THE CLIENT OWNS
 * This returns the LEAGUE layer only: tier/division/standing, the promotion
 * gate meters, tenure, streak and rolling active-weeks — every one of them
 * derived from chain facts, so none of it can be self-inflated. The HABIT layer
 * (XP, daily-task ticks) is deliberately NOT served here: those tasks are
 * partly forgeable by design ("showed up", "read something"), they are cosmetic,
 * and they stay in client storage. Keeping the two layers on different sides of
 * the wire is the anti-farm invariant expressed as architecture.
 *
 * COST CONTROL: one account read, one profile read, two post-list reads, and a
 * vote read over at most VOTE_SAMPLE_POSTS recent posts — then cached in-process
 * for CACHE_TTL_MS. The username is validated before any of it, so this cannot
 * be used to fan arbitrary strings at the Hive API.
 */

const USERNAME_RE = /^[a-z0-9.-]{3,16}$/;
// bridge.get_account_posts asserts `limit = N outside valid range [1:20]` for
// anything above 20 — verified directly against api.hive.blog, not assumed.
const PAGE_SIZE = 20;
const MAX_PAGES = 25; // ⇒ up to 500 items per feed before we stop walking back
const WINDOW_WEEKS = 26; // the rolling window the league's active-weeks arm scores
/**
 * Posts we actually walk voters for.
 *
 * ★ RAISED FROM 3 TO 8 (2026-08-09), because the giver count stopped being a
 * modifier and became the arm. Under the reputation proxy, breadth could only
 * scale the signal between 0.4 and 1.0, so a thin sample cost you at most a
 * multiplier. Now `creditedGivers` IS the engagement keystone, so the sample size
 * is the measurement's resolution: at 3 posts, an account's rank swung on which
 * three things it happened to publish last.
 *
 * It costs upstream calls, not wall-clock — the `getActiveVotes` calls run
 * concurrently under one shared `VOTE_SAMPLE_RESERVE_MS`, so eight finish in the
 * same window three did. On a route that already fans ~50 calls on a miss and
 * caches for 5 minutes, five more is the cheapest accuracy available.
 */
const VOTE_SAMPLE_POSTS = 8;

/**
 * ════ VOTE-BREADTH TRUST FLOORS ════
 *
 * Moved to `features/retention/lib/credited-givers.ts` (2026-08-08). The floors,
 * their measured attacker cost and the reasoning all live there; this route only
 * calls `creditedGivers(votes, user)`. The move exists because a Next App Router
 * route module may only export HTTP method handlers, which meant the single most
 * attack-relevant function in the feature shipped with no test coverage at all —
 * `features/retention/lib/__tests__/ladder.test.ts` now asserts it directly.
 */

// ★ THE CACHE LIVES OUT OF LINE: lib/lite/retention/streak-cache.ts.
//
// It moved there on 2026-08-09 so the daily-goal write could invalidate it. The goal is
// deleted (2026-08-18) and nothing invalidates the cache any more, but the module stays
// where it is: the TTLs, the LRU bound, the negative-cache rule and the
// stale-while-revalidate single-flight all live in it, and a Next App Router route module
// may export nothing but HTTP handlers, so none of that would be testable back in here.

// PERF: this route previously had NO overall deadline — a single slow public
// Hive node turned a ~50-call fan-out into a 639,506ms (10.6 minute) response
// (observed live, GET /api/streak/lordbutterfly). Two bounds now apply together:
// a per-call timeout (one hung fetch can't stall the route forever) and an
// overall wall-clock budget (the route always answers within a predictable time,
// even if every call is individually slow-but-not-hung). A call that times out or
// a budget that runs out mid-walk degrades coverage — it reuses the EXISTING
// `capped` concept (see FeedWalk) rather than inventing a second "partial" idea,
// so a client that already understands `capped`/`activeWeeksIsLowerBound` needs
// no new logic to render this correctly.
const CALL_TIMEOUT_MS = 6_000; // bounds any single upstream Hive call
const REQUEST_BUDGET_MS = 20_000; // bounds the whole route's wall-clock time
/**
 * Wall-clock held back from the feed walks so the vote sample always gets a turn.
 *
 * ★ WHY A RESERVE AND NOT JUST A BIGGER BUDGET. The two steps degrade completely
 * differently, and the budget was being spent by the one that degrades WELL. A
 * truncated feed walk sets `capped` and turns activeWeeks into a declared lower
 * bound — the answer stays honest and the rung moves by at most one. A skipped
 * vote sample produced a bare `0`, which is not a bound but a WRONG MEASUREMENT,
 * and it moved @acidyo three rungs (runtime-proven, see the vote-sample block
 * below). Letting the graceful step starve the brittle one is backwards.
 *
 * One CALL_TIMEOUT_MS: enough for all three getActiveVotes calls, which run
 * concurrently, to have a full attempt each.
 */
const VOTE_SAMPLE_RESERVE_MS = CALL_TIMEOUT_MS;
/**
 * How far PAST the stored `newest_walked` an incremental walk still reads.
 *
 * Not paranoia: Hivemind indexes with a lag, a post edited after publication can
 * shift in the feed, and the stored cursor is a DAY while the walk sees timestamps.
 * Re-reading three days of overlap is one page and it closes all three holes at
 * once. Getting this wrong loses days permanently, because the store is additive and
 * a day never walked is a day never added.
 */
const INCREMENTAL_OVERLAP_MS = 3 * 86_400_000;
/** The window the "N people found you" stat is measured over. */
const NEW_PEOPLE_WINDOW_DAYS = 7;
/** The window "your posts landed in N feeds" is measured over. */
const REACH_WINDOW_DAYS = 7;

interface PostLike {
  author?: string;
  created?: string;
  permlink?: string;
  /**
   * The full markdown, which `bridge.get_account_posts` returns whether we ask for it
   * or not — so the word count (migration 0038) is free at the point of the walk and
   * costs no extra upstream call. Optional because nothing else in this file needs it
   * and a missing body must count as zero words, never break the walk.
   */
  body?: string;
}

/**
 * WHY the walk stopped short of the 26-week window. All three mean the same
 * thing for correctness — activeWeeks is a LOWER bound — but they mean very
 * different things operationally, and the difference is invisible without this:
 *   - 'time_budget': the 20s whole-route clock ran out. This is the common one,
 *     and it is why a daily poster since 2018 can be served activeWeeks: 11.
 *     It says nothing about the account; it says the node was slow today.
 *   - 'call_failed': an upstream page errored or timed out mid-walk; we kept the
 *     progress already made rather than 502 the whole request.
 *   - 'page_cap': MAX_PAGES ran out — the account really does post more than
 *     ~500 items inside 26 weeks. The only variant that is about the account.
 */
type CappedReason = 'time_budget' | 'call_failed' | 'page_cap';

interface FeedWalk {
  items: PostLike[];
  /** Oldest item actually seen, so coverage can be stated rather than assumed. */
  oldestISO: string;
  /** True when MAX_PAGES ran out, a call timed out, or the request budget ran
   *  out before reaching the window — coverage is partial either way. */
  capped: boolean;
  /** Set whenever `capped` is true; null otherwise. */
  cappedReason: CappedReason | null;
  /**
   * The feed RAN OUT of items — we have read it to the beginning of history, not
   * merely as far back as the window.
   *
   * ★ NOT THE SAME AS `!capped`, and the difference is load-bearing for the
   * persisted store. An uncapped walk stops for either of two reasons: it passed the
   * 26-week cutoff, or it exhausted the feed. Only the second one licenses
   * `history_complete`, which is what lets "longest streak ever: 32 days" be a
   * measurement rather than a floor. Conflating them would publish a personal
   * record computed from six months of history as a lifetime figure.
   */
  exhausted: boolean;
}

/**
 * Bound a single upstream call. We don't own the Hive API client (`@transaction`
 * is another lane's package), so this can't cancel the underlying socket — but
 * it stops the ROUTE from waiting on it, which is what turns a hung public node
 * into a bounded response instead of an unbounded one.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Walk one of an account's feeds backwards until it passes the 26-week window or
 * hits the page cap.
 *
 * Why this exists: the first version sampled a single page of 20 and computed
 * active-weeks from it. For anyone prolific, 20 items span two or three weeks, so
 * the league's active-weeks arm was measuring MY SAMPLE SIZE rather than their
 * activity — @blocktrades (2016 account, Hive's founder) scored 5/26 weeks and
 * was gated down to Candle. An arm that silently under-reports demotes real
 * people, which is the exact "overconfident layer" failure we refuse elsewhere.
 * If the cap is hit we report partial coverage instead of extrapolating: the
 * resulting active-weeks is then an honest LOWER bound, never an invented one.
 */
async function walkFeed(sort: string, user: string, cutoffMs: number, deadlineAt: number): Promise<FeedWalk> {
  const items: PostLike[] = [];
  let startAuthor = '';
  let startPermlink = '';
  let oldestISO = '';
  let capped = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    // Overall wall-clock budget check, ahead of every page — not just the page
    // cap. Without this a slow-but-not-hung node (each call answers, just
    // slowly) could still walk all 25 pages and take minutes.
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      return { items, oldestISO, capped: true, cappedReason: 'time_budget', exhausted: false };
    }

    let batch: PostLike[];
    try {
      batch = ((await withTimeout(
        getAccountPosts(sort, user, '', startAuthor, startPermlink, PAGE_SIZE),
        Math.min(CALL_TIMEOUT_MS, remaining),
        `getAccountPosts(${sort})`
      )) ?? []) as PostLike[];
    } catch (err) {
      // A hung/slow/erroring page must not discard everything already walked —
      // that would turn one flaky call late in a long walk into a full 502 for
      // an otherwise-fine request. Once we have SOME progress, degrade to
      // partial (capped) coverage instead of failing the whole walk.
      // Zero progress (page 0 itself failed) is NOT swallowed here — it
      // rethrows so the existing FAIL LOUD contract (502, never cached as
      // "inactive") still holds for a total upstream failure.
      if (items.length > 0) {
        logger.warn(err, 'streak: %s walk for %s stopped early at page %d (partial coverage kept)', sort, user, page);
        return { items, oldestISO, capped: true, cappedReason: 'call_failed', exhausted: false };
      }
      throw err;
    }
    // A paged call echoes the cursor item back as the first element; drop it.
    const fresh = startPermlink ? batch.filter((p) => p.permlink !== startPermlink) : batch;
    // Nothing left: this feed is read to the beginning of history.
    if (fresh.length === 0) return { items, oldestISO, capped: false, cappedReason: null, exhausted: true };

    items.push(...fresh);
    const last = fresh[fresh.length - 1];
    oldestISO = last?.created ?? oldestISO;
    startAuthor = last?.author ?? user;
    startPermlink = last?.permlink ?? '';

    const oldestMs = last?.created ? Date.parse(`${last.created.replace(/[zZ]$/, '')}Z`) : NaN;
    // Reached the target: complete for the span we were asked for, but history
    // older than this exists and was deliberately not read.
    if (Number.isFinite(oldestMs) && oldestMs < cutoffMs) {
      return { items, oldestISO, capped: false, cappedReason: null, exhausted: false };
    }
    if (!startPermlink) return { items, oldestISO, capped: false, cappedReason: null, exhausted: true };
    capped = page === MAX_PAGES - 1;
  }
  return { items, oldestISO, capped, cappedReason: capped ? 'page_cap' : null, exhausted: false };
}

export async function GET(req: NextRequest, { params }: { params: { user: string } }) {
  const user = (params.user || '').toLowerCase();
  if (!USERNAME_RE.test(user)) {
    return NextResponse.json({ error: 'invalid username' }, { status: 400 });
  }

  // ★ A WARM CACHE HIT IS ANSWERED BEFORE THE LIMITER, NOT AFTER IT.
  //
  // The limiter is a Postgres INSERT .. ON CONFLICT. Running it first meant every
  // cached read — the overwhelming majority of traffic, because the retention
  // card fires on essentially every logged-in page load — paid a database
  // round-trip for permission to read a value already sitting in this process's
  // memory. The limiter was the single most expensive thing on the path it exists
  // to protect, and it scaled with page views rather than with cost.
  //
  // WHY AN OVER-BUDGET CALLER STILL CANNOT FARM THIS. The budget exists to bound
  // UPSTREAM AMPLIFICATION (a miss fans ~50 Hive calls) and database cost — not
  // to meter reads of data we already hold. Four properties keep that safe:
  //   1. Populating an entry still requires a MISS, and misses are still metered.
  //      Enumerating N usernames still costs N budget; only re-reading something
  //      already paid for is free.
  //   2. A free re-read reveals nothing new. Hive account existence is public and
  //      unmetered at any public node, so the 200/404 split leaks no secret.
  //   3. The TTL is absolute from `at`, not sliding, so unlimited free reads
  //      cannot hold an entry warm. Refreshing it is a miss, and is charged.
  //   4. Serving a hit is one Map lookup plus a serialization — strictly cheaper
  //      than the previous order, which did the same work PLUS the DB write. This
  //      reorder can only lower per-request cost, never raise it.
  // The net behaviour change is that an exhausted caller degrades to "only what
  // is already computed" instead of a hard 429, and can never obtain anything a
  // within-budget caller had not already paid for.
  // ★ NO PER-REQUEST GOAL READ ANY MORE (2026-08-18). The daily goal used to GATE the
  // streak, so a cached body was only valid for the goal it was computed against and
  // every request — hit or miss — paid an indexed single-row Postgres lookup before it
  // could trust the cache. The goal is deleted (see compute-streak.ts), so the cache is
  // keyed on the account and the TTL alone, and a warm hit now touches no datastore at
  // all.
  const hit = readStreakCache(user);
  if (hit) {
    if (hit.notFound) {
      return NextResponse.json({ error: 'account not found' }, { status: 404, headers: { 'x-cache': 'neg' } });
    }
    return NextResponse.json(hit.body, { headers: { 'x-cache': 'hit' } });
  }

  // ════ STALE-WHILE-REVALIDATE (2026-08-11) ════
  //
  // Measured live, signed in, on the home page: `GET /api/streak/lordbutterfly` took
  // 6.4-15.8s and intermittently 502'd — this widget sits in the LEFT RAIL, so it is on
  // every page. Instrumented the route call-by-call to find out why before touching
  // anything:
  //
  //   - The "~50-call fan-out" the comments above describe is the FIRST-EVER walk for an
  //     account. Once the incremental-walk store (migration 0028) has a cursor, a real
  //     miss makes 3-8 upstream Hive calls, not 50 — that part of the design is already
  //     working. Even a genuine first-ever walk (no stored cursor at all) measured 12
  //     calls / ~8s, not the pathological case.
  //   - What is NOT cheap: a single Hive call to the configured public node routinely
  //     takes 1-6s, and a raw `curl` straight at api.hive.blog for the EXACT call this
  //     route makes (`bridge.get_account_posts`, sort=posts) reproduced an upstream 502
  //     from Hive's OWN infrastructure in 5.4s, unrelated to anything in this file.
  //     `CALL_TIMEOUT_MS` (6s) sits right at the edge of that node's normal latency for
  //     this call shape, so ordinary variance — not hangs — trips it regularly.
  //   - FAIL LOUD is right for the NUMBER (a page-0 failure must never be silently read
  //     as "inactive") but a page-0 failure 502s the ENTIRE response, and the client
  //     retried once on top of that (`retry: 1`, now 0 — see use-retention.ts), doubling
  //     the cost of exactly the requests that were already struggling. A decorative rail
  //     widget cannot be allowed to depend, on every uncached page view, on a single call
  //     to a public node it does not control landing inside a 6-second window.
  //
  // The fix is NOT to weaken FAIL LOUD for what gets COMPUTED or CACHED — an entry is
  // still written only from a real, successful walk (see `computeStreakBody` below,
  // unchanged in that respect). It is to stop making the HTTP RESPONSE wait on that
  // computation once a recent-enough real answer already exists: an entry between
  // `STREAK_TTL_MS` and `STREAK_STALE_TTL_MS` old is served immediately (a real,
  // previously-computed value — never invented, and `provenance.computedAt` on the wire
  // already says exactly how old it is), while a refresh runs in the background,
  // single-flighted per account (`tryStartRevalidation`) so concurrent page views during
  // the stale window trigger at most one upstream walk between them. A background
  // failure is swallowed (logged only) and leaves the existing stale entry in place —
  // the reader sees last-known-good, not an error, and the next view tries again.
  //
  // Only two cases still pay the full synchronous cost, both narrow and both cases where
  // there is genuinely nothing honest to fall back to: an account's true first-ever view
  // (no cache entry at all — this is the FAIL LOUD path, unchanged), and a return visit
  // so much later than `STREAK_STALE_TTL_MS` that even the stale value would be
  // misleading. The per-IP limiter below still guards exactly that synchronous path, same
  // as before — a background revalidation is account-keyed and single-flighted, which
  // already bounds it to at most one attempt per account per stale window regardless of
  // how many readers or IPs are viewing it, so it does not need (and deliberately does
  // not pay) the IP limiter built for the enumeration threat.
  const stale = readStaleStreakCache(user);
  if (stale) {
    if (tryStartRevalidation(user)) {
      computeStreakBody(user)
        .catch((err) => logger.warn(err, 'streak: background revalidation threw for %s', user))
        .finally(() => finishRevalidation(user));
    }
    return NextResponse.json(stale.body, { headers: { 'x-cache': 'stale' } });
  }

  // F-L15: per-IP rate limit on this public, unauth route, now guarding ONLY the
  // expensive path (a cache miss fans ~50 Hive calls). Its own `streak` bucket, NOT
  // the signup funnel's shared `lookup` budget — see enforceStreakRate for why that
  // sharing made the site 429 its own name-availability check. Best-effort: if the
  // limiter's store is unavailable, fall open on the LIMITER only — the cache + LRU
  // bound still cap cost — rather than take the route down.
  try {
    if (!(await enforceStreakRate(getClientIp(req)))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    /* limiter unavailable — proceed; the cache still bounds amplification */
  }

  const result = await computeStreakBody(user);
  return NextResponse.json(result.body, {
    status: result.status,
    headers: result.status === 200 ? { 'x-cache': 'miss' } : undefined
  });
}

/**
 * The actual computation: everything from the feed walk through writing the cache.
 * Pulled out of `GET` so it has exactly one caller-independent shape — a plain result,
 * never a `NextResponse` — and can be `await`ed on the synchronous cold path or fired
 * fire-and-forget as a background revalidation (see the stale-while-revalidate block in
 * `GET`). FAIL LOUD is unchanged: a transient upstream failure still returns 502 and is
 * never cached; only a definitive not-found is cached, and only briefly.
 */
async function computeStreakBody(user: string): Promise<{ status: number; body: unknown }> {
  try {
    const cutoffMs = Date.now() - WINDOW_WEEKS * 7 * 86_400_000;
    const cutoffDay = utcDay(new Date(cutoffMs).toISOString());
    // Absolute deadline for the whole route, computed once so every branch
    // below (both feed walks, and the vote sample after them) shares the same
    // clock rather than each getting its own fresh budget.
    const deadlineAt = Date.now() + REQUEST_BUDGET_MS;
    const walkDeadlineAt = deadlineAt - VOTE_SAMPLE_RESERVE_MS;

    // ════ THE PERSISTED HISTORY (migration 0028) ════
    //
    // ★ FAIL LOUD, NOT "BEST EFFORT" (2026-08-12). This used to swallow-and-degrade like
    // the goal read above, on the theory that a Postgres hiccup should never take a
    // profile page down. That theory does not hold here, because `cursor` decides
    // `firstObservedDayUTC` below — the SOLE gate `deriveLeagueInputs` uses to count
    // observed act-days (see derive-league-inputs.ts: "an empty firstObservedDayUTC
    // counts nothing, rather than counting everything"). A resolved `null` (the cursor
    // row genuinely does not exist yet — a real new account) and a REJECTED read (a
    // transient Postgres error) both used to collapse to the same `cursor = null` here,
    // and nothing downstream can tell "nothing observed yet" from "we don't know" —
    // both render as `observedActDays: 0` → rank 0, "Unranked", for an account that may
    // have years of activity. Worse, that wrong body was then written into the shared
    // cache unconditionally (see `writeStreakCache` below), pinning "Unranked" on a
    // public profile for up to STREAK_TTL_MS + STREAK_STALE_TTL_MS (30 minutes) from one
    // blip.
    //
    // This now follows the same pattern the route already applies to `getAccount` and
    // the posts walk: a THROW is a 502 (never cached, never rendered as a measurement),
    // while a clean resolve — including a legitimate `null` for a brand-new account —
    // proceeds exactly as before. `listHiveActDays` shares the rule for the same reason:
    // it is only reached once a real cursor confirms there is stored history, and losing
    // IT silently would leave `storeCoversWindow` believing the walk can shortcut to an
    // incremental read while `storedDays` quietly contributes zero history — an
    // undercount from the same class of failure, just smaller.
    let cursor: HiveWalkCursor | null = null;
    let storedDays: string[] = [];
    try {
      cursor = await findHiveWalkCursor(user);
      if (cursor) storedDays = await listHiveActDays(user);
    } catch (err) {
      logger.error(
        err,
        'streak: retention history read failed for %s — refusing to compute a rank from an unproven "never observed" cursor',
        user
      );
      return { status: 502, body: { error: 'upstream unavailable', detail: 'retention history' } };
    }

    // ★ HOW DEEP TO WALK, AND WHY IT IS NOT ALWAYS THE WINDOW.
    //
    // Once the store covers the window, re-reading six months of history on every
    // profile view is pure waste — and it is the waste that caused the defect, since
    // it is what makes the 20s clock bite. So when `oldest_walked` is already older
    // than the cutoff, the walk only has to reach `newest_walked` and stop.
    //
    // Otherwise walk toward the cutoff and let the clock bound it. Each visit pushes
    // `oldest_walked` further back; after one or two the window is covered, and it
    // STAYS covered because the cutoff only ever moves forward. That accumulation is
    // the entire fix: no single request has to succeed at reading everything.
    const storeCoversWindow = Boolean(cursor?.oldestWalked && cursor.oldestWalked <= cutoffDay);
    const incrementalFromMs =
      storeCoversWindow && cursor?.newestWalked
        ? Date.parse(`${cursor.newestWalked}T00:00:00Z`) - INCREMENTAL_OVERLAP_MS
        : NaN;
    // Never walk SHALLOWER than the incremental target and never deeper than the
    // window: `max` picks the shallower of the two when the store is caught up.
    const walkFromMs = Number.isFinite(incrementalFromMs) ? Math.max(cutoffMs, incrementalFromMs) : cutoffMs;

    // ★ `getProfileInfo` IS NO LONGER CALLED HERE (2026-08-09). Its only purpose on
    // this route was `formattedReputation`, which fed the engagement proxy. The arm
    // is measured now, so the ladder needs nothing from it and the route makes one
    // fewer upstream call per miss. Reputation is still fetched for the PROFILE
    // BADGE, where it is a Hive fact shown as a Hive fact — via `getAccountFull`,
    // which the profile page already calls. It scores nothing.
    const [accountRes, postsRes, commentsRes] = await Promise.allSettled([
      withTimeout(getAccount(user), CALL_TIMEOUT_MS, 'getAccount'),
      // The walks stop at the RESERVED deadline, not the request deadline — see
      // VOTE_SAMPLE_RESERVE_MS. They report the shortfall as `capped`; the vote
      // sample has no such affordance, so it is the one that gets protected.
      walkFeed('posts', user, walkFromMs, walkDeadlineAt),
      walkFeed('comments', user, walkFromMs, walkDeadlineAt)
    ]);

    // F-L15: distinguish a TRANSIENT upstream failure (the getAccount call rejected)
    // from a DEFINITIVE not-found (it resolved, empty). The former is a 502 and is NEVER
    // cached; the latter is a 404 and IS negative-cached. Previously both returned 404 —
    // so a node outage rendered a real account as "not found", and repeated hits on a
    // genuinely-missing account re-walked every time.
    if (accountRes.status !== 'fulfilled') {
      logger.error(accountRes.reason, 'streak: account read failed for %s', user);
      return { status: 502, body: { error: 'upstream unavailable', detail: 'account' } };
    }
    if (!accountRes.value) {
      writeStreakCache(user, { at: Date.now(), body: null, notFound: true });
      return { status: 404, body: { error: 'account not found' } };
    }

    const account = accountRes.value;

    // FAIL LOUD, never silently. An upstream failure must not be rendered as
    // "this account was inactive" — that would demote a real person on the
    // strength of a network error. The posts walk is load-bearing for both the
    // active-weeks arm and vote breadth, so its failure is a 502.
    if (postsRes.status !== 'fulfilled') {
      logger.error(postsRes.reason, 'streak: posts walk failed for %s', user);
      return { status: 502, body: { error: 'upstream unavailable', detail: 'posts feed' } };
    }
    const postWalk: FeedWalk = postsRes.value;
    const commentsFailed = commentsRes.status !== 'fulfilled';
    const commentWalk: FeedWalk = commentsFailed
      ? { items: [], oldestISO: '', capped: true, cappedReason: 'call_failed', exhausted: false }
      : commentsRes.value;
    const posts = postWalk.items;
    const comments = commentWalk.items;

    const todayUTC = new Date().toISOString().slice(0, 10);

    const walkDays = [...posts, ...comments]
      .map((p) => (p.created ? utcDay(p.created) : ''))
      .filter((d) => d !== '');

    // ════ WORDS AUTHORED, PER DAY (migration 0038) ════
    //
    // The bodies are already in hand — `bridge.get_account_posts` returns them — so this
    // is arithmetic over data the walk paid for, not a new upstream call. It is a TOTAL
    // per day rather than a delta, because the store keeps `GREATEST(stored, incoming)`:
    // the incremental walk re-reads three days of overlap on purpose, and a `+=` would
    // charge those days again on every visit.
    const wordsByDayUTC: Record<string, number> = {};
    for (const item of [...posts, ...comments]) {
      const day = item.created ? utcDay(item.created) : '';
      if (!day) continue;
      const words = countWords(item.body);
      if (words > 0) wordsByDayUTC[day] = (wordsByDayUTC[day] ?? 0) + words;
    }

    // How far back THIS walk proved the day set. `''` means neither feed was bounded,
    // so it is complete for everything the walk was asked to read.
    const walkBoundary = daySetCompleteFrom(
      [
        { capped: postWalk.capped, oldestDayUTC: utcDay(postWalk.oldestISO) },
        commentsFailed
          ? { capped: true, oldestDayUTC: todayUTC }
          : { capped: commentWalk.capped, oldestDayUTC: utcDay(commentWalk.oldestISO) }
      ],
      todayUTC
    );

    // Oldest day this walk is complete from, as an actual day rather than a flag:
    // the boundary when bounded, else the oldest day it actually read.
    const walkOldestSeen =
      [utcDay(postWalk.oldestISO), utcDay(commentWalk.oldestISO)].filter(Boolean).sort()[0] ?? todayUTC;
    const walkCompleteFrom = walkBoundary || walkOldestSeen;

    // ★ THE MERGED DAY SET IS WHAT THE LADDER READS, NOT THIS REQUEST'S WALK.
    //
    // This is the whole point of the store. One request's walk is a newest-first
    // prefix bounded by a 20-second clock; the union of every walk we have ever done
    // is not. @acidyo moving between rung 6 and rung 3 in nine minutes was one walk
    // disagreeing with another walk — and both were subsets of the same union.
    const actDaysUTC = [...new Set([...storedDays, ...walkDays])];

    // Today's authored acts. Chain-derived, exact, and the only thing left on the
    // `today` block now that the goal and the freeze ledger are gone.
    const actsToday = walkDays.filter((d) => d === todayUTC).length;

    // ★ THE FREEZE LEDGER AND THE DAILY GOAL ARE GONE (2026-08-18, owner). Both existed
    // to soften a consecutive-day streak's all-or-nothing cliff; the streak decays now
    // (+1 a day here, -2 a day away, floored at zero) so there is no cliff to soften.
    // What used to sit here: a `readFreezeState` call, a `recordFreezeSpent` write, a
    // `freezeReadFailed` flag that forced the streak's lower-bound floor, and a
    // `readDailyGoalFor` value that decided whether today counted. All deleted, along
    // with their two Postgres tables — see migration 0037. The streak itself is computed
    // below, after `completeFrom` is known, because that boundary is now an INPUT to it
    // rather than a flag applied afterwards.

    // Persist what this walk learned. Fire-and-forget on failure for the same reason
    // the read was: the answer below is already correct without it, and the only cost
    // of a failed write is that the next visit re-walks.
    const historyComplete = Boolean(cursor?.historyComplete) || (postWalk.exhausted && commentWalk.exhausted);
    try {
      await recordHiveWalk({
        hiveAccount: user,
        actDaysUTC: walkDays,
        oldestWalked: walkCompleteFrom,
        newestWalked: todayUTC,
        historyComplete,
        wordsByDayUTC
      });
    } catch (err) {
      logger.warn(err, 'streak: could not persist retention history for %s', user);
    }

    // ★ READ AFTER THE WRITE, ON PURPOSE. The write above is what makes this walk's words
    // part of the union, and the union is the only figure worth printing — a per-request
    // total would say "words in the part of history this request happened to reach".
    //
    // Best-effort: `null` means "we could not measure this", and an ABSENT field renders
    // no line, while a zero would render a false one ("you have written 0 words"). Same
    // rule the rest of the stats block follows.
    let wordsWritten: AuthoredWords | null = null;
    let wordsPercentile: number | null = null;
    try {
      wordsWritten = await sumAuthoredWords(user);
      wordsPercentile = await authoredWordsPercentile(wordsWritten.all);
    } catch (err) {
      logger.warn(err, 'streak: could not read authored volume for %s', user);
    }

    // ★ COMPLETENESS IS NOW A UNION, AND IT IS NARROWER THAN `capped`.
    //
    // The old rule was "anything truncated ⇒ activeWeeks is a lower bound", which
    // marks a walk that read THIRTY weeks inexact for a 26-week window. The real
    // question is whether the boundary falls INSIDE the window. Combined with the
    // store, `completeFrom` moves back on every visit until it clears the cutoff, and
    // then it never comes back inside — so this flag goes false and stays false.
    const storeOldest = cursor?.oldestWalked ?? '';
    let completeFrom = walkBoundary;
    if (completeFrom !== '' && storeOldest !== '' && storeOldest < completeFrom) {
      completeFrom = storeOldest;
    }
    const activeWeeksIsLowerBound = completeFrom !== '' && completeFrom > cutoffDay;

    // ════ THE STREAK ════
    //
    // ★ IT ACCUMULATES FORWARD FROM THE DAY LUMEN STARTED COUNTING YOU, NOT BACKWARD
    // FROM TODAY. +1 for a day with an authored act, -2 for a day without one, floored
    // at zero (compute-streak.ts owns the rule and the reasoning). A decay has to start
    // somewhere with a KNOWN value, and the only day whose value is known is the day the
    // account was first observed — everybody is zero then, which is the same rule the
    // RANK already uses (`firstObservedDayUTC` below, and /ranks says it in as many
    // words). Starting anywhere else would make the number a floor rather than a
    // measurement, because unread history could only ever have added to it.
    //
    // `completeFrom` is the oldest day the merged day set is COMPLETE from. When it is
    // later than the first observed day — an account nobody has viewed for longer than
    // the walk window, so there is a hole in the middle — the count has to start at the
    // hole's edge and `isLowerBound` says so. That is the only remaining source of a
    // streak floor; the freeze ledger that used to force one is gone.
    const observedFromUTC = cursor?.firstBuiltAt ? utcDay(cursor.firstBuiltAt.toISOString()) : '';
    // ★★★ AN ABSENT CURSOR MEANS "WE STARTED WATCHING TODAY", NOT "WE HAVE ALWAYS BEEN
    // WATCHING" — the streak must FAIL CLOSED for exactly the reason the rank does.
    //
    // `cursor` is read BEFORE the walk, so it is null on an account's first-ever view.
    // Without this fallback the accumulation would start at the oldest ACT DAY in the
    // union — up to 26 weeks of imported Hive history — and a daily poster would be shown
    // a ~180-day streak on their first request and ~1 on their second, once
    // `recordHiveWalk` had written a cursor stamped today. That is the same shape as the
    // bug that put @gtg, @tarazkp and @lordbutterfly on rank 8 of 9 before they had done
    // anything here (see `firstObservedDayUTC` below), and it would have been worse: a
    // number that is large once and then collapses reads as the product taking something
    // away.
    //
    // `todayUTC` is not a guess — it is precisely what the cursor `recordHiveWalk` just
    // wrote will say (`first_built_at DEFAULT now()`), so the first view and every view
    // after it agree by construction, with no second read.
    //
    // The RANK deliberately keeps the raw `observedFromUTC`: `deriveLeagueInputs` treats
    // an empty value as "nothing observed" and returns rank 0, which is its own documented
    // fail-closed rule, and quietly handing it today's date would start counting a day it
    // has never counted before.
    const streakObservedFrom = observedFromUTC || todayUTC;
    const streakCountFrom = completeFrom && completeFrom > streakObservedFrom ? completeFrom : streakObservedFrom;
    const streak = computeStreak({
      actDaysUTC,
      todayUTC,
      countFromUTC: streakCountFrom,
      observedFromUTC: streakObservedFrom
    });

    // Distinct voters over a bounded sample of recent posts. Sampled, not total —
    // labelled as such in the response so nobody reads it as lifetime breadth.
    //
    // ★★★ THIS STEP USED TO "GIVE WAY UNDER TIME PRESSURE" BY PUBLISHING A ZERO,
    // AND A ZERO HERE IS A THREE-RUNG DEMOTION (runtime-proven 2026-08-08).
    //
    // The original note said the vote sample is "a bounded secondary metric, so it
    // is the one that gives way under time pressure". Giving way is right; giving
    // way SILENTLY is what broke. When the two feed walks ate the 20s budget,
    // `budgetLeft` went to ~0, every getActiveVotes timed out, `sampledVotes` came
    // back empty — and an empty sample is indistinguishable from "nobody has ever
    // voted for you". `distinctGivers` then went to 0, breadth to 0, and the
    // engagement arm was multiplied by its 0.4 floor.
    //
    // Measured on the live production build, same account, nine minutes apart,
    // nothing about the account changed:
    //
    //   15:33:56  @acidyo  rung 6 (torch)  comments walk read 500 items
    //   15:42:53  @acidyo  rung 3 (smoke)  comments walk read 260 items
    //
    // Three rungs, from a Hive node being busy. 0.7447 (acidyo's proxy) × 0.4 =
    // 0.2979, which lands one thousandth below the 0.3 band edge — and the body
    // still reported `distinctGivers: 0` inside `provenance.sampled` with no flag
    // of any kind, so the profile would have read "0 people have engaged with your
    // posts" for an account whose real sample is 544.
    //
    // Two changes, and they are the same two the route already applies to the feed
    // walks — it simply never applied them here:
    //
    //   1. RESERVE budget for this step instead of letting the walks spend all of
    //      it. The walks degrade gracefully and say so (`capped`); this step had no
    //      such affordance, so it must not be the one starved. The walks now run
    //      against `walkDeadlineAt`, which is the request deadline minus the
    //      reserve.
    //   2. FAIL LOUD when the sample could not be taken at all. The route already
    //      does exactly this for the posts walk, and for exactly this reason: "an
    //      upstream failure must not be rendered as 'this account was inactive' —
    //      that would demote a real person on the strength of a network error."
    //      A vote-sample failure demotes harder than a posts-walk failure does.
    //
    // An account with NO posts to sample is not a failure — it has no engagement
    // because it has published nothing, which is a fact and not a network error.
    const budgetLeft = deadlineAt - Date.now();
    // ★ BOUNDED BY THE WINDOW, NOT JUST BY COUNT (2026-08-09). `slice(0, N)` took
    // the N most recent posts whatever their age, so an account that last published
    // 18 months ago was scored on 18-month-old votes and read as currently engaged.
    // The presence arm measures the last 26 weeks; the engagement arm now measures
    // the same 26 weeks, so the two halves of "is anyone reading you" finally agree
    // about WHEN. An account with nothing in the window measures zero received
    // engagement, which is a fact about the window and not a failure to read.
    const inWindow = (p: PostLike): boolean => {
      if (!p.created) return false;
      const ms = Date.parse(`${p.created.replace(/[zZ]$/, '')}Z`);
      return Number.isFinite(ms) && ms >= cutoffMs;
    };
    const windowPosts = posts.filter(inWindow);
    const sampleable = windowPosts.filter((p) => p.permlink);
    const voteTargets = budgetLeft > 0 ? sampleable.slice(0, VOTE_SAMPLE_POSTS) : [];
    const voterSets = await Promise.allSettled(
      voteTargets.map((p) =>
        withTimeout(getActiveVotes(user, p.permlink as string), Math.min(CALL_TIMEOUT_MS, budgetLeft), 'getActiveVotes')
      )
    );
    // Every vote from the sample, flattened. Trust filtering happens once, in
    // creditedGivers — a raw distinct-voter count is never used for scoring.
    // `voteReadsOk` counts calls that ANSWERED, which is not the same as calls
    // that returned votes: a post that genuinely has no votes answers with `[]`,
    // and that is a measurement of zero, not a failure to measure.
    const sampledVotes: VoteLike[] = [];
    let voteReadsOk = 0;
    // ★★ THE TWO EXCLUSION LISTS ARE APPLIED HERE, AT THE SOURCE (owner ruling,
    // 2026-08-09: "the global blacklist and the engagement exclusion list we made should
    // be taken out of the final numbers").
    //
    // Every downstream number — the credited-giver ARM, the headcount, the stored giver
    // set, `newPeople`, the first-time-giver nudge — reads `sampledVotes`. Filtering once
    // here is the only way they cannot disagree about who counts as a person. Doing it per
    // consumer is how the feed and the ladder came to hold different opinions in the first
    // place: the recsys unions exactly these two lists into the set every ranking signal
    // reads (`pipeline.py:1412`), and the ladder was reading raw voters.
    //
    // A bot vote is NOT a measurement failure — it is a measured non-person — so the
    // filtered read still counts toward `voteReadsOk`. Conflating the two would make a
    // post voted on only by @hivebuzz look like an unread post and trip the majority
    // guard below.
    let excludedVoters = 0;
    for (const r of voterSets) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      voteReadsOk++;
      const { kept, removed } = filterEngagers(r.value as VoteLike[], (v) => v.voter);
      excludedVoters += removed;
      for (const v of kept) sampledVotes.push(v);
    }
    if (excludedVoters > 0) {
      logger.info(
        'streak: dropped %d bot/banned votes from the engagement arm for %s (global blacklist + engagement exclusion list)',
        excludedVoters,
        user
      );
    }
    // ★★ A PARTIALLY-FAILED SAMPLE COLLAPSES THE RANK, AND THE OLD GUARD LET IT THROUGH
    // (found 2026-08-09 by a UX agent driving the live route under load).
    //
    // The guard used to be `voteReadsOk === 0`. That catches a total outage and misses
    // the far more common case: SOME of the concurrent `getActiveVotes` calls time out,
    // the rest answer, and the credited-giver count comes back a fraction of the truth.
    // Since removing reputation, that count IS the engagement arm — so a partial read
    // does not soften the rank, it craters it.
    //
    // Measured on @tarazkp through this route, minutes apart, nothing about the account
    // changed:
    //
    //   healthy sample   8 of 8 reads   people 1727   rank 8 (aurora)
    //   under load       partial        people   28   rank 4 (lantern)
    //
    // Four rungs, from Hive nodes being busy — the exact failure the reserve and the
    // fail-loud rule were introduced to stop, reappearing one level up because the
    // threshold was "all" instead of "most". A majority is required now: below that the
    // arm is not measured, and an unmeasured arm must 502 rather than publish a number
    // that demotes a real person.
    const voteReadsNeeded = Math.ceil(voteTargets.length / 2);
    if (sampleable.length > 0 && voteReadsOk < voteReadsNeeded) {
      logger.error(
        'streak: vote sample too thin for %s (%d of %d reads answered, needed %d, %dms budget left) — refusing to publish a rank computed from a partially-measured engagement arm',
        user,
        voteReadsOk,
        voteTargets.length,
        voteReadsNeeded,
        budgetLeft
      );
      return { status: 502, body: { error: 'upstream unavailable', detail: 'vote sample' } };
    }
    // `user` is passed so the author's own upvote is not counted as one of the
    // distinct people who engaged with them — see creditedGivers' docstring, and
    // the shipped /ranks copy it was contradicting ("Voting for yourself" is
    // listed under "What does not move you. At all.").
    const givers = creditedGivers(sampledVotes, user);

    // ════ THE VOTE-AMOUNT STATS ARE GONE, ALL OF THEM (owner ruling, 2026-08-09) ════
    //
    // "vote amounts dont matter, theyre all botted." And: "you cant list votes and
    // comments and not have it for all time. if thats the case then drop it."
    //
    // Four lines are deleted rather than repaired, and each was independently indefensible:
    //
    //   votesReceived      `postEngagement(windowPosts).votesReceived` — a sum of
    //                      `total_votes` over the WHOLE 26-week walk. Botted end to end,
    //                      and measured swinging 86,324 -> 24,528 -> 115,781 on @tarazkp
    //                      across 35 minutes with no new posts.
    //   bestPostVotes      the same currency, one post.
    //   postsRead/         "N of the last N posts got engagement." Not structurally
    //   postsWithEngagement always 100%, but the sample is the 8 MOST RECENT posts and on
    //                      a chain with curation trails that is 100% for anyone with an
    //                      audience — 5 of 5 accounts a tester checked (2/2, 6/6, 8/8,
    //                      4/4, 8/8). A line that cannot vary carries no information.
    //   footnote           "Counted across the last 8 posts." It sat under all of the
    //                      above while `votesReceived` came from hundreds of posts, so
    //                      the caveat named the wrong denominator: @tarazkp read "1731
    //                      people" + "At least 115800 votes" + "the last 8 posts", whose
    //                      arithmetic ceiling is 1731x8 = 13,848. Three numbers, no
    //                      reading under which all three are true.
    //
    // What survives is a headcount of PEOPLE with both exclusion lists applied, which is
    // the one engagement figure that is neither a vote amount nor farmable by volume. Its
    // scope now lives in its own sentence and in a tooltip, not in a distant footnote.
    const pattern = busiestWeekday(actDaysUTC);

    // ── BROADCASTER OR CONVERSATIONALIST ─────────────────────────────────────
    //
    // Free: the route already walks the posts feed and the replies feed separately, and the
    // split between them was being thrown away at the `walkDays` merge. It is the most
    // identity-defining fact available about a Hive account — most people are certain they know
    // which one they are and most are wrong.
    //
    // ★★ THE COUNTS GO ON THE WIRE AND ONLY THE RATIO IS EVER PRINTED. "you cant list votes and
    // comments and not have it for all time" — and these are 26-week counts, so printing "412
    // replies" would break exactly that rule. A RATIO is not a total: it is a shape, stable
    // whatever the window, and "replies 4x for every post" says something a count never could.
    const postsInWindow = windowPosts.length;
    const repliesInWindow = comments.filter(inWindow).length;

    // ★ THE LONGEST SILENCE. Free from `actDaysUTC`, which is already in hand, and the one
    // pattern fact worth publishing: everybody has a rough idea of their best streak and nobody
    // knows their longest quiet spell.
    //
    // ★ PUBLISHED ONLY WHEN THE WHOLE HISTORY IS STORED. A missing day inside a clock-truncated
    // walk is a hole in what was READ, not a day nobody posted — so an incomplete walk would
    // report somebody's unwalked months as a silence they never took. Same flag, same reason, as
    // `longestStreakDays` rendering "9+" instead of "9".
    //
    // (`weekdayActs` was here too, seven per-weekday counts for the daily-question gimmick. Both
    // question mechanics were removed on 2026-08-09 as too unserious for the product, and this
    // field went with them — `busiestWeekday` computes its own counts for the stat line.)
    const gapDays = historyComplete ? longestGap(actDaysUTC) : 0;
    // A floor unless we have read the whole history: a personal record computed from
    // six months is not a personal record. The client is told which it is.
    const longestStreakDays = longestRun(actDaysUTC);

    // Who engaged, and which of them we had never seen before. The UNBUDGETED voter list,
    // not the credited count — this feeds a sentence with the word "people" in it, and the
    // budgeted figure is a score. It is not "raw": `sampledVotes` already has both
    // exclusion lists applied, so a bot can never become somebody's stored giver or be
    // announced by the first-time-giver nudge. Best-effort, like every other store call.
    let giverDelta: { total: number; newInWindow: number; newestName: string | null } | null = null;
    let feedsReached: number | null = null;
    // The PRECEDING window, so reach can be stated as a direction. Null unless it is
    // genuinely above zero — see countFeedsReachedWithPrior for why zero is ambiguous
    // and must never be drawn as a trend.
    let feedsReachedPrev: number | null = null;
    try {
      const voterNames = sampledVotes.map((v) => v.voter ?? '').filter((v) => v && v.toLowerCase() !== user);
      giverDelta = await recordHiveGivers(user, voterNames, NEW_PEOPLE_WINDOW_DAYS);
      const reach = await countFeedsReachedWithPrior(user, REACH_WINDOW_DAYS);
      feedsReached = reach.current;
      feedsReachedPrev = reach.prior > 0 ? reach.prior : null;
    } catch (err) {
      logger.warn(err, 'streak: giver/reach stats unavailable for %s', user);
    }
    // ★ AND IT IS ONLY PUBLISHED ONCE IT IS TRUE. `first_seen` is when WE first saw a
    // giver, so on a freshly built account every giver looks new and @blocktrades
    // would be told 1,564 people discovered him this week. Absent until we have
    // genuinely been watching longer than the window.
    const newPeopleTrustworthy = newPeopleIsTrustworthy(cursor, NEW_PEOPLE_WINDOW_DAYS);
    const newPeople = giverDelta && newPeopleTrustworthy ? giverDelta.newInWindow : undefined;
    const newestGiver = giverDelta && newPeopleTrustworthy ? (giverDelta.newestName ?? undefined) : undefined;

    // ════ THE RANK IS OBSERVED ACTIVITY, AND NOTHING ELSE (owner, 2026-08-09) ════
    //
    // "the ranks need to decay and no one gets rank 7 off the bat. everyone is rank 0, its based
    // off of activity."
    //
    // What used to be passed here: `createdISO` (Hive account creation), `activeWeeks` and
    // `creditedGivers` — three arms combined with MIN, all three seeded from lifetime Hive
    // standing. Measured live on their first ever request, having done nothing on Lumen: gtg,
    // tarazkp and lordbutterfly all landed on Aurora, rank 8 of 9.
    //
    // `firstObservedDayUTC` is the gate that makes rank 0 true for everybody. The walk stores up
    // to 26 weeks of Hive history, so `actDaysUTC` is NOT a record of what Lumen watched — the
    // cursor's `first_built_at` is, and `deriveLeagueInputs` counts only days at or after it,
    // inside a trailing year. Everything else those three arms measured survives as STATS
    // (tenure year, active weeks, the giver headcount): visible, honest, and no longer buying a
    // rank nobody earned here.
    const inputs = deriveLeagueInputs({
      actDaysUTC,
      // The same value the streak accumulates from — derived once, above, so the rank
      // and the streak can never disagree about the day Lumen started counting.
      firstObservedDayUTC: observedFromUTC,
      nowMs: Date.now()
    });

    const rank = computeLeague(inputs);
    const gate = deriveGate(inputs);
    // Still reported, because ops wants to know a walk was truncated even when the
    // STORE covered for it. It is no longer what decides `activeWeeksIsLowerBound` —
    // see the union above.
    const coverageCapped = postWalk.capped || commentWalk.capped;

    // ★★ `streakDays` HAS THE SAME PROBLEM AND WAS STILL BEING CALLED EXACT
    // (found 2026-08-08, second pass — the activeWeeks fix did not carry over).
    //
    // `actDaysUTC` is the union of two feed walks that run NEWEST-FIRST and stop
    // on a clock. So the day set is a PREFIX of history, and the streak counts
    // backwards until it finds a day with no act. If that missing day lies in the
    // part that was never walked, it is not a break — it is a hole in the data,
    // and the real streak is longer. `exact` claimed `streakDays` unconditionally,
    // including when `capped` was simultaneously true. Measured live on
    // 2026-08-08 through this route: @acidyo came back `capped: page_cap`,
    // `streakDays: 32`, `exact: [..., 'streakDays', ...]` — while the comments
    // walk had only reached 2026-07-13, six days AFTER the day the streak
    // supposedly broke. The 32 was a floor being published as a measurement.
    //
    // The test is not "was anything capped" but "was the BREAK inside the part we
    // actually read", so a short, provably-complete streak is still reported as
    // exact even on a capped walk. The boundary arithmetic lives in
    // features/retention/lib/walk-coverage.ts so it can be tested — a route module
    // can export nothing but its handlers, and this is exactly the sort of
    // off-by-one-day comparison that is wrong until a test says otherwise. A walk
    // that FAILED outright contributed no days at any date, so it is passed as a
    // walk bounded at today.
    //
    // ★ IT NOW TAKES THE UNION'S BOUNDARY, NOT THIS WALK'S. `completeFrom` already
    // accounts for the stored history, so a streak that broke inside a month we read
    // on a PREVIOUS visit is observed and exact — which is the common case for a
    // returning reader and used to be reported as a floor every single time.
    const coveredFrom = completeFrom;
    // ★ ONE SOURCE OF A STREAK FLOOR NOW, AND `computeStreak` DECIDES IT.
    // The decay accumulates forward from `countFromUTC` with the score at zero, so the
    // answer is a floor exactly when that day is later than the day the account was
    // first observed — the off-by-one lives in the pure function, where the test can
    // reach it, rather than being re-derived here.
    const streakDaysIsLowerBound = streak.isLowerBound;

    const exact = ['tenureYear'];
    if (!streakDaysIsLowerBound) exact.push('streakDays');
    if (!activeWeeksIsLowerBound) exact.push('activeWeeks');
    const createdISO = (account as unknown as { created?: string }).created ?? '';
    const tenureYear = createdISO ? new Date(`${createdISO.replace(/[zZ]$/, '')}Z`).getUTCFullYear() : 0;

    const body = {
      username: user,
      rank,
      gate,
      tenureYear,
      streakDays: streak.streakDays,
      activeWeeks: streak.activeWeeks,
      // ════ TODAY ════
      //
      // `acts` is chain-derived and exact, and it is all that is left here. The daily
      // GOAL (a server-held target that decided whether today ticked the streak) and
      // the FREEZE ledger are both deleted — owner ruling 2026-08-18, "no setting of
      // anything... no freezes". Nothing on this block is a preference any more.
      today: {
        acts: actsToday
      },
      // ════ THE INTERESTING NUMBERS ════
      //
      // Every field here is measured, and every one that cannot be stated honestly is
      // ABSENT rather than zero — a missing field renders no line, a `0` renders a
      // false one. `newPeople` waits until we have watched longer than its window;
      // `feedsReached` is omitted when its source had nothing to say;
      // `longestStreakDays` is a floor unless `historyComplete`, which is on the
      // wire beside it.
      //
      // ★ NO VOTE AMOUNTS ON THIS WIRE ANY MORE. `votesReceived`, `bestPostVotes`,
      // `bestPostTitle`, `bestPostUrl`, `postsRead` and `postsWithEngagement` are deleted
      // — see the block above the `pattern` assignment for why each one had to go rather
      // than be repaired. They are removed from the RESPONSE and not just from the UI, so
      // no future surface can rediscover them and print a botted number.
      stats: {
        // The HEADCOUNT: established + unknown, before the anti-farm budget. The
        // budgeted figure is a score and does not get to wear the word "people" —
        // that mistake shipped once already as "1111 people have engaged with your
        // posts" for an account with 1,564 real voters.
        //
        // ★ AND IT IS NOW A HEADCOUNT OF PEOPLE WE BELIEVE ARE PEOPLE. `sampledVotes` has
        // the global blacklist and the engagement exclusion list applied at the source, so
        // @hivebuzz and @pizzabot no longer appear in anybody's audience.
        people: givers.established + givers.unknown,
        ...(newPeople !== undefined ? { newPeople } : {}),
        ...(newestGiver ? { newestGiverName: newestGiver } : {}),
        /**
         * How many posts the headcount was read from — ON the stats object now, not only
         * in provenance, because the sentence that states the headcount is the place the
         * scope has to live. The distant footnote it replaces is what let three numbers
         * with three different denominators sit under one caveat.
         */
        peopleOverPosts: voteTargets.length,
        ...(longestStreakDays > 0 ? { longestStreakDays } : {}),
        ...(pattern ? { busiestWeekday: pattern.weekday, busiestWeekdayActs: pattern.acts } : {}),
        ...(gapDays > 0 ? { longestGapDays: gapDays } : {}),
        /**
         * Total days this account has EVER shown up, as far as the store knows.
         *
         * A count of days, not of votes or comments — and it accumulates rather than being
         * re-derived per request, because `lumen_hive_act_day` is additive. So it genuinely
         * grows toward all-time instead of describing a window. A floor until
         * `historyComplete`, which is on the wire beside it, and the client renders "+".
         */
        // ★★ THE OBSERVED COUNT, WHICH IS THE RANK'S OWN INPUT (fixed 2026-08-09 after a UX agent
        // read the card top to bottom: "`Nothing measured yet.` sits five lines above `Shown up on
        // 94+ days.`").
        //
        // It was `actDaysUTC.length` — every act-day the store knows, including the ~180 back-walked
        // out of Hive history. So the card carried TWO different day counts: the rank said 0 observed
        // days and the stat said 94, both true under different definitions, which is precisely the
        // "two numbers that cannot both be right" class this feature keeps having to fix. It is
        // `inputs.observedActDays` now — the same figure the rank was computed from — so the two
        // agree by construction, and the stat explains the rank instead of contradicting it.
        activeDaysTotal: inputs.observedActDays,
        /**
         * ★ HOW MUCH THEY HAVE WRITTEN, OVER FIVE WINDOWS (2026-08-18, owner: "how many
         * lines of text they wrote... the equivalent of a 100 page book", then "this needs
         * to change with time look3d at. one day 7 days, one time all time").
         *
         * Words, not lines — a line in markdown counts how the author's editor wraps, not
         * anything about the writing. Accumulated across every walk ever stored
         * (migration 0038), so `all` grows toward a lifetime figure instead of describing
         * whatever this request happened to reach.
         *
         * ★ ALL FIVE GO ON THE WIRE AND THE CLIENT PICKS. The choice rotates by day and by
         * reader (`pickWordWindow`), and doing that at RENDER time rather than in the route
         * is what keeps it correct behind the 5-minute response cache: a cached body would
         * otherwise freeze yesterday's window until it expired.
         *
         * The client decides which of them may be stated as a measurement by comparing
         * each window's start against `coverage.completeFrom` / `historyComplete`, both
         * already on the wire. Absent (not zero) when the store could not be read.
         */
        ...(wordsWritten !== null && wordsWritten.all > 0 ? { wordsWritten } : {}),
        ...(wordsPercentile !== null ? { wordsPercentile } : {}),
        // Raw, for the RATIO only — never printed as counts. See the block above.
        postsInWindow,
        repliesInWindow,
        ...(feedsReached !== null && feedsReached > 0 ? { feedsReached } : {}),
        ...(feedsReached !== null && feedsReached > 0 && feedsReachedPrev !== null
          ? { feedsReachedPrev }
          : {})
      },
      // Provenance, so no consumer has to guess how solid a number is.
      provenance: {
        source: 'chain',
        computedAt: new Date().toISOString(),
        exact,
        sampled: {
          // The CREDITED figure — what the ladder actually scored. Never the raw
          // voter count, which is the quantity that was purchasable.
          distinctGivers: givers.credited,
          overPosts: voteTargets.length,
          /**
           * How many of `overPosts` actually ANSWERED. Published because the giver
           * count is the engagement arm, so a caller (or an operator chasing a
           * surprising rank) needs to know the sample was complete. Below a majority
           * the route 502s rather than serve a collapsed rank.
           */
          voteReadsOk,
          postsScanned: posts.length,
          commentsScanned: comments.length
        },
        // How the credited figure was reached, so a low number is explainable
        // rather than mysterious ("you have support, but from accounts with no
        // stake behind them") and so the floors are auditable from the outside.
        giverTrust: {
          established: givers.established,
          unknown: givers.unknown,
          unknownCredited: givers.unknownCredited,
          dustRejected: givers.dustRejected,
          /** 1 when the author's own upvote was found and dropped, else 0. */
          selfExcluded: givers.selfExcluded,
          minRshares: VOTER_MIN_RSHARES,
          establishedMinRshares: ESTABLISHED_VOTER_MIN_RSHARES
        },
        // Coverage, stated rather than assumed. When either walk is `capped`,
        // history older than `oldestSeen` was never read, so activeWeeks is a
        // LOWER bound on the true figure — it is never extrapolated upward.
        //
        // ★ THE CLIENT MUST RENDER THIS, NOT DISCARD IT. `activeWeeksIsLowerBound`
        // is the difference between "active 11 weeks" and "active at least 11
        // weeks" — and the gap is not academic: the walk stops on a 20s CLOCK
        // budget, not on the 26-week window, so a daily poster since 2018 is
        // routinely served 11. Presenting a truncated walk as a measurement
        // demotes a real person on the strength of how busy a Hive node was, which
        // is the same "overconfident layer" failure we refuse everywhere else. A
        // consumer that ignores this flag is publishing a guess as a fact.
        coverage: {
          windowWeeks: WINDOW_WEEKS,
          postsOldestSeen: postWalk.oldestISO,
          commentsOldestSeen: commentWalk.oldestISO,
          capped: coverageCapped,
          /**
           * ★ NO LONGER `capped` (2026-08-09). Two changes, both narrowing:
           *  - it is the UNION of every walk we have stored, not this request's, so a
           *    returning reader stops being re-truncated on every visit;
           *  - it asks whether the boundary falls INSIDE the window, so a walk that
           *    read thirty weeks is not marked inexact for a twenty-six week figure.
           * The flag itself still means exactly what it meant, and the client must
           * still render "at least N" when it is true.
           */
          activeWeeksIsLowerBound,
          /** Oldest day the merged (stored + walked) day set is complete from. */
          completeFrom,
          /** The whole account history is stored: `longestStreakDays` is exact. */
          historyComplete,
          /**
           * True when the decay could not be accumulated all the way from the day
           * the account was first observed, so `streakDays` is a floor and must be
           * rendered "N+ day streak", never a bare N. Independent of
           * `activeWeeksIsLowerBound`: the two answer different questions about
           * different spans.
           */
          streakDaysIsLowerBound,
          /**
           * The oldest UTC day for which the day set is COMPLETE — i.e. where both
           * feeds had been read. '' when nothing bounded the walk. Published so a
           * consumer (or an operator) can check the bound above rather than
           * trusting it.
           */
          daySetCompleteFrom: coveredFrom,
          // Which bound bit, for ops and for wording: null whenever not capped.
          // The posts walk is load-bearing, so its reason wins when both capped.
          cappedReason: postWalk.cappedReason ?? commentWalk.cappedReason ?? null,
          commentsFeedUnavailable: commentsFailed,
        },
        // ★ `receivedEngagement` IS NO LONGER LISTED HERE, because it is no longer a
        // proxy. It read "reputation-derived proxy, not a measured per-post engagement
        // rate; capped below the apex by design" — an accurate confession, and the
        // reason the top three rungs were unreachable. The arm is now a count of real
        // people. Nothing on this path stands in for anything except where it says so
        // below.
        proxied: {
          streakDays:
            'authored acts only (posts + comments). Votes are not counted yet — that needs account_history, which is a heavier walk than this route currently makes. It is also the one currency both ladders can measure symmetrically: a Hive user votes from the browser and never touches this server.',
          distinctGivers:
            'stake-floored and budgeted, not a raw voter count. rshares is the only trust-bearing field the vote payload carries, so it stands in for "an established person" — it proves the vote COST something, never that the voter genuinely engaged. Unknown-tier givers are therefore budgeted rather than banned, so a real newcomer still counts.',
          newPeople:
            'first_seen is when WE first observed a giver, not when they first engaged. Absent entirely until this account has been watched for longer than the window the number is measured over.'
        }
      }
    };

    // Snapshot the rank for the byline mark's batch read (migration 0029). Side effect of
    // a real computation, so the batch endpoint never has to compute anything itself.
    try {
      await recordRankMark(user, rank.tier, rank.rankNumber, rank.showBylineEmblem);
    } catch (err) {
      logger.warn(err, 'streak: could not snapshot rank mark for %s', user);
    }

    // This write is what makes the stale-while-revalidate block in `GET` correct: it
    // refreshes `at`, so the very next read (fresh or, once STREAK_TTL_MS has passed
    // again, stale) reflects THIS walk.
    writeStreakCache(user, { at: Date.now(), body });
    return { status: 200, body };
  } catch (error) {
    logger.error(error, 'streak route failed for %s', user);
    return { status: 502, body: { error: 'upstream unavailable' } };
  }
}
