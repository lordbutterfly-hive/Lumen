import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { PublishJob, PublishPayload } from '../types';
import * as jobs from '../repositories/publish-job-repository';
import * as posts from '../repositories/post-repository';
import { CommentOp, getBroadcaster, hasBroadcaster } from './broadcaster';
import { buildFooter, buildJsonMetadata } from './footer';
import { ensureContainerPublished, isContainerPermlink } from './container';
import { noteBroadcast, pauseForCommentInterval } from './pace';

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
/** A claim older than this with no outcome means the worker died holding it. */
const STUCK_JOB_SECONDS = 300;

function buildCommentOp(job: PublishJob): CommentOp {
  const p: PublishPayload = job.payloadSnapshot;
  const deleting = job.jobType === 'delete';
  // Soft delete (§D.6): used when Hive refuses a real delete_comment. Blank the
  // title too, and mark the metadata, so our own renderer can show "[deleted]"
  // instead of an empty card — an empty body alone reads as a broken post.
  const body = deleting ? '' : `${p.body}${buildFooter(p.displayName)}`;
  const jsonMetadata = JSON.stringify({
    ...buildJsonMetadata({ tags: p.tags, userId: p.userId, postId: p.postId, displayName: p.displayName }),
    ...(deleting ? { deleted: true } : {})
  });
  return {
    parentAuthor: p.parentAuthor,
    parentPermlink: p.parentPermlink,
    author: p.author,
    permlink: p.permlink,
    title: deleting ? '' : p.title,
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
    msg.includes('not configured') ||
    // Consensus refuses to repoint a comment (hive_evaluator_social.cpp:294/302).
    // Retrying can only fail again — and if this ever fires it means a payload was
    // built with a parent other than the pinned one, which is a bug to fix, not a
    // transient error to grind against.
    msg.includes('parent of a comment cannot change')
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

  // Recover jobs whose worker died mid-broadcast. Without this they sit in
  // 'publishing' forever — and that stall is the window in which an edit can
  // overtake its own create and silently revert a user's text.
  await jobs.reapStuck(STUCK_JOB_SECONDS);

  const job = await jobs.claimNext(workerId);
  if (!job) return 'idle';

  const { author, permlink } = job.payloadSnapshot;
  try {
    const broadcaster = getBroadcaster();

    // An edit/delete must never be broadcast before the post itself is on chain.
    // Hive's comment op is an UPSERT — the evaluator branches only on "does this
    // permlink already exist" — so an update that overtook its create would be
    // applied as a NEW post, and the late create would then be applied as an EDIT,
    // silently reverting the user's newer text with no error raised anywhere.
    if (job.jobType !== 'create') {
      const original = await posts.getPostById(job.postId);
      if (!original?.hivePermlink) {
        await jobs.reschedule(job.jobId, 'waiting for the original post to publish first', 30);
        return 'failed';
      }
    }

    // Crash-after-broadcast guard: if it's already on-chain, just finish the job.
    const already = await broadcaster.postExists(author, permlink);
    if (!already) {
      // A child can only be broadcast once its container root exists on chain —
      // otherwise the node rejects it ("Comment ... not found"). The container root
      // is itself a root post, so opening one can be blocked by the 5-minute rule;
      // that just reschedules this child.
      const { parentAuthor, parentPermlink } = job.payloadSnapshot;
      if (parentAuthor === author && isContainerPermlink(parentPermlink)) {
        const ready = await ensureContainerPublished(broadcaster, parentAuthor, parentPermlink);
        if (!ready) {
          await jobs.reschedule(job.jobId, 'waiting for container root to publish', 60);
          return 'failed';
        }
      }
      await pauseForCommentInterval();
      if (job.jobType === 'delete') {
        // Prefer a real delete_comment. Hive refuses it once the comment has
        // replies, net-positive votes, or has paid out
        // (hive_evaluator_social.cpp:60,66,68-69) — in that case blank the content
        // instead, which always works. `canDelete` fails closed, so an unreachable
        // node means we soft-delete rather than burn retries on a doomed op.
        if (await broadcaster.canDelete(author, permlink)) {
          await broadcaster.deleteComment(author, permlink);
        } else {
          await broadcaster.broadcastComment(buildCommentOp(job));
        }
      } else {
        await broadcaster.broadcastComment(buildCommentOp(job));
      }
      noteBroadcast();
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
