import { getLogger } from '@ui/lib/logging';
import { FeedVisibility, LumenPost, LumenUser } from '../types';
import * as users from '../repositories/user-repository';
import * as posts from '../repositories/post-repository';
import * as publishJobs from '../repositories/publish-job-repository';
import * as log from '../repositories/moderation-repository';
import { requeuePublish, takeDownPost } from '../content/post-service';

const logger = getLogger('app');

/**
 * Moderation actions and their consequences (spec §I).
 *
 * The rule that shapes everything here: **Lumen can hide, Hive cannot forget.**
 * Suspending an account or hiding a post changes what Lumen shows and what Lumen will
 * broadcast — it does not reach back into the blockchain. So every result says
 * plainly what happened locally and what is still on chain, and a takedown is a
 * separate, explicit step that queues the on-chain removal.
 *
 * Suspension parks queued posts rather than cancelling them, so reinstating is a
 * true undo.
 */

export type UserAction = 'suspend' | 'ban' | 'reinstate';

export interface ModerateUserResult {
  user: LumenUser;
  /** Not-yet-broadcast jobs parked (suspend/ban) or released (reinstate). */
  jobsHeld: number;
  jobsReleased: number;
  /** Posts whose Lumen visibility changed, when `hideContent` was asked for. */
  postsHidden: number;
  postsRestored: number;
  /** Posts of theirs already on Hive. Hiding locally does NOT remove these. */
  postsOnChain: number;
}

const STATUS_FOR: Record<UserAction, 'active' | 'suspended' | 'banned'> = {
  suspend: 'suspended',
  ban: 'banned',
  reinstate: 'active'
};

export async function moderateUser(input: {
  actor: string;
  userId: string;
  action: UserAction;
  reason?: string | null;
  /** Also hide (or, on reinstate, restore) every post by this author in Lumen. */
  hideContent?: boolean;
}): Promise<ModerateUserResult | null> {
  const status = STATUS_FOR[input.action];
  const user = await users.setUserStatus(input.userId, status, input.reason ?? null);
  if (!user) return null;

  const reinstating = input.action === 'reinstate';
  const reasonText = input.reason ?? `account ${status}`;

  const jobsHeld = reinstating ? 0 : await publishJobs.holdPendingForUser(input.userId, reasonText);
  const jobsReleased = reinstating ? await publishJobs.releaseHeldForUser(input.userId) : 0;

  let postsHidden = 0;
  let postsRestored = 0;
  if (input.hideContent) {
    if (reinstating) {
      postsRestored = await posts.setFeedVisibilityForUser(input.userId, 'visible');
    } else {
      postsHidden = await posts.setFeedVisibilityForUser(input.userId, 'hidden');
    }
  }

  const postsOnChain = await posts.countPublishedByUser(input.userId);

  await log.recordAction({
    actor: input.actor,
    targetType: 'user',
    targetId: input.userId,
    action: input.action,
    reason: input.reason ?? null,
    detail: { jobsHeld, jobsReleased, postsHidden, postsRestored, postsOnChain }
  });

  logger.info(
    'Moderation: %s %s by %s (jobs held %d / released %d, posts hidden %d / restored %d, %d already on chain)',
    input.action,
    input.userId,
    input.actor,
    jobsHeld,
    jobsReleased,
    postsHidden,
    postsRestored,
    postsOnChain
  );

  return { user, jobsHeld, jobsReleased, postsHidden, postsRestored, postsOnChain };
}

export interface ModeratePostResult {
  post: LumenPost;
  /** True when a chain removal was requested and queued. */
  takedownQueued: boolean;
  cancelledJobs: number;
  /** True when restoring visibility queued the post for publishing again. */
  requeued?: boolean;
  /** True while the post is still on Hive — a local hide never changes this. */
  onChain: boolean;
}

const ACTION_FOR: Record<FeedVisibility, log.ModerationActionName> = {
  hidden: 'hide',
  author_only: 'author_only',
  visible: 'unhide'
};

export async function moderatePost(input: {
  actor: string;
  postId: string;
  visibility: FeedVisibility;
  reason?: string | null;
  /** Also remove it from Hive (blank it if Hive refuses the delete). */
  takedown?: boolean;
}): Promise<ModeratePostResult | null> {
  const post = await posts.setFeedVisibility(input.postId, input.visibility);
  if (!post) return null;

  // A takedown only makes sense alongside hiding it here; restoring visibility does
  // not un-delete anything on chain, and pretending otherwise would be a lie.
  const wantsTakedown = Boolean(input.takedown) && input.visibility === 'hidden';
  // ★ A post that has NOT reached Hive yet must be stopped from doing so, whatever else
  // this call does. Hiding it only in our database left the queued job untouched, so
  // the worker broadcast the removed content minutes later — permanent and public,
  // under our publishing account. `takedown` could prevent it, but only when the
  // moderator also chose `hidden`; for `author_only` there was no combination that
  // worked. Cancelling is safe: the post is already hidden here, and a restore
  // re-queues it.
  const stoppedBeforePublish =
    !post.hivePermlink && input.visibility !== 'visible'
      ? await publishJobs.cancelPending(input.postId, `moderated:${input.visibility}`)
      : 0;
  // ★ AND RESTORING MUST PUT IT BACK. Cancelling marks the job 'rejected', which no
  // other path revives: `releaseHeldForUser` only touches 'holding', `reapStuck` only
  // 'publishing', and the orphan sweep skips any post that has a job row at all. So a
  // hide-then-restore left the post visible in Lumen and permanently unable to reach
  // Hive — silent, and unrecoverable without hand-written SQL.
  const requeued =
    !post.hivePermlink && input.visibility === 'visible'
      ? await requeuePublish(post)
      : false;
  const result = wantsTakedown
    ? await takeDownPost(input.postId)
    : {
        onChain: Boolean(post.hivePermlink),
        cancelledJobs: stoppedBeforePublish,
        queuedDelete: false,
        requeued
      };

  await log.recordAction({
    actor: input.actor,
    targetType: 'post',
    targetId: input.postId,
    action: wantsTakedown ? 'takedown' : ACTION_FOR[input.visibility],
    reason: input.reason ?? null,
    detail: {
      visibility: input.visibility,
      userId: post.userId,
      onChain: result.onChain,
      cancelledJobs: result.cancelledJobs,
      takedownQueued: result.queuedDelete
    }
  });

  return {
    post,
    takedownQueued: result.queuedDelete,
    cancelledJobs: result.cancelledJobs,
    onChain: result.onChain
  };
}

export const listActions = log.listActions;
