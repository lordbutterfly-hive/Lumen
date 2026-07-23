import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { PublishJob, PublishPayload } from '../types';
import * as jobs from '../repositories/publish-job-repository';
import * as posts from '../repositories/post-repository';
import { CommentOp, getBroadcaster, hasBroadcaster } from './broadcaster';
import { buildFooter, buildJsonMetadata } from './footer';

/**
 * Publisher worker (spec §D.3). Claims a ready job, builds the comment op authored
 * by the frontend account (footer + json_metadata appended at publish time),
 * broadcasts it, and writes the mapping back to `lumen_post`. Hive is the source
 * of truth for published content; the body may be pruned afterward (hybrid model).
 *
 * Stays idle until BOTH the feature is enabled AND a real broadcaster is injected,
 * so it can never spin against an unconfigured signer.
 */

const logger = getLogger('app');
const BACKOFF_SECONDS = [30, 120, 600, 3600];

function buildCommentOp(job: PublishJob): CommentOp {
  const p: PublishPayload = job.payloadSnapshot;
  // A delete is a body-blanking update once the post has on-chain interaction (§D.6).
  const body = job.jobType === 'delete' ? '' : `${p.body}${buildFooter(p.displayName)}`;
  const jsonMetadata = JSON.stringify(
    buildJsonMetadata({ tags: p.tags, userId: p.userId, postId: p.postId, displayName: p.displayName })
  );
  return {
    parentAuthor: '',
    parentPermlink: p.parentPermlink,
    author: p.author,
    permlink: p.permlink,
    title: p.title,
    body,
    jsonMetadata,
    // Lite posts reject all rewards (decision 2026-07-23) — no per-user earnings,
    // no platform beneficiary; the broadcaster declines payout entirely.
    declinePayout: true
  };
}

function isRetriable(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Terminal: content/authority problems won't fix themselves on retry.
  if (
    msg.includes('duplicate') ||
    msg.includes('invalid') ||
    msg.includes('validate') ||
    msg.includes('authority') ||
    msg.includes('not configured')
  ) {
    return false;
  }
  // Everything else (network, RC, timeout, node error) is worth a retry.
  return true;
}

export type ProcessOutcome = 'idle' | 'processed' | 'failed';

/** Process at most one job. Returns 'idle' when there is nothing to do. */
export async function runPublisherOnce(workerId: string): Promise<ProcessOutcome> {
  if (!liteConfig.enabled || !hasBroadcaster()) return 'idle';

  const job = await jobs.claimNext(workerId);
  if (!job) return 'idle';

  const { author, permlink } = job.payloadSnapshot;
  try {
    const broadcaster = getBroadcaster();

    // Crash-after-broadcast guard: if it's already on-chain, just finish the job.
    const already = await broadcaster.postExists(author, permlink);
    if (!already) {
      await broadcaster.broadcastComment(buildCommentOp(job));
    }

    await jobs.markPublished(job.jobId);
    await posts.markPostPublished(job.postId, author, permlink, {
      pruneBody: liteConfig.pruneBodyAfterPublish
    });
    return 'processed';
  } catch (error) {
    const retriable = isRetriable(error);
    const message = error instanceof Error ? error.message : String(error);
    if (retriable && job.attempts < job.maxAttempts) {
      const backoff = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
      await jobs.reschedule(job.jobId, message, backoff);
    } else {
      await jobs.markTerminal(job.jobId, message, retriable ? 'failed' : 'rejected');
    }
    logger.error(error, 'Publisher job %s failed (retriable=%s)', job.jobId, retriable);
    return 'failed';
  }
}
