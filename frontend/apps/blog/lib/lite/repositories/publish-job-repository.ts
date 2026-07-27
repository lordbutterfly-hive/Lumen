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
export async function cancelPending(postId: string, reason: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE publish_job SET status = 'rejected', last_error = $2
      WHERE post_id = $1 AND status = 'pending'`,
    [postId, reason]
  );
  return rowCount ?? 0;
}
