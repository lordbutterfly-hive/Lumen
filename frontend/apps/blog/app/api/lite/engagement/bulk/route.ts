import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardRead } from '@/blog/lib/lite/http/guard';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { getEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { liteTargetServable } from '@/blog/lib/lite/content/engagement-target';

const logger = getLogger('app');

/** Hard ceiling on one request's payload. A feed page asks for ~30; a heavy thread more. */
const MAX_TARGETS = 200;

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

  const session = await getLiteSession();
  const user = session.user;
  const userId = user?.account_tier === 'lite' && user.userId ? user.userId : null;

  const entries = await Promise.all(
    targets.map(async ({ author, permlink }) => {
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
    })
  );

  const engagement: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry) engagement[entry[0]] = entry[1];
  }
  return NextResponse.json({ engagement });
}
