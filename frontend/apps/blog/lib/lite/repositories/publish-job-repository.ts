import { query } from '../db/pool';
import { ulid } from '../ids';
import {
  PublishJob,
  PublishJobStatus,
  PublishJobType,
  PublishPayload
} from '../types';

interface JobRow {
  job_id: string;
  post_id: string;
  job_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  last_error: string | null;
  idempotency_key: string;
  payload_snapshot: PublishPayload;
  created_at: Date;
}

function mapJob(r: JobRow): PublishJob {
  return {
    jobId: r.job_id,
    postId: r.post_id,
    jobType: r.job_type as PublishJobType,
    status: r.status as PublishJobStatus,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    claimedAt: r.claimed_at,
    claimedBy: r.claimed_by,
    lastError: r.last_error,
    idempotencyKey: r.idempotency_key,
    payloadSnapshot: r.payload_snapshot,
    createdAt: r.created_at
  };
}

export interface EnqueueInput {
  postId: string;
  jobType: PublishJobType;
  idempotencyKey: string;
  payload: PublishPayload;
}

/** Idempotent enqueue: a duplicate idempotency_key is a no-op (returns null). */
export async function enqueue(input: EnqueueInput): Promise<PublishJob | null> {
  const { rows } = await query<JobRow>(
    `INSERT INTO publish_job (job_id, post_id, job_type, idempotency_key, payload_snapshot)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [ulid(), input.postId, input.jobType, input.idempotencyKey, JSON.stringify(input.payload)]
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

/**
 * ★ B7 (2026-08-06). How many publish jobs this post has ever had — the RETRY
 * GENERATION, used to mint a distinct idempotency key.
 *
 * `enqueue` is `ON CONFLICT (idempotency_key) DO NOTHING`, so re-queueing a
 * permanently-failed post under its original `<postId>:create` key is a silent
 * no-op. That is exactly why the old `listOrphaned` excluded any post with ANY
 * job row: without a fresh key the sweep would have looped forever achieving
 * nothing. Counting generations lets the retry actually insert, AND lets it be
 * bounded so a genuinely unpublishable post stops being retried instead of
 * being retried forever.
 */
/** How many posts are waiting to reach Hive — the number an operator needs when the drain reports itself paused. */
export async function countPending(): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM publish_job WHERE status = 'pending'`
  );
  return Number(rows[0]?.n ?? 0);
}

export async function countJobsForPost(postId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM publish_job WHERE post_id = $1`,
    [postId]
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Atomically claim the next job, FAIRLY.
 *
 * Ordering is by the author's `last_publish_at` (oldest first), not by job age, so
 * one user queueing 50 posts cannot delay everyone else — each user's turn comes
 * round before that user's second item. This needs PERSISTED state: a recomputed
 * ROW_NUMBER() rank cannot do it (`FOR UPDATE` is illegal with a window function;
 * the CTE workaround locks the whole pending queue and serialises every worker; and
 * a rank recomputed per claim just lets the heavy user win again immediately —
 * all three verified against a real Postgres by the 2026-07-28 review).
 *
 * `FOR UPDATE OF j` locks only the job row, so workers still run concurrently.
 *
 * The NOT EXISTS clause serialises per POST: never two in-flight jobs for the same
 * post. Without it an `update` can overtake its own `create`, and because Hive's
 * comment op is an upsert (the evaluator branches purely on "does this permlink
 * exist"), the late create would be applied as an EDIT — silently reverting the
 * user's newer text with no error anywhere.
 */
export async function claimNext(workerId: string): Promise<PublishJob | null> {
  const { rows } = await query<JobRow>(
    `UPDATE publish_job SET status = 'publishing', claimed_at = now(), claimed_by = $1,
       attempts = attempts + 1
     WHERE job_id = (
       SELECT j.job_id
         FROM publish_job j
         JOIN lumen_post p ON p.post_id = j.post_id
         JOIN lumen_user u ON u.user_id = p.user_id
        WHERE j.status = 'pending'
          AND j.next_attempt_at <= now()
          AND NOT EXISTS (
                SELECT 1 FROM publish_job x
                 WHERE x.post_id = j.post_id AND x.status = 'publishing'
              )
        ORDER BY COALESCE(u.last_publish_at, 'epoch'::timestamptz) ASC, j.next_attempt_at ASC
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`,
    [workerId]
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

/**
 * Mark published and stamp the author's fair-queue marker in one go, so the next
 * claim prefers somebody else.
 */
export async function markPublished(jobId: string): Promise<void> {
  await query(
    `WITH done AS (
       UPDATE publish_job SET status = 'published', last_error = NULL
        WHERE job_id = $1
       RETURNING post_id
     )
     UPDATE lumen_user u
        SET last_publish_at = now()
       FROM done JOIN lumen_post p ON p.post_id = done.post_id
      WHERE u.user_id = p.user_id`,
    [jobId]
  );
}

/**
 * Return jobs stranded in 'publishing' by a worker that died mid-flight.
 *
 * Without this they sit forever: nothing retries them, and the post never appears.
 * Worse, it is the window in which an edit can overtake a create (see claimNext) —
 * so this is data-loss prevention, not tidiness. `attempts` was already incremented
 * at claim time, so a reaped job keeps its retry budget honest.
 *
 * The postExists guard in the worker makes a re-run safe even if the original
 * broadcast actually landed.
 */
export async function reapStuck(olderThanSeconds: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job
        SET status = 'pending',
            last_error = COALESCE(last_error, '') || ' [reaped: worker vanished while publishing]',
            next_attempt_at = now()
      WHERE status = 'publishing'
        AND claimed_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds]
  );
  return rowCount ?? 0;
}

/** Retriable failure: back the job off to pending for a later attempt. */
export async function reschedule(jobId: string, error: string, backoffSeconds: number): Promise<void> {
  await query(
    `UPDATE publish_job
       SET status = 'pending', last_error = $2,
           next_attempt_at = now() + make_interval(secs => $3)
     WHERE job_id = $1`,
    [jobId, error.slice(0, 2000), backoffSeconds]
  );
}

/** Terminal failure ('failed' = retries exhausted, 'rejected' = validation/moderation). */
export async function markTerminal(
  jobId: string,
  error: string,
  status: 'failed' | 'rejected'
): Promise<void> {
  await query(`UPDATE publish_job SET status = $2, last_error = $3 WHERE job_id = $1`, [
    jobId,
    status,
    error.slice(0, 2000)
  ]);
}

/**
 * Refresh the content of a not-yet-broadcast create job (edit-before-publish).
 * Only touches a job still 'pending' (never one mid-flight, per §D.3). Returns
 * true if a pending create job was updated.
 */
export async function updatePendingPayload(postId: string, payload: PublishPayload): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE publish_job SET payload_snapshot = $2
     WHERE post_id = $1 AND job_type = 'create' AND status = 'pending'`,
    [postId, JSON.stringify(payload)]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Collapse a burst of edits: replace the payload of the pending `update` job for
 * this post if one exists, so the newest text wins and the queue does not grow one
 * job per save.
 *
 * Without this, two edits become two jobs; if the first backs off and the second
 * succeeds, the OLDER edit lands last and silently reverts the newer text.
 * Only touches 'pending' rows — never one already mid-flight.
 */
export async function replacePendingUpdate(
  postId: string,
  payload: PublishPayload
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE publish_job SET payload_snapshot = $2, next_attempt_at = now()
      WHERE post_id = $1 AND job_type = 'update' AND status = 'pending'`,
    [postId, JSON.stringify(payload)]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Drop any not-yet-broadcast job for a post — used when a post is deleted before it
 * ever reached Hive. Deliberately does NOT touch a job already 'publishing': that
 * one may be mid-broadcast, and the delete job queued afterwards will clean up.
 */
/**
 * Is there still a create job that could publish this post? Used to stop an edit or a
 * delete waiting forever on a create that was cancelled, moderated away, or has already
 * exhausted its attempts — a wait that otherwise bypasses the attempt ceiling entirely.
 */
export async function hasLiveCreateJob(postId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM publish_job
      WHERE post_id = $1 AND job_type = 'create' AND status IN ('pending', 'publishing', 'holding')
      LIMIT 1`,
    [postId]
  );
  return rows.length > 0;
}

/**
 * Cancel queued EDITS for a post that is being removed.
 *
 * `cancelPending` covers a post that never reached Hive. This covers the other case: a
 * published post with an update still queued. Jobs are claimed in `next_attempt_at`
 * order, so an update rescheduled after a transient failure can be broadcast AFTER the
 * delete — and because Hive's comment operation is an upsert, that recreates the object
 * the user or a moderator just removed.
 */
export async function cancelPendingUpdates(postId: string, reason: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job SET status = 'rejected', last_error = $2
      WHERE post_id = $1 AND job_type = 'update' AND status IN ('pending', 'holding')`,
    [postId, reason]
  );
  return rowCount ?? 0;
}

export async function cancelPending(postId: string, reason: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job SET status = 'rejected', last_error = $2
      WHERE post_id = $1 AND status = 'pending'`,
    [postId, reason]
  );
  return rowCount ?? 0;
}

/**
 * Park every not-yet-broadcast job belonging to one user (suspension/ban).
 *
 * 'holding' rather than 'rejected' because suspension has to be undoable: cancelled
 * jobs would need re-deriving payloads to restore, and a reinstated user would
 * silently lose whatever was queued. 'holding' was a legal status from migration
 * 0003 that nothing ever wrote — this is its writer.
 *
 * A job already 'publishing' is left alone: it may be mid-broadcast, and stealing it
 * would only produce a job the worker no longer owns.
 *
 * ★★★ A `delete` JOB IS NEVER PARKED (2026-08-10).
 *
 * THE BUG THIS FIXES, proven end to end: a moderator takes a post down (a `delete`
 * job is queued, the tool reports `takedownQueued: true`) and then does the obvious
 * next thing — bans the author. This statement had no `job_type` filter, so it
 * flipped that freshly-queued takedown from 'pending' to 'holding'. `claimNext`
 * reads only 'pending', and the only thing that frees a held job is REINSTATING the
 * user. So the content stayed on the public chain permanently, the moderation log
 * said it had been removed, and the one action that would finally delete it was
 * un-banning the person who posted it.
 *
 * Holding a `create` is the whole point of suspension — don't publish a suspended
 * account's new material. A `delete` is the opposite operation: it REMOVES content.
 * There is no state of an account in which "we owe the world a removal" should be
 * paused, least of all a ban.
 */
export async function holdPendingForUser(userId: string, reason: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job j SET status = 'holding', last_error = $2
       FROM lumen_post p
      WHERE p.post_id = j.post_id AND p.user_id = $1 AND j.status = 'pending'
        AND j.job_type <> 'delete'`,
    [userId, reason]
  );
  return rowCount ?? 0;
}

/** Undo {@link holdPendingForUser}: parked jobs become due again immediately. */
export async function releaseHeldForUser(userId: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job j SET status = 'pending', last_error = NULL, next_attempt_at = now()
       FROM lumen_post p
      WHERE p.post_id = j.post_id AND p.user_id = $1 AND j.status = 'holding'`,
    [userId]
  );
  return rowCount ?? 0;
}

/**
 * Park ONE job without spending its retry budget or ending its life.
 *
 * ★★★ WHY A HIDDEN POST MUST NOT BE 'rejected' (2026-08-10).
 *
 * The worker used to call `markTerminal(..., 'rejected')` the moment it found a post
 * that was not visible — "moderated before publishing". That is a TERMINAL status,
 * and nothing in the system revives one. Worse, `listOrphaned` treats a terminal job
 * as "no job", so the orphan sweep re-enqueued the same post on the very next drain,
 * the worker rejected it again a minute later, and three generations were spent in
 * three minutes against a condition retrying could never fix. Past the ceiling the
 * sweep stops seeing the post FOREVER — so a visibility change that lasted an hour
 * cost the post its entire publish life.
 *
 * Measured on the live queue: 38 posts × exactly 3 generations = 114 jobs, all
 * `rejected` as "moderated before publishing", every one of those posts visible
 * again now and none of them ever reaching Hive.
 *
 * 'holding' is the status this situation already had a name for: parked, undoable,
 * non-terminal — so the orphan sweep leaves it alone instead of burning generations,
 * and `queueHealth` counts it.
 */
export async function hold(jobId: string, reason: string): Promise<void> {
  await query(`UPDATE publish_job SET status = 'holding', last_error = $2 WHERE job_id = $1`, [
    jobId,
    reason.slice(0, 2000)
  ]);
}

/** Release the parked jobs of ONE post (a moderator restoring it). */
export async function releaseHeldForPost(postId: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job SET status = 'pending', last_error = NULL, next_attempt_at = now()
      WHERE post_id = $1 AND status = 'holding'`,
    [postId]
  );
  return rowCount ?? 0;
}

/**
 * Release every parked job whose reason to be parked has gone away.
 *
 * ★ RECONCILIATION, NOT A CALLBACK. The reason the live queue stranded ~a third of
 * its content is that the release depended on the code path that caused the hold
 * calling back — and the 38 stranded posts were hidden by something that never did.
 * Whatever hid them, the state is what it is now: the post is visible, undeleted,
 * and its author is in good standing. That is a publishable post, and this sweep
 * says so without needing to know who hid it.
 *
 * The author's status is part of the predicate on purpose: `holdPendingForUser`
 * writes the SAME 'holding' status for a suspension, and un-holding a suspended
 * account's queue would quietly undo the suspension.
 */
export async function releaseHeldForPublishable(limit: number): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job j SET status = 'pending', last_error = NULL, next_attempt_at = now()
      WHERE j.job_id IN (
        SELECT j2.job_id
          FROM publish_job j2
          JOIN lumen_post p ON p.post_id = j2.post_id
          JOIN lumen_user u ON u.user_id = p.user_id
         WHERE j2.status = 'holding'
           AND p.deleted_locally = false
           AND p.feed_visibility = 'visible'
           AND u.status = 'active'
         LIMIT $1
      )`,
    [limit]
  );
  return rowCount ?? 0;
}

/**
 * A single scan answering "is the outbox actually moving?".
 *
 * Nothing schedules the drain by default, so the failure mode this exists for is
 * silence: posts accumulate in Postgres, no exception is raised anywhere, and the
 * author sees a post that simply never appears on Hive. Counts alone do not show
 * that — a queue with 5 pending jobs looks identical whether it is draining every
 * minute or has been dead for a week. The ages are the signal.
 *
 * `lastPublishedAt` is derived from `claimed_at`, which is stamped moments before the
 * broadcast rather than after it. It is a liveness heartbeat, not a precise publish
 * time; nothing here should be used to answer "when exactly did this post go out".
 */
export interface QueueHealth {
  pending: number;
  holding: number;
  publishing: number;
  published: number;
  failed: number;
  rejected: number;
  /** Age of the longest-waiting pending job. null when nothing is pending. */
  oldestPendingAgeSeconds: number | null;
  /** Heartbeat: how long since a job was last picked up and published. */
  secondsSinceLastPublish: number | null;
  /** Jobs a dead worker left mid-flight; reapStuck() recovers these. */
  stuckPublishing: number;
  /**
   * ★★★ THE NUMBER THIS INTERFACE WAS MISSING (2026-08-10).
   *
   * Posts being SERVED to readers that are not on Hive and have nothing working on
   * them: no pending job, no held job, nothing in flight. Every count above is a
   * count of JOBS, and a job that died is not a job — so a queue with a third of its
   * content permanently stranded reported `pending: 0, oldestPendingAge: null`,
   * which is indistinguishable from "all caught up". It read GREEN for two days
   * while 38 posts sat off-chain.
   *
   * A queue's health is not the state of its rows, it is whether the work got done.
   */
  strandedPosts: number;
  /**
   * Terminally-failed EDITS and TAKEDOWNS on posts that ARE on chain.
   *
   * `listPermanentlyFailed` only looks at posts with `hive_permlink IS NULL`, so a
   * takedown that Hive refused — content a moderator believes is gone, still public
   * — was invisible to every surface. This is that surface.
   */
  failedOperations: number;
}

export async function queueHealth(stuckAfterSeconds = 300): Promise<QueueHealth> {
  const { rows } = await query<{
    pending: string;
    holding: string;
    publishing: string;
    published: string;
    failed: string;
    rejected: string;
    oldest_pending_age: string | null;
    seconds_since_last_publish: string | null;
    stuck_publishing: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')                              AS pending,
       count(*) FILTER (WHERE status = 'holding')                              AS holding,
       count(*) FILTER (WHERE status = 'publishing')                           AS publishing,
       count(*) FILTER (WHERE status = 'published')                            AS published,
       count(*) FILTER (WHERE status = 'failed')                               AS failed,
       count(*) FILTER (WHERE status = 'rejected')                             AS rejected,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'pending'))
                                                                               AS oldest_pending_age,
       extract(epoch FROM now() - max(claimed_at) FILTER (WHERE status = 'published'))
                                                                               AS seconds_since_last_publish,
       count(*) FILTER (WHERE status = 'publishing'
                          AND claimed_at < now() - make_interval(secs => $1))  AS stuck_publishing
     FROM publish_job`,
    [stuckAfterSeconds]
  );
  // Deliberately a SECOND query over `lumen_post`: the counts above answer "what is
  // in the queue", and the queue is exactly the thing that cannot see content it has
  // already given up on. These two answer "did the work actually happen".
  const outcome = await query<{ stranded: string; failed_ops: string }>(
    `SELECT
       (SELECT count(*) FROM lumen_post p
         WHERE p.deleted_locally = false
           AND p.feed_visibility = 'visible'
           AND p.hive_permlink IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM publish_job j
                  WHERE j.post_id = p.post_id
                    AND j.status IN ('pending','holding','publishing')
               ))::text AS stranded,
       (SELECT count(*) FROM publish_job j
          JOIN lumen_post p ON p.post_id = j.post_id
         WHERE j.job_type IN ('update','delete')
           AND j.status IN ('failed','rejected')
           AND p.hive_permlink IS NOT NULL)::text AS failed_ops`
  );
  const r = rows[0];
  const num = (v: string | null | undefined) => Number(v ?? 0);
  const age = (v: string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    pending: num(r?.pending),
    holding: num(r?.holding),
    publishing: num(r?.publishing),
    published: num(r?.published),
    failed: num(r?.failed),
    rejected: num(r?.rejected),
    oldestPendingAgeSeconds: age(r?.oldest_pending_age),
    secondsSinceLastPublish: age(r?.seconds_since_last_publish),
    stuckPublishing: num(r?.stuck_publishing),
    strandedPosts: num(outcome.rows[0]?.stranded),
    failedOperations: num(outcome.rows[0]?.failed_ops)
  };
}
