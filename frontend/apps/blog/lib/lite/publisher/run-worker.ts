/**
 * Ops entrypoint for the publisher worker. Run as a long-lived process:
 *   pnpm --filter @hive/blog exec tsx lib/lite/publisher/run-worker.ts
 *
 * Requires a real broadcaster. In development `installDevBroadcaster()` wires the
 * env-var WIF signer; production must inject a KMS-backed one via setBroadcaster
 * (spec §D.2) — the dev path refuses to run under NODE_ENV=production. With no
 * broadcaster the loop stays idle rather than failing. Polls for ready jobs and
 * processes them one at a time.
 */
import { runPublisherOnce } from './worker';
import { installDevBroadcaster } from './hive-broadcaster';
import { withAdvisoryLock } from '../db/pool';

/**
 * The SAME lock the drain route takes. Hive rejects a second comment from one account
 * within 3 seconds, and the pacer that prevents that is a module-local variable — so
 * two publishing processes (this worker and a drain, or two workers) would each believe
 * they were clear to broadcast. Without this the lock covered only drain-vs-drain,
 * which is not what its comment claimed.
 */
const PUBLISH_LOCK = 971_020_301;

const WORKER_ID = `worker-${process.pid}`;
const IDLE_POLL_MS = 5000;
const BUSY_POLL_MS = 250;

async function loop(): Promise<void> {
  const wired = installDevBroadcaster();
  // eslint-disable-next-line no-console -- standalone CLI worker
  console.log(wired ? 'Publisher: dev broadcaster installed.' : 'Publisher: no broadcaster — idle.');

  for (;;) {
    let outcome: string;
    try {
      // Not granted means another publisher is mid-broadcast: idle and try again, which
      // is exactly right — the queue is still there next tick.
      outcome = (await withAdvisoryLock(PUBLISH_LOCK, () => runPublisherOnce(WORKER_ID))) ?? 'idle';
    } catch {
      outcome = 'failed';
    }
    await new Promise((resolve) => setTimeout(resolve, outcome === 'idle' ? IDLE_POLL_MS : BUSY_POLL_MS));
  }
}

loop().catch((error) => {
  // eslint-disable-next-line no-console -- standalone CLI worker
  console.error('Publisher worker crashed:', error);
  process.exit(1);
});
