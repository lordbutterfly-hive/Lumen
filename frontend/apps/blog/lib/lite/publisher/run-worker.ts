/**
 * Ops entrypoint for the publisher worker. Run as a long-lived process:
 *   pnpm --filter @hive/blog exec tsx lib/lite/publisher/run-worker.ts
 *
 * Requires a real broadcaster injected via setBroadcaster in a bootstrap module
 * (the KMS-backed SignerServerWif, spec §D.2); until then it stays idle. Polls
 * for ready jobs and processes them one at a time.
 */
import { runPublisherOnce } from './worker';

const WORKER_ID = `worker-${process.pid}`;
const IDLE_POLL_MS = 5000;
const BUSY_POLL_MS = 250;

async function loop(): Promise<void> {
  for (;;) {
    let outcome: string;
    try {
      outcome = await runPublisherOnce(WORKER_ID);
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
