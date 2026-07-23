import { User } from '@smart-signer/types/common';
import { liteConfig } from '../config';
import { BeneficiaryRoute, LumenPost, ParentRef, PostTier, PublishPayload } from '../types';
import * as posts from '../repositories/post-repository';
import * as publishJobs from '../repositories/publish-job-repository';
import * as rateLimit from '../antispam/rate-limit';
import { buildPermlink } from '../publisher/permlink';
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

/** Freeze the exact content the publisher will broadcast (spec §D.3). */
function buildPayload(post: LumenPost): PublishPayload {
  // Resolve the on-chain parent so a lite reply broadcasts as a real reply, not a
  // root post. A chain parent replies directly under the Hive author/permlink; a
  // lite parent replies under the frontend account's deterministic permlink for
  // that post; no parent is a root post (parent_author='').
  const parent = post.parentRef;
  let parentAuthor = '';
  let parentPermlink = post.community ?? post.tags[0] ?? 'lumen';
  if (parent?.type === 'chain') {
    parentAuthor = parent.author;
    parentPermlink = parent.permlink;
  } else if (parent?.type === 'lite') {
    parentAuthor = liteConfig.frontendAccount;
    parentPermlink = buildPermlink(parent.id);
  }
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
  if (!sessionUser?.userId || sessionUser.account_tier !== 'lite') {
    return { status: 'error', code: 'unauthorized', message: 'Not signed in as a lite account.' };
  }
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
    if (!existing || existing.userId !== sessionUser.userId) {
      return { status: 'error', code: 'not_found', message: 'Post not found.' };
    }
    const updated = await posts.updatePostContent(req.editOfPostId, {
      title,
      body,
      tags,
      summary: req.summary ?? null,
      thumbnailUrl: req.thumbnailUrl ?? null,
      feedVisibility
    });
    const payload = buildPayload(updated);
    if (updated.hivePermlink) {
      // Already on chain -> broadcast an edit to the same permlink.
      await publishJobs.enqueue({
        postId: updated.postId,
        jobType: 'update',
        idempotencyKey: `${updated.postId}:update:${ulid()}`,
        payload
      });
    } else if (!(await publishJobs.updatePendingPayload(updated.postId, payload))) {
      // No pending create job to refresh (already claimed) -> enqueue an update.
      await publishJobs.enqueue({
        postId: updated.postId,
        jobType: 'update',
        idempotencyKey: `${updated.postId}:update:${ulid()}`,
        payload
      });
    }
    return { status: 'ok', post: updated };
  }

  // Per-account rate cap on NEW posts/comments (edits above are exempt). Spec §H.
  const rate = await rateLimit.enforcePostRate(
    sessionUser.userId,
    req.parentRef ? 'comment' : 'post'
  );
  if (!rate.ok) {
    return {
      status: 'error',
      code: 'rate_limited',
      message: 'Daily limit reached — please try again tomorrow.'
    };
  }

  const post = await posts.createPost({
    userId: sessionUser.userId,
    displayNameSnapshot: sessionUser.username, // immutable name at post time -> footer (§D.4)
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
  // Enqueue the proxy-publish (outbox). Idempotent on post_id:create.
  await publishJobs.enqueue({
    postId: post.postId,
    jobType: 'create',
    idempotencyKey: `${post.postId}:create`,
    payload: buildPayload(post)
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
