import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardPublisher } from '@/blog/lib/lite/http/guard';
import { reconcileOrphans } from '@/blog/lib/lite/content/post-service';
import { runPublisherOnce, ProcessOutcome } from '@/blog/lib/lite/publisher/worker';
import { withAdvisoryLock } from '@/blog/lib/lite/db/pool';
import { installWifBroadcaster } from '@/blog/lib/lite/publisher/hive-broadcaster';
import { hasBroadcaster } from '@/blog/lib/lite/publisher/broadcaster';

/** Arbitrary but fixed key: all drains across all processes contend on this one. */
const DRAIN_LOCK = 971_020_301;

const logger = getLogger('app');

/** Hard ceiling per call, so one request can never run unbounded. */
const MAX_BATCH = 25;

/**
 * POST /api/lite/publisher/drain — ops trigger for the publish outbox.
 *
 * A scheduler (cron, queue consumer) calls this with `x-lite-publisher-token` to
 * push queued lite posts to Hive. It exists because the platform cannot rely on a
 * long-lived worker process; each call claims and processes up to `max` jobs and
 * returns, so the work is resumable and observable.
 *
 * Hive rate-limits root posts to roughly one per five minutes per account, so a
 * backlog drains over time by design — jobs that hit the limit are rescheduled
 * with backoff by the worker, not lost.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const blocked = guardPublisher(req);
  if (blocked) return blocked;

  // Dev convenience: wire the env-var signer if one is configured. In production
  // this throws unless a KMS-backed broadcaster was already injected at boot.
  if (!hasBroadcaster()) {
    try {
      installWifBroadcaster();
    } catch (error) {
      logger.error(error, 'Publisher drain: refusing to install dev broadcaster');
      return NextResponse.json({ error: 'broadcaster_unavailable' }, { status: 503 });
    }
  }
  if (!hasBroadcaster()) {
    return NextResponse.json({ error: 'no_broadcaster' }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { max?: number };
  const max = Math.min(Math.max(1, Number(body?.max) || 1), MAX_BATCH);

  const counts: Record<ProcessOutcome, number> = { idle: 0, processed: 0, failed: 0 };
  // One drain at a time, cluster-wide. Broadcast pacing is process-local, so a
  // second overlapping drain would ignore the 3-second interval and get its
  // transactions rejected. Skipping is correct: the queue is still there next tick.
  let repaired = 0;
  const ran = await withAdvisoryLock(DRAIN_LOCK, async () => {
    // Inside the lock: the sweep reserves container slots, and two overlapping sweeps
    // each committed a slot reservation (sometimes a whole container) that no post ever
    // used. The final writes were already race-safe; the side effects were not.
    repaired = await reconcileOrphans(MAX_BATCH);

    for (let i = 0; i < max; i++) {
      const outcome = await runPublisherOnce(`drain-${process.pid}`);
      counts[outcome] += 1;
      if (outcome === 'idle') break; // queue is empty — stop early
    }
    return true;
  });
  if (!ran) {
    return NextResponse.json({ status: 'skipped', reason: 'another drain is running', repaired });
  }

  return NextResponse.json({ status: 'ok', ...counts, repaired });
}
