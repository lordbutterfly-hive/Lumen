import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { liveViewerId } from '@/blog/lib/lite/http/actor';
import { getEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { liteTargetServable } from '@/blog/lib/lite/content/engagement-target';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { consumeLocalGlobal, consumeLocalPerIp } from '@/blog/lib/lite/antispam/local-rate-limit';

const logger = getLogger('app');

/** Hard ceiling on one request's payload. A feed page asks for ~30; a heavy thread more. */
const MAX_TARGETS = 200;

/**
 * ★ FIX-DOS, 2026-09-08 (DOS-08). This route's only prior gate was `guardRead()` (a
 * feature-flag check), reachable with NO session at all — measured: 40 consecutive
 * anonymous calls, none ever 429; a single 200-target request held 8-10 of the pool's
 * `dbPoolMax:10` connections concurrently, all by itself.
 *
 * Two independent bounds, for two independent risks:
 *   - `MAX_CONCURRENT_DB_CALLS` below bounds how much of the SHARED pool any ONE
 *     request can hold at once, regardless of rate limiting.
 *   - The limiters here bound REPEATED requests over time — the volume-based risk a
 *     concurrency cap alone does not touch.
 *
 * In-process only (no new Postgres dependency for a route that must keep working
 * whether or not the durable limiter store is provisioned) — the same
 * `consumeLocalGlobal`/`consumeLocalPerIp` pair `app/api/creator-tokens/{gql,submit}`
 * already use for the identical class of problem (a public, no-session proxy that
 * must not become an amplifier). Sized generously for legitimate polling (a feed page
 * asks for ~30 targets in ONE batched call, not per-card) while still bounding a flood.
 */
const BULK_PER_IP_PER_MIN = 120;
const BULK_GLOBAL_PER_MIN = 4_000;

/**
 * ★ FIX-DOS, 2026-09-08 (DOS-08). The `Promise.all` fan-out below used to issue every
 * target's `getEngagement` call at once — up to `MAX_TARGETS` (200) concurrent
 * queries into a pool capped at `dbPoolMax` (default 10), measured to hold 8-10 of
 * those 10 connections for the DURATION of one single unauthenticated request. This
 * caps how many of this ONE request's queries may be in flight simultaneously,
 * leaving headroom in the shared pool for every other lite-DB route
 * (`/api/lite/name/check`, `/api/health`, `/api/lite/posts/[id]`, etc.) that depends
 * on it. DOS-04's new `statement_timeout` (2000ms) already bounds how long any single
 * stuck query can hold its slot; this bounds how MANY slots one request can hold at
 * once. 6 leaves at least 4 of the 10 connections free even at this route's own worst
 * case.
 */
const MAX_CONCURRENT_DB_CALLS = 6;

/** Run `items` through `fn`, at most `limit` in flight at once, preserving order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * GET /api/lite/engagement/bulk?targets=<json> — `/api/lite/engagement`, batched.
 *
 * ★★★ THE N+1 FIX, MEASURED (2026-08-17). The per-post route fired once per card:
 * ~30 requests on every home load, every load, forever — `fetchLiteEngagement` is
 * `cache: 'no-store'`, so nothing absorbed them. Measured aggregate 3.3-13.7s
 * (parallel), with a 0.8-3.0s tail on the load itself. The owner's rule for this
 * product is that a first load may be slow once and later loads never may; this was
 * squarely in the "later loads" bucket.
 *
 * Same question as the single-item route — "what are this post's Lumen-local vote and
 * reblog, and did the viewer cast one" — asked for every post on a page in one round
 * trip. Exactly the shape `/api/lite/block/state-bulk` already established for the
 * identical storm on block state; see `use-lumen-block.ts` for that history.
 *
 * ★ SERVER-SIDE FAN-OUT, NOT BATCHED SQL, AND THAT IS DELIBERATE. This resolves each
 * target with the SAME `liteTargetServable` + `getEngagement` pair the single route
 * uses, in parallel, rather than a new hand-written multi-target query. The cost that
 * hurt was the 30 browser round trips, not the database: these are local Postgres
 * reads in the single-digit-millisecond range. Reusing the exact helpers means the
 * bulk answer and the single answer cannot drift — a batched query would be a second
 * definition of "servable", and the takedown gate (B5) is the last thing that should
 * exist twice. If the DB ever becomes the bottleneck, batch it THEN, with a
 * measurement to point at.
 *
 * ★ ONE FAILED TARGET MUST NOT FAIL THE BATCH. Each target settles independently; a
 * target that throws or is unservable comes back absent from the map, and the client
 * treats absence exactly as the single route's 404 → EMPTY. The alternative — one bad
 * permlink 500ing a whole feed's engagement — is how a batch endpoint becomes worse
 * than the fan-out it replaced.
 *
 * GET with `guardRead` only, matching the single-item route and `state-bulk`: a pure
 * read with no state change needs no CSRF token. The answer is per-viewer (the
 * viewer's own vote comes from the session cookie), so it sets no `Cache-Control` and
 * is dynamic by construction — Next never statically caches a handler that reads
 * cookies.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardRead();
  if (blocked) return blocked;

  // ★ FIX-DOS, 2026-09-08 (DOS-08). See BULK_PER_IP_PER_MIN/BULK_GLOBAL_PER_MIN
  // above. Global first: it is the only bound that survives a caller with many IPs.
  const ip = getClientIp(req);
  if (!consumeLocalGlobal('lite_engagement_bulk', BULK_GLOBAL_PER_MIN)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  if (!consumeLocalPerIp(ip, 'lite_engagement_bulk', BULK_PER_IP_PER_MIN)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const raw = req.nextUrl.searchParams.get('targets');
  if (!raw) return NextResponse.json({ error: 'targets_required' }, { status: 400 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'targets_malformed' }, { status: 400 });
  }
  if (!Array.isArray(parsed)) {
    return NextResponse.json({ error: 'targets_malformed' }, { status: 400 });
  }

  // `[author, permlink]` tuples, terse because this travels in a query string.
  // A malformed pair is dropped rather than rejecting the whole batch over one bad
  // entry — same posture as `state-bulk`'s handling of an unknown kind.
  const targets: { author: string; permlink: string }[] = [];
  const seen = new Set<string>();
  for (const item of parsed.slice(0, MAX_TARGETS)) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [author, permlink] = item;
    if (typeof author !== 'string' || typeof permlink !== 'string') continue;
    if (!author || !permlink) continue;
    const key = `${author}/${permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ author, permlink });
  }
  if (targets.length === 0) return NextResponse.json({ engagement: {} });

  // ★ A REVOKED COOKIE IS NOT THIS VIEWER (2026-08-23). Same shape as the single-item
  // engagement route: this read the cookie directly, so `logout-all` did not stop it
  // returning this account's own engagement state. Degrades to anonymous, not 401.
  const session = await getLiteSession();
  const user = session.user;
  const liveId = await liveViewerId(user, session);
  const userId = liveId && user?.account_tier === 'lite' ? liveId : null;

  // ★ FIX-DOS, 2026-09-08 (DOS-08). Was `Promise.all(targets.map(...))` — up to
  // MAX_TARGETS (200) queries in flight at once against a 10-connection pool. See
  // MAX_CONCURRENT_DB_CALLS above: bounds how many of THIS request's own queries may
  // run simultaneously, without changing per-target behaviour (independent settling,
  // absent-on-failure) at all.
  const entries = await mapWithConcurrency(targets, MAX_CONCURRENT_DB_CALLS, async ({ author, permlink }) => {
      try {
        // ★ B5, same gate as the single route: a taken-down post must not keep
        // reporting live counts. Keyed on the permlink alone — a lite post reaches
        // the browser under its WRITER'S handle, so gating on the publishing account
        // would mean the guard never runs on the spelling the client sends.
        if (!(await liteTargetServable(permlink))) return null;
        const engagement = await getEngagement(userId, author, permlink);
        const votes =
          engagement.weight !== null && user?.username
            ? [
                {
                  id: 1,
                  voter: user.username,
                  author,
                  permlink,
                  weight: String(engagement.weight),
                  rshares: 0,
                  vote_percent: engagement.weight,
                  last_update: new Date(0).toISOString(),
                  num_changes: 0,
                  _temporary: true
                }
              ]
            : [];
        return [
          `${author}/${permlink}`,
          {
            votes,
            reblogged: engagement.reblogged,
            voteCount: engagement.voteCount,
            reblogCount: engagement.reblogCount
          }
        ] as const;
      } catch (error) {
        // Absent from the map, not a failed batch — the client reads absence as EMPTY.
        logger.error('lite engagement bulk: %s/%s failed: %s', author, permlink, String(error));
        return null;
      }
  });

  const engagement: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry) engagement[entry[0]] = entry[1];
  }
  return NextResponse.json({ engagement });
}
