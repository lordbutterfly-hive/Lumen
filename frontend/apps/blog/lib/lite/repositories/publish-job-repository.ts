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
 * Atomically claim the oldest ready job. FOR UPDATE SKIP LOCKED lets multiple
 * workers/shards run without double-processing a row (spec §D.3).
 */
export async function claimNext(workerId: string): Promise<PublishJob | null> {
  const { rows } = await query<JobRow>(
    `UPDATE publish_job SET status = 'publishing', claimed_at = now(), claimed_by = $1,
       attempts = attempts + 1
     WHERE job_id = (
       SELECT job_id FROM publish_job
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`,
    [workerId]
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function markPublished(jobId: string): Promise<void> {
  await query(`UPDATE publish_job SET status = 'published', last_error = NULL WHERE job_id = $1`, [
    jobId
  ]);
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
