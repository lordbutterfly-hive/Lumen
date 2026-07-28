import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { guardPublisher } from '@/blog/lib/lite/http/guard';
import { hasBroadcaster } from '@/blog/lib/lite/publisher/broadcaster';
import { queueHealth } from '@/blog/lib/lite/repositories/publish-job-repository';

const logger = getLogger('app');

/**
 * GET /api/lite/publisher/health — is the outbox actually draining?
 *
 * The publisher's real failure mode is not an error, it is silence. Nothing schedules
 * the drain by default, so a deploy that forgets the cron behaves exactly like a
 * healthy one from the inside: posts are accepted, jobs are queued, no exception is
 * raised, and the author waits forever for something that will never happen. A queue
 * depth alone cannot tell those apart — five pending jobs look the same whether the
 * drain runs every minute or died a week ago. The AGES distinguish them, so this
 * endpoint leads with them and turns them into one boolean an alert can page on.
 *
 * Deliberately read-only and side-effect free. It does NOT install the dev
 * broadcaster — a monitoring check must never be able to arm a signer, let alone
 * broadcast (an audit agent once triggered a real mainnet post by calling what it
 * assumed was a read-only endpoint). `broadcasterReady` is therefore reported as it
 * is, and reads false on a process that has not drained yet even when a signer is
 * configured; treat it as "has this process armed", not "is a signer available".
 *
 * Same shared token as the drain: an operator with the drain token is exactly the
 * audience for its health.
 */

/** Pending work older than this means the drain is not running (or cannot keep up). */
const DEFAULT_STALL_SECONDS = 900;

/** A worker that died mid-broadcast leaves a job claimed; reapStuck() recovers it. */
const STUCK_AFTER_SECONDS = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const blocked = guardPublisher(req);
  if (blocked) return blocked;

  const stallParam = Number(req.nextUrl.searchParams.get('stallSeconds'));
  const stallSeconds = Number.isFinite(stallParam) && stallParam > 0 ? stallParam : DEFAULT_STALL_SECONDS;

  try {
    const health = await queueHealth(STUCK_AFTER_SECONDS);

    // Backlog on its own is normal and expected: Hive paces comments at one per three
    // seconds, so a burst legitimately takes minutes to clear. What is NOT normal is
    // the oldest job ageing past the stall window — that means nothing is draining.
    const stalled = health.oldestPendingAgeSeconds !== null && health.oldestPendingAgeSeconds > stallSeconds;
    const ok = !stalled && health.stuckPublishing === 0;

    if (stalled) {
      logger.error(
        { oldestPendingAgeSeconds: health.oldestPendingAgeSeconds, pending: health.pending },
        'Lite publisher queue is stalled — posts are queued but nothing is draining'
      );
    }

    return NextResponse.json(
      {
        ok,
        stalled,
        stallSeconds,
        broadcasterReady: hasBroadcaster(),
        ...health
      },
      // 503 so a plain HTTP check pages without having to parse the body.
      { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    logger.error(error, 'Lite publisher health check failed');
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
