import { User } from '@smart-signer/types/common';
import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { BeneficiaryRoute, LumenPost, ParentRef, PostTier, PublishPayload, SessionRef } from '../types';
import * as posts from '../repositories/post-repository';
import * as publishJobs from '../repositories/publish-job-repository';
import * as rateLimit from '../antispam/rate-limit';
import { checkLiteActor } from '../auth/account-status';
import { buildPermlink } from '../publisher/permlink';
import { reserveContainerParent } from '../publisher/container';
import * as containers from '../repositories/container-repository';
import { ulid } from '../ids';
import { preScreen } from './pre-screen';
import { shortPostTitle } from '@/blog/lib/short-post-title';
import { publishTagsForInterests } from '../interests/taxonomy';

const logger = getLogger('app');

/**
 * Intake service for lite posts (spec §C). Identity is taken from the session,
 * never the client. NORMAL and ADVANCED both land here and become a `lumen_post`
 * row (the system of record); the async publisher broadcasts later (Phase 4).
 */

const NORMAL_TAG = 'lumen';

/**
 * ★★★ A NORMAL-TIER POST CARRIES THE AUTHOR'S DECLARED INTERESTS (2026-08-08,
 * owner: "authors declared interests carry into ranker for post").
 *
 * THE DEFECT THIS CLOSES. Every normal-tier post used to publish with tags
 * hardcoded to `['lumen']` — 99 of 112 posts in the database. The ranker's
 * interest lane matches a post's tags against the reader's DERIVED interests
 * (mined from their own posting and voting history), and no Hive reader will
 * ever derive `lumen`. So a lite post could not enter the tag lane, could not
 * enter the newcomer lane (which reads the primary tag), and was invisible to
 * the ranking engine in every direction. The tier the product exists for was
 * structurally unrankable, by a constant.
 *
 * WHY THE INTEREST TAG GOES FIRST. `tags[0]` is the primary tag, and the
 * newcomer lane keys on it (`exploration._interest_match`, restricted to the
 * primary tag by ruling R3 after one sock tagged 12 topics and reached 60/60
 * viewers). Leading with `lumen` would leave that lane just as shut. `lumen`
 * stays in the list, last, so a lite post is still identifiable on chain.
 *
 * WHY IT IS CAPPED. Tags are attacker-chosen free text everywhere else on this
 * chain; a cap keeps an honest post honest and stops this becoming a spray
 * vector. The scoring side is already bounded — the declared-interest raw is a
 * rarity-weighted MAX, so the 2nd..kth matching tag is worth exactly zero — but
 * sourcing is not: every extra tag is another lane a post can enter. Four plus
 * `lumen` is a real post describing itself, not a net.
 *
 * An author who declared nothing still gets `['lumen']`, exactly as before.
 *
 * ★★★ ONE TAG PER INTEREST, NOT THE FIRST FOUR OF THE FLATTENED LIST
 * (2026-08-09). `tagsForInterests` is the ranker's SOURCING vocabulary — wide on
 * purpose, and it carries community ids (`hive-13323`), photo-challenge tags
 * (`monomad`) and app tags (`liketu`) that are excellent evidence of subject and
 * are lies when written onto a post. Slicing it also drew all four tags from the
 * reader's FIRST pick, because every interest holds four or more: Photography +
 * Chess + Food published `[photography, photofeed, photographylovers, photo]` —
 * one interest, four spellings, no chess, no food.
 *
 * `publishTagsForInterests` returns each picked interest's ONE canonical topic
 * word, in the reader's pick order, so the cap now spends its four slots on four
 * different interests and every tag is a word a person could have typed. See
 * that function for the invariant that keeps a community id out of `tags[0]` —
 * which on Hive is the post's CATEGORY.
 */
const MAX_INTEREST_TAGS = 4;

function normalTierTags(interests: readonly string[] | null | undefined): string[] {
  const mapped = publishTagsForInterests(interests ?? []);
  if (mapped.length === 0) return [NORMAL_TAG];
  return [...mapped.slice(0, MAX_INTEREST_TAGS), NORMAL_TAG];
}

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

/**
 * Derive a title from the first line of the body for NORMAL posts.
 * The rule lives in lib/short-post-title.ts so the browser composer (which
 * titles a Hive-keyed account's short post) cannot drift from it.
 */
const autoTitle = shortPostTitle;

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
  session: SessionRef
): Promise<CreatePostResult> {
  // Status comes from the DB, not the cookie: a session issued before a suspension
  // would otherwise keep posting until it expired (see auth/account-status.ts).
  // F-L3: the caller's session carries the cookie stamp AND its per-device id, so
  // neither an account-wide revocation nor a single device's sign-out can post.
  const actor = await checkLiteActor(sessionUser, session);
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

  const tags =
    req.tier === 'normal'
      ? normalTierTags(actor.user.interests)
      : req.tags?.length
        ? req.tags
        : [NORMAL_TAG];

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
  opts: { limit?: number; before?: string; visibleOnly?: boolean; kind?: 'posts' | 'comments' | 'all' }
): Promise<LumenPost[]> {
  return posts.getUserPosts(userId, {
    limit: Math.max(1, Math.min(opts.limit ?? 20, MAX_PAGE)),
    before: opts.before,
    visibleOnly: opts.visibleOnly,
    kind: opts.kind
  });
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

/**
 * Put an unpublished post back on the road to Hive, whatever stopped it.
 *
 * There are now two ways a post can be off the road and they need opposite repairs,
 * which is why the restore path cannot just call `requeuePublish`:
 *  - its job was CANCELLED ('rejected' by a hide) — nothing revives that, so mint a
 *    new one with a fresh idempotency key;
 *  - its job was PARKED ('holding' by a hide the worker caught, or by a suspension)
 *    — the job is intact and only needs releasing. Queueing a second one here would
 *    leave two create jobs racing for the same permlink.
 *
 * Release first, and only mint when there is genuinely nothing left alive.
 */
export async function revivePublish(post: LumenPost): Promise<boolean> {
  if (post.hivePermlink || post.deletedLocally) return false;
  if ((await publishJobs.releaseHeldForPost(post.postId)) > 0) return true;
  // Something is already on its way; a second job would only duplicate it.
  if (await publishJobs.hasLiveCreateJob(post.postId)) return true;
  return requeuePublish(post);
}

export async function reconcileOrphans(limit = 25): Promise<number> {
  // ★★★ RELEASE FIRST, AND WITHOUT A CALLBACK (2026-08-10).
  //
  // A job parked because its post was hidden is released by whoever un-hides it —
  // provided they call back. The 38 posts stranded on the live queue are the proof
  // that something hid them and never did. So the sweep reconciles the STATE instead
  // of trusting the mutator: a post that is visible, undeleted, and written by an
  // account in good standing is publishable, no matter what parked it or when.
  //
  // The author's status is part of that predicate inside `releaseHeldForPublishable`
  // — a suspension writes the same 'holding' status, and un-parking a suspended
  // account's queue would quietly undo the suspension.
  try {
    const released = await publishJobs.releaseHeldForPublishable(limit);
    if (released > 0) {
      logger.warn('reconcileOrphans: released %d parked publish job(s) whose post is visible again', released);
    }
  } catch (error) {
    logger.error({ err: error }, 'reconcileOrphans: could not release parked jobs');
  }

  // ★ B7: posts past their retry budget are NOT silently forgotten. They are
  // still being served to readers with `hive_permlink: null`, so an operator has
  // to know they exist — this is the surface the old code had none of.
  try {
    const dead = await posts.listPermanentlyFailed(limit);
    if (dead.length > 0) {
      logger.error(
        'reconcileOrphans: %d post(s) have exhausted their publish attempts and will NEVER reach Hive without intervention — they are still being served: %s',
        dead.length,
        dead.map((p) => p.postId).join(', ')
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'reconcileOrphans: could not list permanently-failed posts');
  }

  const orphans = await posts.listOrphaned(limit);
  let repaired = 0;
  for (const post of orphans) {
    // Per-post, so one unrepairable row cannot stop every other user's posts being
    // repaired. This sweep runs at the top of every drain; a throw here used to take
    // the whole thing down.
    try {
      const parent = await publishParentFor(post);
      // ★ B7: a DISTINCT key per generation, or `ON CONFLICT DO NOTHING` makes
      // the retry a silent no-op and the post stays stranded. Generation 0 keeps
      // the historic `<postId>:create` key exactly, so nothing already queued
      // changes shape.
      const generation = await publishJobs.countJobsForPost(post.postId);
      const idempotencyKey =
        generation === 0 ? `${post.postId}:create` : `${post.postId}:create:r${generation}`;
      const job = await publishJobs.enqueue({
        postId: post.postId,
        jobType: 'create',
        idempotencyKey,
        payload: buildPayload(post, parent)
      });
      if (job && generation > 0) {
        logger.warn(
          'reconcileOrphans: RETRY %d for post %s — its previous publish job(s) died',
          generation,
          post.postId
        );
      }
      if (job) repaired++;
    } catch (error) {
      logger.error({ err: error, postId: post.postId }, 'Lite orphan repair failed for one post');
    }
  }
  return repaired;
}

export interface RecoveryReport {
  /** Posts that are served but off-chain with nothing working on them. */
  stranded: number;
  /** How many of those now have a live publish job again. */
  requeued: number;
  /** Already-published replies whose recorded parent was the local placeholder. */
  parentsRepaired: number;
  postIds: string[];
}

/**
 * ★★★ THE DELIBERATE, OPERATOR-DRIVEN REPAIR (2026-08-10).
 *
 * `reconcileOrphans` is the automatic sweep and it is BOUNDED on purpose — a post
 * Hive keeps refusing must stop being retried, or it spins every drain for the life
 * of the deployment. This is the other half: the human decision to try again anyway,
 * for the posts the bounded sweep has permanently written off.
 *
 * It is therefore NOT wired into the drain. Running it is a choice, made by someone
 * who has looked at `strandedPosts` on the health endpoint and decided those posts
 * should go to Hive after all. It mints a fresh idempotency key per post (a distinct
 * `:recover:` generation), so it can insert where the sweep's key would be swallowed
 * by ON CONFLICT DO NOTHING.
 *
 * Safe to run twice: a post that already has a live job is skipped, so a second run
 * is a no-op rather than a duplicate broadcast.
 */
export async function recoverStranded(limit = 100): Promise<RecoveryReport> {
  // Repair the recorded parent of already-published replies FIRST: it is what makes
  // a later edit or takedown of those rows possible at all, and it is what puts them
  // back in their own comment threads.
  let parentsRepaired = 0;
  try {
    parentsRepaired = await posts.repairPlaceholderPublishParent(limit);
    if (parentsRepaired > 0) {
      logger.warn(
        'recoverStranded: repaired the recorded on-chain parent of %d published lite reply/replies',
        parentsRepaired
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'recoverStranded: could not repair placeholder parents');
  }

  const stranded = await posts.listStranded(limit);
  let requeued = 0;
  for (const post of stranded) {
    try {
      const parent = await publishParentFor(post);
      const generation = await publishJobs.countJobsForPost(post.postId);
      const job = await publishJobs.enqueue({
        postId: post.postId,
        jobType: 'create',
        idempotencyKey: `${post.postId}:create:recover:${generation}`,
        payload: buildPayload(post, parent)
      });
      if (job) requeued++;
    } catch (error) {
      logger.error({ err: error, postId: post.postId }, 'recoverStranded: could not re-queue a post');
    }
  }
  logger.warn(
    'recoverStranded: %d stranded post(s) found, %d re-queued for publishing',
    stranded.length,
    requeued
  );
  return { stranded: stranded.length, requeued, parentsRepaired, postIds: stranded.map((p) => p.postId) };
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
