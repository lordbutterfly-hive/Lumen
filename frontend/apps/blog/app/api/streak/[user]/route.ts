import { NextRequest, NextResponse } from 'next/server';
import { getAccount, getProfileInfo, getActiveVotes } from '@transaction/lib/hive-api';
import { getAccountPosts } from '@transaction/lib/bridge-api';
import { computeStreak } from '@/blog/features/retention/lib/compute-streak';
import { computeLeague } from '@/blog/features/retention/lib/compute-league';
import { deriveGate, deriveLeagueInputs, utcDay } from '@/blog/features/retention/lib/derive-league-inputs';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceLookupRate } from '@/blog/lib/lite/antispam/rate-limit';

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
const VOTE_SAMPLE_POSTS = 3; // posts we actually walk voters for (bounded cost)
const CACHE_TTL_MS = 5 * 60 * 1000;
// F-L15: a DEFINITIVE not-found is negative-cached, but for a SHORTER window than a
// positive result and NEVER for a transient upstream failure (that returns 502 and is
// left uncached, so a node hiccup can't pin a real account as missing for 5 minutes).
const NEG_CACHE_TTL_MS = 60 * 1000;
// F-L15: hard cap on the in-process cache. It was an unbounded Map on a public, unauth
// route — every distinct (validated) username added an entry that was never evicted, so
// walking the username space was a slow memory-exhaustion vector. FIFO-evict once over.
const MAX_CACHE_ENTRIES = 10_000;

interface CacheEntry {
  at: number;
  body: unknown;
  /** A negative (account-not-found) entry — see NEG_CACHE_TTL_MS. */
  notFound?: boolean;
}
const cache = new Map<string, CacheEntry>();

function putCache(user: string, entry: CacheEntry): void {
  cache.set(user, entry);
  // Map preserves insertion order, so the first key is the oldest — evict until bounded.
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

interface PostLike {
  author?: string;
  created?: string;
  permlink?: string;
  stats?: { total_votes?: number };
}

interface FeedWalk {
  items: PostLike[];
  /** Oldest item actually seen, so coverage can be stated rather than assumed. */
  oldestISO: string;
  /** True when MAX_PAGES ran out before reaching the window — coverage is partial. */
  capped: boolean;
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
async function walkFeed(sort: string, user: string, cutoffMs: number): Promise<FeedWalk> {
  const items: PostLike[] = [];
  let startAuthor = '';
  let startPermlink = '';
  let oldestISO = '';
  let capped = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = ((await getAccountPosts(sort, user, '', startAuthor, startPermlink, PAGE_SIZE)) ??
      []) as PostLike[];
    // A paged call echoes the cursor item back as the first element; drop it.
    const fresh = startPermlink ? batch.filter((p) => p.permlink !== startPermlink) : batch;
    if (fresh.length === 0) return { items, oldestISO, capped: false };

    items.push(...fresh);
    const last = fresh[fresh.length - 1];
    oldestISO = last?.created ?? oldestISO;
    startAuthor = last?.author ?? user;
    startPermlink = last?.permlink ?? '';

    const oldestMs = last?.created ? Date.parse(`${last.created.replace(/[zZ]$/, '')}Z`) : NaN;
    if (Number.isFinite(oldestMs) && oldestMs < cutoffMs) return { items, oldestISO, capped: false };
    if (!startPermlink) return { items, oldestISO, capped: false };
    capped = page === MAX_PAGES - 1;
  }
  return { items, oldestISO, capped };
}

export async function GET(req: NextRequest, { params }: { params: { user: string } }) {
  const user = (params.user || '').toLowerCase();
  if (!USERNAME_RE.test(user)) {
    return NextResponse.json({ error: 'invalid username' }, { status: 400 });
  }

  // F-L15: per-IP rate limit on this public, unauth route (a cache miss fans ~50 Hive
  // calls). Best-effort: if the limiter's store is unavailable, fall open on the LIMITER
  // only — the cache + LRU bound still cap cost — rather than take the route down.
  try {
    if (!(await enforceLookupRate(getClientIp(req)))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    /* limiter unavailable — proceed; the cache still bounds amplification */
  }

  const hit = cache.get(user);
  if (hit && Date.now() - hit.at < (hit.notFound ? NEG_CACHE_TTL_MS : CACHE_TTL_MS)) {
    if (hit.notFound) {
      return NextResponse.json({ error: 'account not found' }, { status: 404, headers: { 'x-cache': 'neg' } });
    }
    return NextResponse.json(hit.body, { headers: { 'x-cache': 'hit' } });
  }

  try {
    const cutoffMs = Date.now() - WINDOW_WEEKS * 7 * 86_400_000;
    const [accountRes, profileRes, postsRes, commentsRes] = await Promise.allSettled([
      getAccount(user),
      getProfileInfo(user),
      walkFeed('posts', user, cutoffMs),
      walkFeed('comments', user, cutoffMs)
    ]);

    // F-L15: distinguish a TRANSIENT upstream failure (the getAccount call rejected)
    // from a DEFINITIVE not-found (it resolved, empty). The former is a 502 and is NEVER
    // cached; the latter is a 404 and IS negative-cached. Previously both returned 404 —
    // so a node outage rendered a real account as "not found", and repeated hits on a
    // genuinely-missing account re-walked every time.
    if (accountRes.status !== 'fulfilled') {
      logger.error(accountRes.reason, 'streak: account read failed for %s', user);
      return NextResponse.json({ error: 'upstream unavailable', detail: 'account' }, { status: 502 });
    }
    if (!accountRes.value) {
      putCache(user, { at: Date.now(), body: null, notFound: true });
      return NextResponse.json({ error: 'account not found' }, { status: 404 });
    }

    const account = accountRes.value;
    // A failed profile read degrades to the floor reputation rather than 500 —
    // the league simply reads lower until the call succeeds again.
    const formattedReputation = profileRes.status === 'fulfilled' ? (profileRes.value.reputation ?? 25) : 25;

    // FAIL LOUD, never silently. An upstream failure must not be rendered as
    // "this account was inactive" — that would demote a real person on the
    // strength of a network error. The posts walk is load-bearing for both the
    // active-weeks arm and vote breadth, so its failure is a 502.
    if (postsRes.status !== 'fulfilled') {
      logger.error(postsRes.reason, 'streak: posts walk failed for %s', user);
      return NextResponse.json({ error: 'upstream unavailable', detail: 'posts feed' }, { status: 502 });
    }
    const postWalk: FeedWalk = postsRes.value;
    const commentsFailed = commentsRes.status !== 'fulfilled';
    const commentWalk: FeedWalk = commentsFailed
      ? { items: [], oldestISO: '', capped: true }
      : commentsRes.value;
    const posts = postWalk.items;
    const comments = commentWalk.items;

    const actDaysUTC = [...posts, ...comments]
      .map((p) => (p.created ? utcDay(p.created) : ''))
      .filter((d) => d !== '');

    const todayUTC = new Date().toISOString().slice(0, 10);
    // freezeAvailable is 0 here: a banked freeze is a HABIT-layer mercy and is
    // held client-side, so the chain-derived streak stays strictly factual.
    const streak = computeStreak({ actDaysUTC, todayUTC, freezeAvailable: 0 });

    // Distinct voters over a bounded sample of recent posts. Sampled, not total —
    // labelled as such in the response so nobody reads it as lifetime breadth.
    const voteTargets = posts.filter((p) => p.permlink).slice(0, VOTE_SAMPLE_POSTS);
    const voterSets = await Promise.allSettled(
      voteTargets.map((p) => getActiveVotes(user, p.permlink as string))
    );
    const distinct = new Set<string>();
    for (const r of voterSets) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const v of r.value) {
        const voter = (v as { voter?: string }).voter;
        if (voter) distinct.add(voter);
      }
    }

    const totalVotesOnSample = posts.reduce((sum, p) => sum + (p.stats?.total_votes ?? 0), 0);

    const inputs = deriveLeagueInputs({
      createdISO: (account as unknown as { created?: string }).created ?? '',
      formattedReputation,
      actDaysUTC,
      activeWeeks: streak.activeWeeks,
      distinctGivers: distinct.size,
      sampledPosts: posts.length,
      totalVotesOnSample,
      nowMs: Date.now()
    });

    const rank = computeLeague(inputs);
    const gate = deriveGate(inputs);
    const createdISO = (account as unknown as { created?: string }).created ?? '';
    const tenureYear = createdISO ? new Date(`${createdISO.replace(/[zZ]$/, '')}Z`).getUTCFullYear() : 0;

    const body = {
      username: user,
      rank,
      gate,
      tenureYear,
      streakDays: streak.streakDays,
      activeWeeks: streak.activeWeeks,
      // Provenance, so no consumer has to guess how solid a number is.
      provenance: {
        source: 'chain',
        computedAt: new Date().toISOString(),
        exact: ['tenureYear', 'streakDays', 'activeWeeks'],
        sampled: {
          distinctGivers: distinct.size,
          overPosts: voteTargets.length,
          postsScanned: posts.length,
          commentsScanned: comments.length
        },
        // Coverage, stated rather than assumed. When either walk is `capped`,
        // history older than `oldestSeen` was never read, so activeWeeks is a
        // LOWER bound on the true figure — it is never extrapolated upward.
        coverage: {
          windowWeeks: WINDOW_WEEKS,
          postsOldestSeen: postWalk.oldestISO,
          commentsOldestSeen: commentWalk.oldestISO,
          capped: postWalk.capped || commentWalk.capped,
          activeWeeksIsLowerBound: postWalk.capped || commentWalk.capped,
          commentsFeedUnavailable: commentsFailed
        },
        proxied: {
          receivedEngagement:
            'reputation-derived proxy, not a measured per-post engagement rate; capped below the Celestial apex by design',
          streakDays:
            'authored acts only (posts + comments). Votes are not counted yet — that needs account_history, which is a heavier walk than this route currently makes.'
        }
      }
    };

    putCache(user, { at: Date.now(), body });
    return NextResponse.json(body, { headers: { 'x-cache': 'miss' } });
  } catch (error) {
    logger.error(error, 'streak route failed for %s', user);
    return NextResponse.json({ error: 'upstream unavailable' }, { status: 502 });
  }
}
