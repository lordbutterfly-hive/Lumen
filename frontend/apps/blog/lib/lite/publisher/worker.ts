import { getLogger } from '@ui/lib/logging';
import { liteConfig } from '../config';
import { PublishJob, PublishPayload } from '../types';
import * as jobs from '../repositories/publish-job-repository';
import * as posts from '../repositories/post-repository';
import { repointToFreshContainer } from '../content/post-service';
import { CommentOp, getBroadcaster, hasBroadcaster } from './broadcaster';
import { buildFooter, buildJsonMetadata } from './footer';
import { ensureContainerPublished, isContainerPermlink } from './container';
import { noteBroadcast, pauseForCommentInterval } from './pace';
import { checkRc } from './rc-guard';

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

/**
 * A Lumen post has TWO names, and a reply captured the wrong one.
 *
 * ★ THE BUG THIS FIXES (found 2026-08-08, replies never reached their threads).
 * A post is written locally under a placeholder permlink `lite-<ulid>` — that is
 * what Lumen's own URLs use before the post reaches Hive. The publisher then
 * broadcasts it under a DIFFERENT, deterministic name: `lumen-<ulid>`
 * (`buildPermlink`). A reply written against the post captured the placeholder,
 * so at broadcast time it asked Hive to comment on `hbd-temp/lite-<ulid>` — a
 * post that has never existed under that name. Hive threw `get_comment`
 * assert_exception, the job retried four times and died. Permanently: no amount
 * of resource credits or waiting could ever have fixed it, because the parent it
 * names does not exist and never will.
 *
 * Verified in the live queue: the reply's parent read
 * `hbd-temp/lite-01kzcnhwpw64xwbzf8jqa60e5p` while the parent post had genuinely
 * published as `hbd-temp/lumen-01kzcnhwpw64xwbzf8jqa60e5p`.
 *
 * So resolve the parent at BROADCAST time from our own records, rather than
 * trusting a name captured when the reply was typed:
 *   - parent published  -> use the real hive_author/hive_permlink
 *   - parent still queued -> WAIT (and do not spend an attempt on it)
 *   - parent gone       -> stop, with a reason a human can read
 */
type ParentResolution =
  | { kind: 'ready'; author: string; permlink: string }
  | { kind: 'wait'; why: string }
  | { kind: 'gone'; why: string };

const LOCAL_PERMLINK = /^lite-([0-9a-z]+)$/i;

/**
 * @param requireParentLive  Whether the parent still being visible is a PRECONDITION.
 *
 * ★ TRUE ONLY FOR A CREATE (2026-08-10). "Has the post I am replying to been taken
 * down?" is a question about whether a NEW reply should appear in that thread — for
 * a create it is exactly right to stop. For an edit or a takedown of a reply that is
 * ALREADY on chain it is the wrong question and a damaging answer: the parent's
 * chain identity is a fixed historical fact that Hive will demand verbatim
 * ("The parent of a comment cannot change"), and refusing to resolve it because the
 * parent was later hidden means the takedown of the CHILD can never execute. That is
 * how a moderator's removal of a lite reply became permanently impossible.
 */
async function resolveParentOnChain(
  parentAuthor: string,
  parentPermlink: string,
  { requireParentLive }: { requireParentLive: boolean }
): Promise<ParentResolution> {
  const local = LOCAL_PERMLINK.exec(parentPermlink);
  if (!local) return { kind: 'ready', author: parentAuthor, permlink: parentPermlink };

  const parentId = local[1];
  const parent = await posts.getPostById(parentId.toUpperCase());
  const asWritten: ParentResolution = { kind: 'ready', author: parentAuthor, permlink: parentPermlink };
  if (!parent) {
    // Best effort for an existing on-chain comment: the snapshot is all we have, and
    // it is strictly better than refusing to act on content that is public right now.
    if (!requireParentLive) return asWritten;
    return { kind: 'gone', why: `the post being replied to (${parentPermlink}) no longer exists` };
  }
  if (requireParentLive && (parent.deletedLocally || parent.feedVisibility !== 'visible')) {
    return { kind: 'gone', why: 'the post being replied to was deleted or removed' };
  }
  if (!parent.hiveAuthor || !parent.hivePermlink) {
    if (!requireParentLive) return asWritten;
    return { kind: 'wait', why: 'the post being replied to has not reached Hive yet' };
  }
  return { kind: 'ready', author: parent.hiveAuthor, permlink: parent.hivePermlink };
}

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
  //
  // `duplicate` is deliberately NOT here. It is the one error that means the broadcast
  // ALREADY LANDED — either the same transaction or the same permlink — so treating it
  // as terminal marked the job rejected while the content was live on Hive, leaving
  // `hive_permlink` NULL forever with no sweep able to find it (the orphan sweep skips
  // any post that has a job row). Retried, the `postExists` guard sees the post, skips
  // the broadcast and records the mapping correctly.
  if (
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

/**
 * ★ 'paused' EXISTS BECAUSE 'idle' WAS A LIE BY OMISSION.
 *
 * Three separate conditions used to return 'idle': the queue is empty, no
 * broadcaster is armed, and the account is out of resource credits. The drain
 * route reports that verbatim, so an operator polling it sees
 * `{"status":"ok","idle":1}` — "nothing to do" — while a backlog grows and the
 * real reason sits in a log line nobody is reading.
 *
 * Found 2026-08-07: 22 posts had been queued for 2h45m across many accounts
 * while the drain answered "ok, idle" every five seconds. The publisher's own
 * behaviour was CORRECT throughout (pausing below the RC floor is right —
 * grinding jobs into terminal failure because the account is broke is worse);
 * only its report of that behaviour was indistinguishable from healthy.
 */
export type ProcessOutcome = 'idle' | 'paused' | 'processed' | 'failed';

/** Why the publisher is not working, when it is not working. Read by the drain route. */
export let lastPauseReason: string | null = null;

/** Process at most one job. Returns 'idle' when there is nothing to do. */
export async function runPublisherOnce(workerId: string): Promise<ProcessOutcome> {
  if (!liteConfig.enabled) {
    lastPauseReason = 'lite accounts are disabled';
    return 'paused';
  }
  if (!hasBroadcaster()) {
    lastPauseReason = 'no broadcaster is armed — nothing can be published';
    return 'paused';
  }

  // Recover jobs whose worker died mid-broadcast. Without this they sit in
  // 'publishing' forever — and that stall is the window in which an edit can
  // overtake its own create and silently revert a user's text.
  await jobs.reapStuck(STUCK_JOB_SECONDS);

  // Look before spending: every broadcast costs resource credits, and grinding jobs
  // into terminal failure because the account is out of RC is worse than pausing.
  const rc = await checkRc();
  if (!rc.ok) {
    lastPauseReason = rc.reason ?? 'resource credits below the floor';
    return 'paused';
  }

  const job = await jobs.claimNext(workerId);
  if (!job) {
    // The only genuinely idle case: armed, funded, and nothing waiting.
    lastPauseReason = null;
    return 'idle';
  }
  lastPauseReason = null;

  const { author, permlink } = job.payloadSnapshot;
  try {
    const broadcaster = getBroadcaster();

    // ★ THE POST IS RE-READ BEFORE EVERY BROADCAST, INCLUDING CREATES.
    //
    // Cancelling a queued job only reaches jobs still 'pending' — correctly, since a
    // claimed job is mid-flight. But nothing else stopped a claimed create: between the
    // claim and the broadcast there is a network call, possibly a container root, and up
    // to 3.5 seconds of pacing, and a delete or a takedown landing in that window
    // matched no rows, reported success, and the worker published the removed content
    // anyway — permanently, publicly, under the shared account, with no sweep that could
    // ever find it again.
    const current = await posts.getPostById(job.postId);

    // An edit/delete must never be broadcast before the post itself is on chain.
    // Hive's comment op is an UPSERT — the evaluator branches only on "does this
    // permlink already exist" — so an update that overtook its create would be
    // applied as a NEW post, and the late create would then be applied as an EDIT,
    // silently reverting the user's newer text with no error raised anywhere.
    if (job.jobType !== 'create' && !current?.hivePermlink) {
      // A create that was cancelled or rejected will never arrive, so waiting for it is
      // waiting forever — and this path bypasses the attempt ceiling, so "forever" is
      // literal. Give up once the post has no live create job left.
      const pendingCreate = await jobs.hasLiveCreateJob(job.postId);
      if (!pendingCreate) {
        await jobs.markTerminal(job.jobId, 'the original post was never published', 'rejected');
        return 'failed';
      }
      await jobs.reschedule(job.jobId, 'waiting for the original post to publish first', 30);
      return 'failed';
    }

    // Crash-after-broadcast guard: if it's already on-chain, just finish the job.
    //
    // For a DELETE this reads the other way round — absence means the delete already
    // landed, not that it never ran. Treating it as "never ran" made the worker
    // re-broadcast the blank soft-delete stub onto the permlink it had just freed,
    // re-creating the object on chain.
    const already = await broadcaster.postExists(author, permlink);

    // ★★★ THE PARENT IS RESOLVED FOR *EVERY* JOB TYPE, BEFORE ANY OP IS BUILT
    // (2026-08-10). It used to be resolved only inside the `!already` branch, which a
    // `delete` returns before ever reaching — so a takedown of a lite REPLY built its
    // soft-delete op from the placeholder parent the row still carried, Hive answered
    // "The parent of a comment cannot change.", `isRetriable` (correctly) called that
    // terminal, and the job died. No retry, no operator surface, and the reply stayed
    // public forever. Proven on a real row.
    const { parentAuthor, parentPermlink } = job.payloadSnapshot;
    if (parentAuthor && parentPermlink) {
      // See resolveParentOnChain for why "is the parent still live?" is a create-only
      // precondition. An edit or a takedown acts on something already on chain.
      const parent = await resolveParentOnChain(parentAuthor, parentPermlink, {
        requireParentLive: job.jobType === 'create'
      });
      if (parent.kind === 'gone') {
        await jobs.markTerminal(job.jobId, parent.why, 'rejected');
        return 'failed';
      }
      if (parent.kind === 'wait') {
        // Deliberately NOT an attempt: waiting on a parent that is merely slow
        // must not burn the reply's five tries. That is how a reply to a
        // still-queued post became permanently undeliverable.
        await jobs.reschedule(job.jobId, parent.why, 60);
        return 'failed';
      }
      if (parent.permlink !== parentPermlink || parent.author !== parentAuthor) {
        job.payloadSnapshot.parentAuthor = parent.author;
        job.payloadSnapshot.parentPermlink = parent.permlink;
        // ★ AND WRITE IT DOWN. Mutating the in-memory payload made THIS broadcast
        // correct and left the row's record of the parent wrong, so every later job
        // for the post rebuilt the placeholder again. A no-op once the post is on
        // chain (the pin is a fact by then) — see posts.setPublishParent.
        await posts.setPublishParent(job.postId, parent.author, parent.permlink);
      }
    }

    // ★★★ DELETE IS HANDLED HERE, OUTSIDE THE `!already` GUARD (2026-08-06).
    //
    // THE BUG THIS FIXES, found by taking down a real post on mainnet: every
    // line below — including `deleteComment` — used to live inside `if
    // (!already)`. That guard exists so a CREATE job does not re-broadcast a
    // post already on chain. For a DELETE it reads exactly backwards:
    // `already === true` means "the comment is still there, so remove it", and
    // the code skipped the whole block and fell through to `markPublished`.
    //
    // So a takedown against a post that actually existed reported SUCCESS and
    // did nothing. The job went `published`, the row went hidden in Lumen, the
    // operator saw `takedownQueued: true` — and the content stayed on the public
    // chain, unchanged, `last_update` untouched. The only case that worked was
    // deleting something already gone.
    //
    // That is the moderation lever this product's entire abuse strategy rests
    // on: "someone tells me and I take it down myself."
    if (job.jobType === 'delete') {
      if (!already) {
        // Absence means the delete already landed, not that it never ran —
        // re-broadcasting here would put the blank soft-delete stub back onto
        // the permlink it had just freed, re-creating the object on chain.
        await jobs.markPublished(job.jobId);
        return 'processed';
      }
      await pauseForCommentInterval();
      // Prefer a real delete_comment. Hive refuses it once the comment has
      // replies, net-positive votes, or has paid out
      // (hive_evaluator_social.cpp:60,66,68-69) — in that case blank the content
      // instead, which always works. `canDelete` fails closed, so an unreachable
      // node soft-deletes rather than burning retries on a doomed op.
      if (await broadcaster.canDelete(author, permlink)) {
        await broadcaster.deleteComment(author, permlink);
      } else {
        await broadcaster.broadcastComment(buildCommentOp(job));
      }
      noteBroadcast();
      await jobs.markPublished(job.jobId);
      return 'processed';
    }

    // ★★★ `!already` IS A *CREATE* GUARD. IT ATE EVERY EDIT (2026-08-10).
    //
    // THE BUG THIS FIXES — the same shape as the DELETE one fixed on 2026-08-06, left
    // behind on the UPDATE path. The guard exists so a create that crashed after its
    // broadcast does not publish the post twice. For an `update` the post is on chain
    // BY DEFINITION, so `already` is always true, the whole block was skipped, and
    // control fell straight through to `markPublished` + `markPostPublished(...,
    // pruneBody: true)` — which sets `body = ''`.
    //
    // So every edit of a published lite post: never broadcast, and the edited text
    // ERASED from the only place it still existed. The job reported `published`,
    // queue health stayed green, and the post silently reverted to its pre-edit chain
    // text on every surface. Reproduced end to end: chain kept "ORIGINAL BODY", the
    // row's body was left empty, and the drain returned 'processed'.
    //
    // Hive's comment op is an UPSERT — re-broadcasting the same permlink with new
    // content IS the edit — so an update must ALWAYS broadcast. `delete` returned
    // above, so this is narrowed to 'create' | 'update'.
    const skipBroadcast = job.jobType === 'create' && already;
    if (!skipBroadcast) {
      // A child can only be broadcast once its container root exists on chain —
      // otherwise the node rejects it ("Comment ... not found"). The container root
      // is itself a root post, so opening one can be blocked by the 5-minute rule;
      // that just reschedules this child. (Parent resolution already happened above,
      // for every job type; these are the resolved values.)
      const { parentAuthor, parentPermlink } = job.payloadSnapshot;

      if (parentAuthor === author && isContainerPermlink(parentPermlink)) {
        const ready = await ensureContainerPublished(broadcaster, parentAuthor, parentPermlink);
        if (!ready) {
          // A container that has been RETIRED will never open, so waiting on it is
          // waiting forever — and this path does not consult the attempt ceiling. Move
          // the post to a fresh container instead and retry promptly.
          if (await repointToFreshContainer(job.postId)) {
            await jobs.reschedule(job.jobId, 'container retired — re-pointed to a fresh one', 5);
            return 'failed';
          }
          await jobs.reschedule(job.jobId, 'waiting for container root to publish', 60);
          return 'failed';
        }
      }
      // ★ THE LAST POSSIBLE MOMENT. Everything above — the existence check, opening a
      // container root, the pacing wait — is time in which a delete or a takedown can
      // land, and neither can stop a job that is already claimed (`cancelPending` only
      // reaches 'pending'). Checked here, the window is closed for good.
      //
      // An `update` queued before a takedown and rescheduled past it would
      // otherwise REPUBLISH the removed content — Hive's comment op is an
      // upsert, so the deleted object simply comes back, invisible in Lumen
      // because the row stays hidden, and no operator ever learns of it.
      //
      // The `jobType !== 'delete'` guard that used to wrap this is gone: `delete`
      // now returns above, and TypeScript proves it — narrowing this to
      // `'create' | 'update'` is what flagged the old comparison as dead.
      const live = await posts.getPostById(job.postId);
      if (!live) {
        await jobs.markTerminal(job.jobId, 'the post no longer exists', 'rejected');
        return 'failed';
      }
      // A deletion is not undoable here — `deleted_at` refuses every later edit — so
      // ending the job is the honest outcome.
      if (live.deletedLocally) {
        await jobs.markTerminal(job.jobId, 'deleted before publishing', 'rejected');
        return 'failed';
      }
      // ★★★ A HIDE IS PARKED, NOT KILLED (2026-08-10).
      //
      // This used to be `markTerminal(..., 'moderated before publishing', 'rejected')`
      // — a TERMINAL status for a REVERSIBLE condition, and the single largest cause
      // of content loss in this system. `listOrphaned` treats a terminal job as no
      // job, so the sweep re-enqueued the post on the very next drain and the worker
      // rejected it again a minute later; three generations were spent in three
      // minutes, after which the sweep could never see the post again. Restoring
      // visibility an hour later changed nothing, forever.
      //
      // Measured on the live queue: 38 posts × exactly 3 generations = 114 rejected
      // jobs, every one of those posts visible again today and none of them on Hive,
      // while `queueHealth` reported `pending: 0`.
      //
      // 'holding' is non-terminal, so the sweep leaves it alone (no generations
      // burned), `queueHealth` counts it, and `releaseHeldForPublishable` picks it up
      // the moment the post is visible again — without needing to know who hid it.
      if (live.feedVisibility !== 'visible') {
        await jobs.hold(job.jobId, `held: the post is ${live.feedVisibility}, not visible`);
        return 'failed';
      }

      await pauseForCommentInterval();
      // `delete` returned above and can never reach here.
      await broadcaster.broadcastComment(buildCommentOp(job));
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
