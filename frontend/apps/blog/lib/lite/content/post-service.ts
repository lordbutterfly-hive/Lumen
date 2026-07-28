import { User } from '@smart-signer/types/common';
import { liteConfig } from '../config';
import { BeneficiaryRoute, LumenPost, ParentRef, PostTier, PublishPayload } from '../types';
import * as posts from '../repositories/post-repository';
import * as publishJobs from '../repositories/publish-job-repository';
import * as rateLimit from '../antispam/rate-limit';
import { checkLiteActor } from '../auth/account-status';
import { buildPermlink } from '../publisher/permlink';
import { reserveContainerParent } from '../publisher/container';
import { ulid } from '../ids';
import { preScreen } from './pre-screen';

/**
 * Intake service for lite posts (spec §C). Identity is taken from the session,
 * never the client. NORMAL and ADVANCED both land here and become a `lumen_post`
 * row (the system of record); the async publisher broadcasts later (Phase 4).
 */

const NORMAL_TAG = 'lumen';

export interface CreatePostRequest {
  tier: PostTier;
  body: string;
  title?: string;
  summary?: string;
  tags?: string[];
  community?: string;
  beneficiaries?: BeneficiaryRoute[];
  thumbnailUrl?: string;
  parentRef?: ParentRef;
  editOfPostId?: string;
}

export type CreatePostResult =
  | { status: 'ok'; post: LumenPost }
  | { status: 'error'; code: string; message: string };

/** Derive a title from the first line of the body for NORMAL posts. */
function autoTitle(body: string): string {
  const firstLine = body
    .trim()
    .split('\n')[0]
    .replace(/[#*_>`~-]/g, '')
    .trim();
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}...`;
}

/** The on-chain thing a post hangs off: a real Hive post, a lite post, or a container. */
interface OnChainParent {
  author: string;
  permlink: string;
}

/**
 * The parent a user explicitly chose, if any. `null` means "no explicit parent" —
 * which is every ordinary post, and those go under the rolling container.
 */
function explicitParent(parentRef: ParentRef | null): OnChainParent | null {
  if (parentRef?.type === 'chain') {
    return { author: parentRef.author, permlink: parentRef.permlink };
  }
  if (parentRef?.type === 'lite') {
    return { author: liteConfig.frontendAccount, permlink: buildPermlink(parentRef.id) };
  }
  return null;
}

/**
 * The container parent for a post, pinned so it can never change.
 *
 * Hive asserts "The parent of a comment cannot change."
 * (hive_evaluator_social.cpp:294/302), so an edit published after the container
 * rotated must still name the container the create used. First publish pins it;
 * every later payload reuses it.
 */
async function containerParentFor(postId: string): Promise<OnChainParent> {
  const pinned = await posts.getPublishParent(postId);
  if (pinned) return pinned;
  const container = await reserveContainerParent();
  // First-write-wins: a concurrent job's value is returned instead, if it got there
  // first, and the slot we just reserved is simply left unused.
  return posts.pinPublishParent(postId, container.author, container.permlink);
}

/** Freeze the exact content the publisher will broadcast (spec §D.3). */
function buildPayload(post: LumenPost, parent: OnChainParent | null): PublishPayload {
  // Every lite post broadcasts as a comment, never a root post (decision
  // 2026-07-27) — Hive caps root posts at one per 5 minutes per account but
  // replies at one per 3 seconds. `parent` is resolved by the caller BEFORE the
  // post row is committed, so a failure to reserve a container can never leave a
  // post row with no publish path (the orphan bug found by the 2026-07-28 burst).
  const parentAuthor = parent?.author ?? '';
  const parentPermlink = parent?.permlink ?? post.community ?? post.tags[0] ?? 'lumen';
  return {
    author: liteConfig.frontendAccount, // on-chain author (§D.1)
    permlink: buildPermlink(post.postId),
    parentAuthor,
    parentPermlink,
    title: post.title,
    body: post.body,
    tags: post.tags,
    displayName: post.displayNameSnapshot,
    userId: post.userId,
    postId: post.postId
  };
}

export async function createLitePost(
  sessionUser: User | undefined,
  req: CreatePostRequest
): Promise<CreatePostResult> {
  // Status comes from the DB, not the cookie: a session issued before a suspension
  // would otherwise keep posting until it expired (see auth/account-status.ts).
  const actor = await checkLiteActor(sessionUser);
  if (!actor.ok) {
    return { status: 'error', code: actor.code, message: actor.message };
  }
  // Identity from the row, not the cookie: the cookie's copy of the name can be
  // stale, and it is the value stamped into the on-chain footer.
  const { userId, displayName } = actor.user;
  if (req.tier !== 'normal' && req.tier !== 'advanced') {
    return { status: 'error', code: 'invalid_tier', message: 'Invalid post tier.' };
  }

  const body = typeof req.body === 'string' ? req.body : '';
  const title = req.tier === 'normal' ? (req.title?.trim() || autoTitle(body)) : (req.title?.trim() ?? '');
  if (req.tier === 'advanced' && title.length === 0) {
    return { status: 'error', code: 'title_required', message: 'Advanced posts need a title.' };
  }

  const screen = preScreen({ title, body });
  if (screen.action === 'reject') {
    return { status: 'error', code: `rejected_${screen.reason}`, message: 'Post rejected by content check.' };
  }
  const feedVisibility = screen.feedVisibility;

  const tags = req.tier === 'normal' ? [NORMAL_TAG] : req.tags?.length ? req.tags : [NORMAL_TAG];

  // Edit fork — update the original row instead of creating a duplicate (§C.3).
  if (req.editOfPostId) {
    const existing = await posts.getPostById(req.editOfPostId);
    if (!existing || existing.userId !== userId) {
      return { status: 'error', code: 'not_found', message: 'Post not found.' };
    }
    // A deleted post takes no further edits. Nothing else enforced this, so an
    // edit could have resurrected content the user had removed.
    if (existing.deletedAt || existing.deletedLocally) {
      return { status: 'error', code: 'deleted', message: 'That post has been deleted.' };
    }
    // A moderator-hidden post takes no further edits either. Without this, a takedown
    // is reversible by its own author: the post is blanked on chain, the author saves
    // an edit, and the `update` job broadcasts the content straight back.
    if (existing.feedVisibility === 'hidden') {
      return {
        status: 'error',
        code: 'moderated',
        message: 'This post has been removed and can no longer be edited.'
      };
    }
    // Edits were exempt from every cap, which made them a queue-starvation vector:
    // the publishing account can broadcast ~20 things a minute in total, so an edit
    // loop could hold up everyone else's posts. Hive imposes no edit limit at all
    // (the old 24-hour window is dead code past HF17), so this cap is the only bound.
    const editRate = await rateLimit.enforceEditRate(userId);
    if (!editRate.ok) {
      return {
        status: 'error',
        code: 'edit_rate_limited',
        message: 'You have edited a lot today — please try again tomorrow.'
      };
    }
    const updated = await posts.updatePostContent(req.editOfPostId, {
      title,
      body,
      tags,
      summary: req.summary ?? null,
      thumbnailUrl: req.thumbnailUrl ?? null,
      feedVisibility
    });
    const editParent = explicitParent(updated.parentRef) ?? (await containerParentFor(updated.postId));
    const payload = buildPayload(updated, editParent);
    const version = await posts.bumpEditVersion(updated.postId);

    if (!updated.hivePermlink && (await publishJobs.updatePendingPayload(updated.postId, payload))) {
      // Not on chain yet and the create job is still pending: rewrite that job's
      // content. One broadcast total, carrying the edited text.
      return { status: 'ok', post: updated };
    }
    // Coalesce: if an edit is already queued for this post, replace its content so
    // the newest text wins. Otherwise queue one. Two separate jobs would let an
    // older edit land last and silently revert the newer one.
    if (!(await publishJobs.replacePendingUpdate(updated.postId, payload))) {
      await publishJobs.enqueue({
        postId: updated.postId,
        jobType: 'update',
        // Versioned, not random: distinct per edit (so a later edit is never
        // swallowed as a duplicate) but stable for retries of the same edit.
        idempotencyKey: `${updated.postId}:update:v${version}`,
        payload
      });
    }
    return { status: 'ok', post: updated };
  }

  // Per-account rate cap on NEW posts/comments (edits above are exempt). Spec §H.
  const rate = await rateLimit.enforcePostRate(
    userId,
    req.parentRef ? 'comment' : 'post'
  );
  if (!rate.ok) {
    return {
      status: 'error',
      code: 'rate_limited',
      message: 'Daily limit reached — please try again tomorrow.'
    };
  }

  // Reserve the on-chain parent BEFORE committing the post row. If the container
  // cannot be reserved, the request fails with nothing written — the alternative
  // (create first, reserve after) is what orphaned a post under concurrent load on
  // 2026-07-28: the row was committed, the reservation threw, and nothing ever
  // enqueued it.
  const explicit = explicitParent(req.parentRef ?? null);
  const reserved = explicit ?? (await reserveContainerParent());

  const post = await posts.createPost({
    userId,
    displayNameSnapshot: displayName, // immutable name at post time -> footer (§D.4)
    tier: req.tier,
    title,
    body,
    tags,
    community: req.community ?? null,
    beneficiaries: req.beneficiaries ?? [],
    thumbnailUrl: req.thumbnailUrl ?? null,
    summary: req.summary ?? null,
    parentRef: req.parentRef ?? null,
    feedVisibility,
    shard: liteConfig.frontendAccount || null
  });
  // Pin the parent to the row, then enqueue the proxy-publish (outbox). Idempotent
  // on post_id:create. `reconcileOrphans` (publisher) is the backstop if the
  // process dies between these two writes.
  const parent = explicit ?? (await posts.pinPublishParent(post.postId, reserved.author, reserved.permlink));
  await publishJobs.enqueue({
    postId: post.postId,
    jobType: 'create',
    idempotencyKey: `${post.postId}:create`,
    payload: buildPayload(post, parent)
  });
  return { status: 'ok', post };
}

const MAX_PAGE = 50;

export async function getLiteFeed(opts: { limit?: number; before?: string }): Promise<LumenPost[]> {
  return posts.listRecent({ limit: Math.min(opts.limit ?? 20, MAX_PAGE), before: opts.before });
}

export async function getLiteUserPosts(
  userId: string,
  opts: { limit?: number; before?: string }
): Promise<LumenPost[]> {
  return posts.getUserPosts(userId, { limit: Math.min(opts.limit ?? 20, MAX_PAGE), before: opts.before });
}

export async function getLitePost(postId: string): Promise<LumenPost | null> {
  return posts.getPostById(postId);
}

/**
 * Re-enqueue posts that have no publish job (orphans).
 *
 * A post row is committed before its job is enqueued, so a crash between those two
 * writes leaves a post that would silently never reach Hive. A 30-post concurrent
 * burst produced exactly one such orphan on 2026-07-28 (the container reservation
 * threw after the row was committed); the reservation order is fixed now, and this
 * is the backstop for every other way those two writes can come apart.
 *
 * Safe to call repeatedly: `enqueue` is idempotent on `post_id:create`.
 */
export async function reconcileOrphans(limit = 25): Promise<number> {
  const orphans = await posts.listOrphaned(limit);
  let repaired = 0;
  for (const post of orphans) {
    const parent =
      explicitParent(post.parentRef) ?? (await containerParentFor(post.postId));
    const job = await publishJobs.enqueue({
      postId: post.postId,
      jobType: 'create',
      idempotencyKey: `${post.postId}:create`,
      payload: buildPayload(post, parent)
    });
    if (job) repaired++;
  }
  return repaired;
}

export type DeletePostResult =
  | { status: 'ok'; onChain: boolean }
  | { status: 'error'; code: string; message: string };

/**
 * Delete a lite post.
 *
 * Two cases, and the difference matters:
 *  - **Not published yet** — hide it and cancel the pending publish job. Nothing
 *    ever reaches Hive, so there is nothing to undo.
 *  - **Already on chain** — hide it locally and queue a `delete` job. The worker
 *    tries a real `delete_comment`; Hive refuses that once a comment has replies,
 *    net-positive votes, or has paid out, so the worker falls back to blanking the
 *    content. Either way the user's view of "deleted" is honoured immediately.
 *
 * Idempotent: deleting twice is not an error.
 */
export async function deleteLitePost(userId: string, postId: string): Promise<DeletePostResult> {
  // Deliberately NOT gated on account status. Suspension stops an account creating and
  // engaging; taking your own content down is harm-reducing, and blocking it would
  // strand a suspended user's material in public with no way to withdraw it.
  const existing = await posts.getPostById(postId);
  if (!existing || existing.userId !== userId) {
    return { status: 'error', code: 'not_found', message: 'Post not found.' };
  }

  const post = (await posts.markDeleted(postId, userId)) ?? existing;

  if (!post.hivePermlink) {
    // Never broadcast: drop the queued create outright.
    await publishJobs.cancelPending(postId, 'post deleted before it was published');
    return { status: 'ok', onChain: false };
  }

  const parent = explicitParent(post.parentRef) ?? (await containerParentFor(post.postId));
  await publishJobs.enqueue({
    postId: post.postId,
    jobType: 'delete',
    idempotencyKey: `${post.postId}:delete`,
    payload: buildPayload(post, parent)
  });
  return { status: 'ok', onChain: true };
}

/**
 * Moderator takedown: stop this post reaching Hive, or remove it if it already did.
 *
 * Lives here rather than in the moderation service because the on-chain payload has
 * exactly one correct shape and one place that knows it — the pinned parent above
 * all, since Hive refuses any operation that would change a comment's parent.
 *
 * Hiding a post in Lumen does NOT remove it from Hive; that is what this adds. The
 * worker attempts a real `delete_comment` and falls back to blanking when Hive
 * refuses (replies, net-positive votes, or already paid out).
 */
export async function takeDownPost(postId: string): Promise<{
  onChain: boolean;
  cancelledJobs: number;
  queuedDelete: boolean;
}> {
  const post = await posts.getPostById(postId);
  if (!post) return { onChain: false, cancelledJobs: 0, queuedDelete: false };

  if (!post.hivePermlink) {
    const cancelledJobs = await publishJobs.cancelPending(postId, 'removed by moderation');
    return { onChain: false, cancelledJobs, queuedDelete: false };
  }

  const parent = explicitParent(post.parentRef) ?? (await containerParentFor(post.postId));
  const job = await publishJobs.enqueue({
    postId: post.postId,
    jobType: 'delete',
    idempotencyKey: `${post.postId}:delete`,
    payload: buildPayload(post, parent)
  });
  // `null` means a delete job already existed (the author beat us to it) — the
  // outcome the moderator wanted is already queued, so this is a success either way.
  return { onChain: true, cancelledJobs: 0, queuedDelete: job !== null };
}
