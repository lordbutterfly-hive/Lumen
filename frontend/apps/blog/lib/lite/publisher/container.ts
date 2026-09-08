import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import * as containers from '../repositories/container-repository';
import { containerPermlink } from '../repositories/container-repository';
import { CommentOp, PostBroadcaster } from './broadcaster';
import { noteBroadcast, pauseForCommentInterval } from './pace';

const logger = getLogger('app');

/**
 * Container posts (decision 2026-07-27). Every lite post is broadcast as a comment
 * under a rolling container root post owned by the publishing account, because Hive
 * caps ROOT posts at one per 5 minutes per account but replies at one per 3 seconds
 * — the mechanism behind PeakD Snaps, Ecency Waves and InLeo Threads.
 *
 * Ordering rule this module exists to enforce: a child comment must never be
 * broadcast under a container whose root post is not yet on chain, or the node
 * rejects it ("Comment with id/permlink … not found") and the job burns retries.
 */

export { containerPermlink };

/** Marker so the worker can recognise a container parent without a DB round-trip. */
export function isContainerPermlink(permlink: string): boolean {
  return permlink.startsWith('lumen-c-');
}

/**
 * The outcome of {@link ensureContainerPublished}, which the worker MUST branch on
 * (PUB-01/PUB-02). The old boolean collapsed two cases that need opposite handling:
 *
 *   - 'ready'   the container root is on chain — broadcast the child.
 *   - 'waiting' a REAL container row exists whose root is not on chain YET (Hive's
 *               5-minute root-post rule, or a transient node error). It WILL open, so
 *               the caller waits WITHOUT spending the child's retry budget — the same
 *               rule the worker already applies to a merely-slow parent.
 *   - 'absent'  no container row exists (a forged/never-created parentRef) OR one that
 *               has been retired. It can NEVER open on its own, so the caller must
 *               re-point to a fresh container, and failing that BOUND the wait by the
 *               attempt ceiling instead of looping forever (the PUB-01/PUB-02 root).
 */
export type ContainerReadiness = 'ready' | 'waiting' | 'absent';

/** Reserve a slot for a new post; returns the parent to publish it under. */
export async function reserveContainerParent(): Promise<{ author: string; permlink: string }> {
  const author = liteConfig.frontendAccount;
  if (!author) throw new Error('LITE_FRONTEND_ACCOUNT_* is not configured — no container owner');
  const container = await containers.reserveChildSlot(author, liteConfig.containerMaxChildren);
  return { author: container.hiveAuthor, permlink: container.hivePermlink };
}

function containerTitle(): string {
  // Human-readable and stable per container; the date is informational only.
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
    now.getUTCDate()
  ).padStart(2, '0')}`;
  return `Lumen posts — ${stamp}`;
}

const CONTAINER_BODY = [
  'This post is a **container**. The replies below are posts written on Lumen by',
  'people using Lumen accounts — each reply names its author, and each one declines',
  'all rewards.',
  '',
  'Container posts exist because Hive allows one top-level post per account every',
  'five minutes, but a reply every three seconds. Publishing through a container is',
  'what lets many people post through one account without queueing behind each',
  'other. It is the same mechanism Snaps, Waves and Threads use.'
].join('\n');

/** The container's own root-post operation. No author footer — it is not a user post. */
function buildContainerOp(containerId: string, author: string): CommentOp {
  return {
    parentAuthor: '',
    parentPermlink: 'lumen',
    author,
    permlink: containerPermlink(containerId),
    title: containerTitle(),
    body: CONTAINER_BODY,
    jsonMetadata: JSON.stringify({
      app: 'lumen/1.0',
      format: 'markdown',
      tags: ['lumen'],
      lumen_container: containerId
    }),
    declinePayout: true
  };
}

/**
 * Make sure the container behind `(author, permlink)` is on chain, publishing its
 * root post if it is not. Returns false when the container is not ready yet — the
 * caller must reschedule the child rather than broadcast it.
 *
 * The container root IS a root post, so it is itself subject to the 5-minute rule;
 * a failure here is normal right after the account published something else, and is
 * simply retried.
 */
/**
 * Is this failure one that retrying cannot fix? Mirrors the worker's own classifier —
 * the two must agree, or a job and its container disagree about whether to keep trying.
 * Deliberately conservative: anything unrecognised is treated as transient and retried.
 */
function permanentContainerFailure(message: string): boolean {
  const msg = message.toLowerCase();
  // Deliberately NARROWER than the worker's job classifier. Retiring a container is
  // destructive for everything already slotted into it, so only failures that are
  // unambiguously about US — our key, our configuration, our operation — qualify.
  // "invalid" and "validate" are excluded on purpose: a gateway or node error whose text
  // happens to contain them would otherwise retire a perfectly good container.
  return (
    msg.includes('authority') ||
    msg.includes('not configured') ||
    msg.includes('refusing') ||
    msg.includes('missing required')
  );
}

export async function ensureContainerPublished(
  broadcaster: PostBroadcaster,
  author: string,
  permlink: string
): Promise<ContainerReadiness> {
  const container = await containers.findByPermlink(author, permlink);
  if (!container) {
    // No such container row. A forged parentRef pins a `lumen-c-*` permlink that was
    // never created; this can NEVER open. 'absent' tells the worker to bound the wait
    // by the attempt ceiling instead of looping on it forever (PUB-01/PUB-02).
    logger.error('Container %s/%s is referenced by a job but missing from the DB', author, permlink);
    return 'absent';
  }
  if (container.publishedAt) return 'ready';

  // Crash-after-broadcast guard, same as the post path: it may already be on chain.
  if (await broadcaster.postExists(author, permlink)) {
    await containers.markPublished(container.containerId);
    return 'ready';
  }

  // A retired container is never retried: the children pinned to it are re-pointed by
  // the caller instead. Without this the worker re-attempted the doomed root every 60
  // seconds. It will never open on its own — 'absent' (re-point, else bound).
  if (container.status === 'failed') return 'absent';

  try {
    // The container root counts against the same 3 s interval its children use.
    await pauseForCommentInterval();
    await broadcaster.broadcastComment(buildContainerOp(container.containerId, author));
    noteBroadcast();
    await containers.markPublished(container.containerId);
    logger.info('Opened Lumen container %s/%s', author, permlink);
    return 'ready';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A container that cannot open for a NON-transient reason must be retired, not
    // retried forever. Every child is queued behind this root and the worker's
    // container wait bypasses the attempt ceiling, so "forever" is literal: a rotated
    // key or a malformed op would hold up to a thousand posts, indefinitely, with the
    // real cause visible only in this row's `last_error`.
    if (permanentContainerFailure(message)) {
      await containers.abandon(container.containerId, message);
      logger.error(
        error,
        'Retiring container %s/%s — it cannot be opened; the next post will start a fresh one',
        author,
        permlink
      );
      // Now retired: 'absent' so the child is re-pointed (or bounded) rather than
      // waiting forever on a root that has been abandoned.
      return 'absent';
    }
    await containers.recordError(container.containerId, message);
    logger.error(error, 'Could not open container %s/%s', author, permlink);
    // Transient: the container row still exists and this root can still open on a
    // later tick. 'waiting' — a legitimate wait that must not burn the child's budget.
    return 'waiting';
  }
}
