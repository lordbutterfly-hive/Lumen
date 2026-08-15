import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { liteConfig } from '@/blog/lib/lite/config';
import { hasViewerFeedBuilder, runWarmCycle, warmConfig } from '@/blog/lib/feed/viewer-warmer';

/**
 * ★★★ POST /api/feed/warm — run ONE per-viewer warm cycle (2026-08-15).
 *
 * BUILD MAP: O:/LUMEN-DOCS/BUILDMAP-NEVER-WAIT-2026-08-15.md §4.1.
 *
 * The ops trigger for the ranking warmer, shaped after
 * `/api/lite/publisher/drain`: an external ticker provides the CADENCE, one call
 * does ONE bounded batch and returns, and the whole cycle sits behind a Postgres
 * advisory lock so a second caller — or a second replica — answers
 * `{status:'skipped'}` instead of doubling the load on a public Hive node and a
 * rate-limited ranker.
 *
 * ★ WHY AN ENDPOINT AT ALL, GIVEN THE IN-PROCESS TICKER. Three things a
 * module-load timer cannot do: be paused without a deploy (stop the ticker), be
 * driven on a schedule an operator controls, and REPORT — every cycle's counters
 * come back in the response body rather than only in a log line. That last one
 * is the same argument `drain` makes for itself, and it matters here because the
 * failure this whole wave exists to prevent went unnoticed for three days
 * precisely because a background refresh that never landed left no trace.
 *
 * ★ ITS OWN TOKEN, NOT THE PUBLISHER'S. `LITE_PUBLISHER_TOKEN` is a POSTING
 * AUTHORITY credential — whoever holds it can publish to Hive as the shared
 * publisher account. This endpoint only rebuilds cached rankings. Sharing one
 * secret across two authority tiers means a leaked warm-token also authorises
 * broadcasting; the precedent for splitting by tier is already set by
 * `guardAccountCreator` (guard.ts:72-88). Unset `LUMEN_FEED_WARM_TOKEN` leaves
 * this endpoint 401ing, so merging it cannot open a door by accident.
 *
 * ★ IT CANNOT RECORD AN IMPRESSION. Nothing on this path imports
 * `recordFeedServe` or `recordServedPage`, and the cycle builds through the same
 * function a reader's own background rebuild uses — which has never recorded a
 * serve, because recording happens on the branches that return a page to a
 * person. See the header of `viewer-warmer.ts` for why that boundary is
 * load-bearing rather than tidy.
 */

/** Constant-time compare, same shape as `guard.ts`'s `safeEqual`. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) {
    return NextResponse.json({ error: 'lite_accounts_disabled' }, { status: 503 });
  }

  const expected = process.env.LUMEN_FEED_WARM_TOKEN || '';
  const supplied = req.headers.get('x-lumen-feed-warm-token') ?? '';
  if (!expected || !tokenMatches(supplied, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const result = await runWarmCycle();
  const config = warmConfig();

  // ★ A TICKER POLLING THIS MUST BE ABLE TO TELL FOUR THINGS APART: it is off
  // (`disabled`), somebody else is doing it (`skipped`), it ran (`ok`), and it
  // CANNOT run (`unavailable`). Only the last is an alert — and it is the one a
  // silent warmer would have hidden, so it gets a 503 rather than a cheerful
  // 200 with a sad word in the body.
  const status = result.status === 'unavailable' ? 503 : 200;
  return NextResponse.json(
    {
      ...result,
      // Echoed so an operator reads the knobs the running process ACTUALLY has,
      // rather than the ones they believe they set — the same reason `drain`
      // reports `pending` instead of leaving a stall to be inferred.
      config: {
        enabled: config.enabled,
        batch: config.batch,
        limit: config.limit,
        intervalMs: config.intervalMs,
        activeMs: config.activeMs,
        gapMs: config.gapMs,
        builderRegistered: hasViewerFeedBuilder()
      }
    },
    { status }
  );
}
