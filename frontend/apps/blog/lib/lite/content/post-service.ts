import { User } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { BeneficiaryRoute, LumenPost, ParentRef, PostTier, PublishPayload } from '../types';
import * as posts from '../repositories/post-repository';
import * as publishJobs from '../repositories/publish-job-repository';
import * as rateLimit from '../antispam/rate-limit';
import { checkLiteActor } from '../auth/account-status';
import { buildPermlink } from '../publisher/permlink';
import { reserveContainerParent } from '../publisher/container';
import * as containers from '../repositories/container-repository';
import { ulid } from '../ids';
import { preScreen } from './pre-screen';

const logger = getLogger('app');

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
/**
 * The on-chain parent a stored `parent_ref` names, or null to fall back to the
 * container.
 *
 * A stored ref is UNTRUSTED input: it was persisted verbatim from whatever the request
 * carried, so rows written before the intake validation existed can hold a blank
 * author. Returning that would build a root-post payload (the publisher branches on an
 * empty parent author) — and `buildPayload` now refuses it, which would make delete,
 * takedown and the whole orphan sweep throw on such a row. Treating a malformed ref as
 * "no explicit parent" keeps every one of those paths working: the post simply goes
 * under the container, which is where a lite post belongs anyway.
 */
function explicitParent(parentRef: ParentRef | null): OnChainParent | null {
  if (parentRef?.type === 'chain') {
    if (!parentRef.author?.trim() || !parentRef.permlink?.trim()) return null;
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
/**
 * The parent this post must be published under — pinned value first, always.
 *
 * A comment's parent can NEVER change on chain (hive_evaluator_social.cpp:294,302), so
 * every later job for a post — edit, delete-by-blanking, takedown — has to rebuild the
 * exact parent the original was published with. Recomputing it is not the same thing:
 * for a lite parent it is reconstructed from the CURRENT publishing account, so changing
 * that account (or rotating to a new one) makes every subsequent operation on an older
 * post fail permanently with "The parent of a comment cannot change". The pin is the
 * record of what actually happened; it outranks anything recomputed.
 */
async function publishParentFor(post: LumenPost): Promise<OnChainParent> {
  const pinned = await posts.getPublishParent(post.postId);
  if (pinned) return pinned;
  return explicitParent(post.parentRef) ?? (await containerParentFor(post.postId));
}

async function containerParentFor(postId: string): Promise<OnChainParent> {
  const pinned = await posts.getPublishParent(postId);
  if (pinned) return pinned;
  const container = await reserveContainerParent();
  // First-write-wins: a concurrent job's value is returned instead, if it got there
  // first, and the slot we just reserved is simply left unused.
  return posts.pinPublishParent(postId, container.author, container.permlink);
}

/**
 * Move an unpublished post off a container that can never open, onto a fresh one, and
 * rewrite its queued payload to match.
 *
 * Retiring a dead container frees the ACCOUNT to open a new one, but says nothing about
 * the posts already pinned to it — and the pin is first-write-wins, so without this
 * they would wait on that container forever, re-attempting its doomed root every 60
 * seconds on a path that never consults the attempt ceiling.
 */
export async function repointToFreshContainer(postId: string): Promise<boolean> {
  const post = await posts.getPostById(postId);
  if (!post || post.hivePermlink) return false;

  // ONLY for a container that has actually been retired. A container that simply has
  // not opened yet — blocked by Hive's five-minute root-post rule, say — is fine and
  // must be waited for; re-pointing on every such wait would churn through containers
  // and spend a root post each time.
  const pinned = await posts.getPublishParent(postId);
  if (!pinned) return false;
  const container = await containers.findByPermlink(pinned.author, pinned.permlink);
  if (container?.status !== 'failed') return false;

  if (!(await posts.unpinPublishParent(postId))) return false;
  const parent = await containerParentFor(postId);
  const refreshed = (await posts.getPostById(postId)) ?? post;
  // The queued job carries a frozen payload naming the dead parent; it has to be
  // rewritten too, or the worker keeps broadcasting toward the retired container.
  await publishJobs.updatePendingPayload(postId, buildPayload(refreshed, parent));
  logger.warn({ postId, parent }, 'Re-pointed a lite post onto a fresh container');
  return true;
}

/** Freeze the exact content the publisher will broadcast (spec §D.3). */
function buildPayload(post: LumenPost, parent: OnChainParent | null): PublishPayload {
  // Every lite post broadcasts as a comment, never a root post (decision
  // 2026-07-27) — Hive caps root posts at one per 5 minutes per account but
  // replies at one per 3 seconds. `parent` is resolved by the caller BEFORE the
  // post row is committed, so a failure to reserve a container can never leave a
  // post row with no publish path (the orphan bug found by the 2026-07-28 burst).
  // An empty parentAuthor is not "no parent" to the publisher — it is the signal for a
  // ROOT POST (hive-broadcaster.ts branches on exactly this field). Only container.ts
  // may ever produce one. Refusing here means no request shape, present or future, can
  // turn a lite post into a root post in a community of the caller's choosing.
  if (parent && !parent.author) {
    throw new Error('Refusing to build a lite post payload with an empty parent author');
  }
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
  req: CreatePostRequest,
  sessionEpoch?: number
): Promise<CreatePostResult> {
  // Status comes from the DB, not the cookie: a session issued before a suspension
  // would otherwise keep posting until it expired (see auth/account-status.ts).
  // F-L3: sessionEpoch carries the cookie stamp so a revoked session cannot post.
  const actor = await checkLiteActor(sessionUser, sessionEpoch);
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
    // ANY moderated post takes no further edits — not just a full takedown. Without
    // this, a sanction is reversible by its own author: the post is hidden or limited,
    // the author saves an edit, and the `update` job broadcasts the content straight
    // back. `author_only` was exactly that hole.
    if (existing.feedVisibility !== 'visible') {
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
      // F-L32: persist the edit's OWN screen result. Only reachable on an
      // already-visible post (guarded above), so this can only downgrade freshly
      // limited-worthy content — never undo a moderator decision.
      feedVisibility
    });
    const editParent = await publishParentFor(updated);
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
  // Pinned for EVERY post, including one with an explicit parent. A comment's parent
  // can never change on chain, so an edit, a delete-by-blanking or a takedown must
  // rebuild the exact same parent — and for explicit-parent posts nothing was pinned, so
  // those paths fell back to "the current container" and produced a payload Hive
  // refuses ("The parent of a comment cannot change"), silently, after the fact.
  const parent = await posts.pinPublishParent(
    post.postId,
    (explicit ?? reserved).author,
    (explicit ?? reserved).permlink
  );
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
  return posts.listRecent({ limit: Math.max(1, Math.min(opts.limit ?? 20, MAX_PAGE)), before: opts.before });
}

export async function getLiteUserPosts(
  userId: string,
  opts: { limit?: number; before?: string }
): Promise<LumenPost[]> {
  return posts.getUserPosts(userId, { limit: Math.max(1, Math.min(opts.limit ?? 20, MAX_PAGE)), before: opts.before });
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
/**
 * Queue an unpublished post for publishing again after a moderator restores it.
 *
 * Needed because cancelling marks the create job 'rejected', and nothing else revives
 * one: the held-job release only touches 'holding', the stuck-job reaper only
 * 'publishing', and the orphan sweep ignores any post that has a job row at all. A
 * fresh idempotency key is what lets a NEW job exist alongside the rejected one.
 */
export async function requeuePublish(post: LumenPost): Promise<boolean> {
  if (post.hivePermlink || post.deletedLocally) return false;
  try {
    const parent = await publishParentFor(post);
    const job = await publishJobs.enqueue({
      postId: post.postId,
      jobType: 'create',
      idempotencyKey: `${post.postId}:create:restored:${Date.now()}`,
      payload: buildPayload(post, parent)
    });
    return Boolean(job);
  } catch (error) {
    logger.error({ err: error, postId: post.postId }, 'Could not re-queue a restored post');
    return false;
  }
}

export async function reconcileOrphans(limit = 25): Promise<number> {
  const orphans = await posts.listOrphaned(limit);
  let repaired = 0;
  for (const post of orphans) {
    // Per-post, so one unrepairable row cannot stop every other user's posts being
    // repaired. This sweep runs at the top of every drain; a throw here used to take
    // the whole thing down.
    try {
      const parent = await publishParentFor(post);
      const job = await publishJobs.enqueue({
        postId: post.postId,
        jobType: 'create',
        idempotencyKey: `${post.postId}:create`,
        payload: buildPayload(post, parent)
      });
      if (job) repaired++;
    } catch (error) {
      logger.error({ err: error, postId: post.postId }, 'Lite orphan repair failed for one post');
    }
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

  // A queued EDIT must not outlive the delete. Jobs are claimed by `next_attempt_at`,
  // so an update rescheduled after a transient failure can run AFTER the delete and
  // republish the removed content — Hive's comment op is an upsert, so the object simply
  // comes back, invisible in Lumen because the row stays deleted.
  await publishJobs.cancelPendingUpdates(postId, 'post deleted');

  const parent = await publishParentFor(post);
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
    const cancelledJobs =
      (await publishJobs.cancelPending(postId, 'removed by moderation')) +
      // Same reason as delete: a rescheduled edit would republish what was taken down.
      (await publishJobs.cancelPendingUpdates(postId, 'removed by moderation'));
    return { onChain: false, cancelledJobs, queuedDelete: false };
  }

  const parent = await publishParentFor(post);
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
