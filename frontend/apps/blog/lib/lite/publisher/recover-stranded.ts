/* eslint-disable no-console -- an ops entrypoint: its output IS the result. */
/**
 * Ops entrypoint for the stranded-content repair.
 *
 * Run when `/api/lite/publisher/health` reports `strandedPosts > 0`: posts that
 * Lumen is SERVING but that are not on Hive and have no job working on them. The
 * automatic sweep (`reconcileOrphans`) is bounded at three generations on purpose —
 * a post Hive keeps refusing must stop being retried — so recovering the ones past
 * that ceiling is a deliberate human decision, which is why it lives here and not in
 * the drain.
 *
 * ★ WHAT THIS DOES AND DOES NOT DO. It only QUEUES: it writes `publish_job` rows and
 * repairs the recorded on-chain parent of already-published replies. It broadcasts
 * nothing. The posts reach Hive on the next drain — so on an instance pointed at
 * MAINNET, read the list it prints before draining. Everything it queues can be
 * undone until then:
 *   DELETE FROM publish_job WHERE idempotency_key LIKE '%:create:recover:%';
 *
 * Usage (from apps/blog, with LITE_DATABASE_URL set):
 *   npx tsx lib/lite/publisher/recover-stranded.ts          # report only
 *   npx tsx lib/lite/publisher/recover-stranded.ts --apply  # queue them
 */
import { recoverStranded } from '../content/post-service';
import { listStranded } from '../repositories/post-repository';
import { queueHealth } from '../repositories/publish-job-repository';

const LIMIT = 500;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const health = await queueHealth();
  console.log(
    `queue: pending=${health.pending} holding=${health.holding} ` +
      `stranded=${health.strandedPosts} failedOperations=${health.failedOperations}`
  );

  const stranded = await listStranded(LIMIT);
  if (stranded.length === 0) {
    console.log('Nothing is stranded — no posts are being served that Hive has never seen.');
    return;
  }
  console.log(`\n${stranded.length} stranded post(s):`);
  for (const p of stranded) {
    console.log(`  ${p.postId}  ${p.title.replace(/\s+/g, ' ').slice(0, 60)}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing was queued. Re-run with --apply to queue these for publishing.');
    return;
  }
  const report = await recoverStranded(LIMIT);
  console.log(
    `\nQueued ${report.requeued} of ${report.stranded} stranded post(s); ` +
      `repaired ${report.parentsRepaired} placeholder parent(s).\n` +
      'They reach Hive on the NEXT DRAIN. Until then, undo with:\n' +
      "  DELETE FROM publish_job WHERE idempotency_key LIKE '%:create:recover:%';"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('recover-stranded failed:', error);
    process.exit(1);
  });
